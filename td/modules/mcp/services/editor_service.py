"""Bounded, action-aware Network Editor follow jobs.

The service is UI-only: it never mutates project topology and never relies on
``/api/exec``.  ``focus()`` remains as the synchronous compatibility adapter for
the legacy controller while ``start_follow`` / ``get_follow_status`` /
``cancel_follow`` expose the bounded job contract used by the integrated route.
"""

import hashlib
import json
import os
import re
import secrets
import time

import td

op = getattr(td, "op", lambda _path: None)  # TD globals are absent in offline imports.

MAX_PATHS = 64
MAX_PATH_LENGTH = 1024
MAX_JOBS = 32
PENDING_TTL_SECONDS = 2.0
TERMINAL_RETENTION_SECONDS = 5.0

_ACTIONS = {"create", "edit", "inspect", "view", "layout", "delete"}
_FRAMING = {"auto", "selection", "owner", "none"}
_TERMINAL = {"applied", "suppressed", "cancelled", "failed", "expired"}
_REQUEST_ID = re.compile(r"^[A-Za-z0-9_-]{16,80}$")
_FALSE_VALUES = {"0", "false", "no", "off"}

_JOBS = {}
_REQUEST_INDEX = {}
_PANE_GENERATION = {}


def _now():
    return time.monotonic()


def _get_ui():
    """Return TouchDesigner's UI object, or None in a headless test/runtime."""
    return getattr(td, "ui", None)


def _path(value):
    try:
        value = value.path
    except Exception:  # noqa: BLE001
        return None
    return str(value) if value else None


def _parent(node):
    try:
        parent = node.parent
        return parent() if callable(parent) else parent
    except Exception:  # noqa: BLE001
        return None


def _pane_type(pane):
    try:
        return str(pane.type).replace("PaneType.", "")
    except Exception:  # noqa: BLE001
        return None


def _is_network_editor(pane):
    pane_type = _pane_type(pane)
    normalized = (pane_type or "").upper().replace("_", "")
    if normalized == "NETWORKEDITOR":
        return True
    # Compatibility with older builds and focused tests that only expose the
    # NetworkEditor method surface.
    return callable(getattr(pane, "homeSelected", None))


def _explicit_pane(panes_obj, attr):
    try:
        return getattr(panes_obj, attr)
    except Exception:  # noqa: BLE001
        return None


def _pane_with_key(panes, key):
    return next((pane for pane in panes if _pane_key(pane) == key), None)


def _active_pane(panes_obj, panes):
    for attr in ("current", "currentPane"):
        candidate = _explicit_pane(panes_obj, attr)
        if candidate is not None:
            pane = _pane_with_key(panes, _pane_key(candidate))
            if pane is not None:
                return pane
    return None


def _perform_mode(ui):
    for source in (ui, getattr(td, "project", None)):
        if source is None:
            continue
        try:
            value = getattr(source, "performMode")
        except Exception:  # noqa: BLE001
            continue
        if isinstance(value, bool):
            return value
    return False


def _follow_enabled():
    value = os.getenv("TDMCP_EDITOR_FOLLOW_ENABLED", "1").strip().lower()
    return value not in _FALSE_VALUES


def _normalize_path(raw):
    if not isinstance(raw, str):
        raise ValueError("each path must be a string")
    path = raw.strip()
    if not path.startswith("/"):
        raise ValueError("each path must be absolute")
    if len(path) > MAX_PATH_LENGTH:
        raise ValueError("operator path exceeds %d characters" % MAX_PATH_LENGTH)
    return path


def _normalize_paths(paths):
    if not isinstance(paths, (list, tuple)) or isinstance(paths, (str, bytes)):
        raise ValueError("paths must be an array of absolute operator paths")
    if not 1 <= len(paths) <= MAX_PATHS:
        raise ValueError("paths must contain between 1 and %d entries" % MAX_PATHS)
    out = []
    seen = set()
    for raw in paths:
        path = _normalize_path(raw)
        if path not in seen:
            out.append(path)
            seen.add(path)
    if not out:
        raise ValueError("paths must contain at least one distinct path")
    return out


def _validate_options(action, framing, request_id):
    if action not in _ACTIONS:
        raise ValueError("unsupported follow action: %s" % action)
    if framing not in _FRAMING:
        raise ValueError("unsupported framing mode: %s" % framing)
    if request_id is not None and not _REQUEST_ID.fullmatch(str(request_id)):
        raise ValueError("request_id must be 16-80 URL-safe characters")


def _fingerprint(paths, animate, action, framing, enabled):
    encoded = json.dumps(
        [paths, bool(animate), action, framing, bool(enabled)],
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _viewport(pane):
    result = {}
    for attr in ("x", "y", "zoom"):
        try:
            value = getattr(pane, attr)
        except Exception:  # noqa: BLE001
            continue
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            result[attr] = value
    return result or None


def _selected_paths(owner):
    if owner is None:
        return []
    try:
        selected = list(owner.selectedChildren or [])[:MAX_PATHS]
    except Exception:  # noqa: BLE001
        return []
    return [path for path in (_path(node) for node in selected) if path]


def _snapshot(pane):
    try:
        owner = pane.owner
    except Exception:  # noqa: BLE001
        owner = None
    try:
        current = _path(owner.currentChild) if owner is not None else None
    except Exception:  # noqa: BLE001
        current = None
    return {
        "owner": _path(owner),
        "current": current,
        "selected": _selected_paths(owner),
        "viewport": _viewport(pane),
    }


def _pane_name(pane):
    try:
        value = pane.name
    except Exception:  # noqa: BLE001
        return None
    return str(value) if value is not None else None


def _pane_key(pane):
    """Stable pane identity across TD proxy-wrapper re-materialization."""
    name = _pane_name(pane)
    pane_type = _pane_type(pane)
    if name is not None:
        return (pane_type or "UNKNOWN", name)
    return (pane_type or "UNKNOWN", "identity:%s" % id(pane))


def _select_pane(ui, parent_path):
    panes_obj = getattr(ui, "panes", None)
    if panes_obj is None:
        return None, None
    try:
        panes = [pane for pane in list(panes_obj) if _is_network_editor(pane)]
    except Exception:  # noqa: BLE001
        panes = []
    if not panes:
        return None, None

    active = _active_pane(panes_obj, panes)
    if active is not None and _path(getattr(active, "owner", None)) == parent_path:
        return active, "owner_active"
    for pane in panes:
        if _path(getattr(pane, "owner", None)) == parent_path:
            return pane, "owner_existing"
    if active is not None:
        return active, "active"
    return panes[0], "first_compatible"


def _resolve(paths):
    resolved = []
    missing = []
    for path in paths:
        node = op(path)
        if node is None:
            missing.append(path)
        else:
            resolved.append(node)
    return resolved, missing


def _common_parent(nodes):
    parents = [_parent(node) for node in nodes]
    if any(parent is None for parent in parents):
        return None, False
    paths = [_path(parent) for parent in parents]
    first = paths[0] if paths else None
    same = first is not None and all(path == first for path in paths)
    return parents[0] if same else None, same


def _new_job(operation_id, fingerprint, paths, animate, action, framing):
    now = _now()
    return {
        "operation_id": operation_id,
        "status": "scheduled",
        "action": action,
        "animate": bool(animate),
        "requested_paths": list(paths),
        "resolved_paths": [],
        "missing_paths": [],
        "focused": [],
        "pane": None,
        "pane_strategy": None,
        "framing": {"requested": framing, "applied": None, "animation": None},
        "previous": None,
        "final": None,
        "suppression_reason": None,
        "highlight": {
            "status": "held",
            "token": None,
            "reason": "compare_and_swap_live_unverified",
        },
        "warnings": [],
        "undo_label": None,
        "_fingerprint": fingerprint,
        "_created_at": now,
        "_expires_at": now + PENDING_TTL_SECONDS,
        "_finished_at": None,
        "_pane": None,
        "_pane_key": None,
        "_generation": None,
        "_parent_path": None,
        "_animation": None,
        "_deferred": False,
    }


def _public(job):
    return {key: value for key, value in job.items() if not key.startswith("_")}


def _finish(job, status, reason=None, warning=None):
    if job["status"] in _TERMINAL:
        return False
    job["status"] = status
    job["suppression_reason"] = reason
    job["_finished_at"] = _now()
    if warning:
        job["warnings"].append(warning)
    return True


def _remove_job(operation_id):
    job = _JOBS.pop(operation_id, None)
    if job is not None and _REQUEST_INDEX.get(operation_id) == operation_id:
        _REQUEST_INDEX.pop(operation_id, None)


def _prune():
    now = _now()
    for operation_id, job in list(_JOBS.items()):
        if job["status"] == "scheduled" and now >= job["_expires_at"]:
            _finish(job, "expired", warning="Follow job expired before it could apply.")
        finished_at = job.get("_finished_at")
        if finished_at is not None and now - finished_at >= TERMINAL_RETENTION_SECONDS:
            _remove_job(operation_id)


def _store(job):
    _JOBS[job["operation_id"]] = job
    _REQUEST_INDEX[job["operation_id"]] = job["operation_id"]


def _capacity_receipt(paths, animate, action, framing):
    job = _new_job(secrets.token_urlsafe(18), "", paths, animate, action, framing)
    _finish(job, "failed", warning="Concurrent Network Editor follow limit reached.")
    return _public(job)


def _try_set(target, name, value):
    try:
        setattr(target, name, value)
    except Exception:  # noqa: BLE001
        pass


def _snapshot_node(snapshot, key):
    path = snapshot.get(key)
    return op(path) if path else None


def _clear_selection(owner):
    try:
        selected = list(owner.selectedChildren or [])
    except Exception:  # noqa: BLE001
        selected = []
    for node in selected:
        _try_set(node, "selected", False)


def _restore_selected(owner, paths):
    for path in paths:
        node = op(path)
        if node is not None and _parent(node) is owner:
            _try_set(node, "selected", True)


def _restore_owner_selection(pane, snapshot):
    owner = _snapshot_node(snapshot, "owner")
    if owner is None:
        return
    _try_set(pane, "owner", owner)
    _clear_selection(owner)
    _restore_selected(owner, snapshot.get("selected") or [])
    current = _snapshot_node(snapshot, "current")
    if current is not None:
        _try_set(current, "current", True)


def _restore_snapshot(pane, snapshot):
    if pane is None or snapshot is None:
        return
    _restore_owner_selection(pane, snapshot)
    for key, value in (snapshot.get("viewport") or {}).items():
        _try_set(pane, key, value)


def _set_exact_selection(parent, nodes):
    try:
        previous = list(parent.selectedChildren or [])
    except Exception:  # noqa: BLE001
        previous = []
    for node in previous:
        node.selected = False
    for node in nodes:
        node.selected = True

    primary = nodes[0]
    current_written = False
    try:
        primary.current = True
        current_written = True
    except Exception:  # noqa: BLE001
        pass
    try:
        if _path(parent.currentChild) != _path(primary):
            parent.currentChild = primary
        current_written = _path(parent.currentChild) == _path(primary)
    except Exception:  # noqa: BLE001
        pass
    if not current_written:
        raise RuntimeError(
            "TouchDesigner did not accept the requested current operator"
        )


def _auto_frame_selection(pane):
    before = _viewport(pane) or {}
    pane.homeSelected(zoom=True)
    fitted = _viewport(pane) or {}
    old_zoom = before.get("zoom")
    fitted_zoom = fitted.get("zoom")
    if old_zoom is None or fitted_zoom is None or fitted_zoom < old_zoom:
        return
    try:
        pane.zoom = old_zoom
        pane.homeSelected(zoom=False)
    except Exception:  # noqa: BLE001
        pass


def _apply_framing(pane, mode):
    if mode == "none":
        return "none", _viewport(pane)
    if mode == "owner":
        pane.home(zoom=True)
        return "owner", _viewport(pane)
    if mode == "selection":
        pane.homeSelected(zoom=True)
    else:
        _auto_frame_selection(pane)
    return "selection", _viewport(pane)


def _write_viewport(pane, viewport):
    for key in ("x", "y", "zoom"):
        if key not in viewport:
            return False
    for key in ("x", "y", "zoom"):
        setattr(pane, key, viewport[key])
    return True


def _complete_job(job, pane):
    job["final"] = _snapshot(pane)
    if not _validate_final(job, job["_parent_path"]):
        raise RuntimeError("final Network Editor readback did not match the request")
    job["focused"] = list(job["resolved_paths"])
    _finish(job, "applied")


def _schedule_callback(callback, job, warning):
    runner = getattr(td, "run", None)
    if not callable(runner):
        _finish(job, "failed", warning="TouchDesigner frame scheduling is unavailable.")
        return False
    try:
        runner("args[0]()", callback, delayFrames=1)
        return True
    except Exception:  # noqa: BLE001
        _finish(job, "failed", warning=warning)
        return False


def _current_animation_job(operation_id):
    _prune()
    job = _JOBS.get(operation_id)
    if job is None or job["status"] != "scheduled" or job["_animation"] is None:
        return None
    if _PANE_GENERATION.get(job["_pane_key"]) != job["_generation"]:
        _finish(job, "cancelled", "superseded")
        return None
    return job


def _animation_pane(job):
    ui = _get_ui()
    pane = _available_pane(ui, job["_pane_key"]) if ui is not None else None
    if pane is None or _perform_mode(ui):
        _finish(job, "cancelled", "ui_unavailable")
        return None
    return pane


def _next_animation_viewport(animation):
    animation["step"] += 1
    progress = animation["step"] / animation["steps"]
    eased = 1.0 - (1.0 - progress) ** 3
    return {
        key: animation["start"][key]
        + (animation["target"][key] - animation["start"][key]) * eased
        for key in ("x", "y", "zoom")
    }


def _schedule_animation_step(operation_id, job, pane):
    scheduled = _schedule_callback(
        lambda operation_id=operation_id: _animation_step(operation_id),
        job,
        "TouchDesigner rejected a viewport animation frame.",
    )
    if not scheduled:
        _restore_snapshot(pane, job["previous"])


def _animation_step(operation_id):
    job = _current_animation_job(operation_id)
    if job is None:
        return
    pane = _animation_pane(job)
    if pane is None:
        return
    animation = job["_animation"]
    try:
        _write_viewport(pane, _next_animation_viewport(animation))
        if animation["step"] >= animation["steps"]:
            job["_animation"] = None
            _complete_job(job, pane)
            return
    except Exception:  # noqa: BLE001
        _restore_snapshot(pane, job["previous"])
        _finish(
            job,
            "failed",
            warning="Stepped viewport animation failed; previous UI state was restored.",
        )
        return
    _schedule_animation_step(operation_id, job, pane)


def _available_pane(ui, pane_key):
    try:
        for candidate in list(ui.panes):
            if _is_network_editor(candidate) and _pane_key(candidate) == pane_key:
                return candidate
    except Exception:  # noqa: BLE001
        pass
    return None


def _validate_final(job, parent_path):
    final = job["final"] or {}
    selected = final.get("selected") or []
    requested = job["resolved_paths"]
    return (
        final.get("owner") == parent_path
        and final.get("current") == requested[0]
        and len(selected) == len(requested)
        and set(selected) == set(requested)
    )


def _pending_job(operation_id):
    _prune()
    job = _JOBS.get(operation_id)
    if job is None or job["status"] != "scheduled":
        return None
    if _now() >= job["_expires_at"]:
        _finish(job, "expired", warning="Follow job expired before callback execution.")
        return None
    if _PANE_GENERATION.get(job["_pane_key"]) != job["_generation"]:
        _finish(job, "cancelled", "superseded")
        return None
    return job


def _job_runtime_pane(job):
    ui = _get_ui()
    pane = _available_pane(ui, job["_pane_key"]) if ui is not None else None
    if ui is None or _perform_mode(ui) or pane is None:
        _finish(job, "cancelled", "ui_unavailable")
        return None
    return pane


def _job_target(job):
    nodes, missing = _resolve(job["requested_paths"])
    parent, same_parent = _common_parent(nodes)
    if missing or not same_parent or _path(parent) != job["_parent_path"]:
        reason = "target_not_found" if missing else "different_parents"
        _finish(job, "cancelled", reason)
        return None, None
    return nodes, parent


def _can_step_animation(job, applied, start_viewport, target_viewport):
    return (
        job["animate"]
        and job["_deferred"]
        and applied != "none"
        and start_viewport is not None
        and target_viewport is not None
    )


def _start_stepped_animation(operation_id, job, pane, start_viewport, target_viewport):
    if not _write_viewport(pane, start_viewport):
        return False
    job["framing"]["animation"] = "stepped"
    job["_animation"] = {
        "start": start_viewport,
        "target": target_viewport,
        "step": 0,
        "steps": 6,
    }
    scheduled = _schedule_callback(
        lambda operation_id=operation_id: _animation_step(operation_id),
        job,
        "TouchDesigner rejected the first viewport animation frame.",
    )
    if not scheduled:
        raise RuntimeError("could not schedule viewport animation")
    return True


def _mutate_follow_job(operation_id, job, pane, nodes, parent):
    pane.owner = parent
    _set_exact_selection(parent, nodes)
    start_viewport = _viewport(pane)
    applied, target_viewport = _apply_framing(pane, job["framing"]["requested"])
    job["framing"]["applied"] = applied
    if _can_step_animation(
        job, applied, start_viewport, target_viewport
    ) and _start_stepped_animation(
        operation_id, job, pane, start_viewport, target_viewport
    ):
        return
    job["framing"]["animation"] = "none" if applied == "none" else "instant"
    _complete_job(job, pane)


def _failed_follow_job(job, pane):
    _restore_snapshot(pane, job["previous"])
    job["final"] = _snapshot(pane)
    _finish(
        job,
        "failed",
        warning="Network Editor follow failed and previous UI state was restored.",
    )


def _apply_job(operation_id):
    job = _pending_job(operation_id)
    if job is None:
        existing = _JOBS.get(operation_id)
        return _public(existing) if existing is not None else None
    pane = _job_runtime_pane(job)
    if pane is None:
        return _public(job)
    nodes, parent = _job_target(job)
    if nodes is None:
        return _public(job)

    job["_pane"] = pane
    try:
        _mutate_follow_job(operation_id, job, pane, nodes, parent)
    except Exception:  # noqa: BLE001
        _failed_follow_job(job, pane)

    return _public(job)


def _schedule(operation_id):
    job = _JOBS[operation_id]
    _schedule_callback(
        lambda operation_id=operation_id: _apply_job(operation_id),
        job,
        "TouchDesigner rejected the bounded follow callback.",
    )


def _cancel_older_for_pane(pane_key, current_id):
    for operation_id, job in _JOBS.items():
        if operation_id == current_id:
            continue
        if job["status"] == "scheduled" and job.get("_pane_key") == pane_key:
            _finish(job, "cancelled", "superseded")


def _runtime_for_follow(job, enabled):
    if not enabled or not _follow_enabled():
        _finish(job, "suppressed", "follow_disabled")
        return None
    ui = _get_ui()
    if ui is None:
        _finish(job, "suppressed", "ui_unavailable")
        return None
    if _perform_mode(ui):
        _finish(job, "suppressed", "perform_mode")
        return None
    return ui


def _target_parent_for_follow(job, normalized):
    nodes, missing = _resolve(normalized)
    job["resolved_paths"] = [_path(node) for node in nodes if _path(node)]
    job["missing_paths"] = missing
    if missing:
        _finish(job, "suppressed", "target_not_found")
        return None
    parent, same_parent = _common_parent(nodes)
    if not same_parent:
        _finish(job, "suppressed", "different_parents")
        return None
    return parent


def _configure_follow_pane(job, ui, parent, operation_id):
    parent_path = _path(parent)
    pane, strategy = _select_pane(ui, parent_path)
    if pane is None:
        _finish(job, "suppressed", "no_network_editor")
        return False
    job["pane"] = _pane_name(pane)
    job["pane_strategy"] = strategy
    job["previous"] = _snapshot(pane)
    job["_pane"] = pane
    job["_parent_path"] = parent_path
    pane_key = _pane_key(pane)
    generation = _PANE_GENERATION.get(pane_key, 0) + 1
    _PANE_GENERATION[pane_key] = generation
    job["_pane_key"] = pane_key
    job["_generation"] = generation
    _cancel_older_for_pane(pane_key, operation_id)
    return True


def _replayed_follow(request_id, fingerprint):
    if request_id is None or request_id not in _REQUEST_INDEX:
        return None
    existing = _JOBS.get(_REQUEST_INDEX[request_id])
    if existing is not None and existing["_fingerprint"] == fingerprint:
        return _public(existing)
    raise ValueError("request_id was already used for different follow input")


def _create_follow_job(
    operation_id, fingerprint, normalized, animate, action, framing, defer
):
    job = _new_job(operation_id, fingerprint, normalized, animate, action, framing)
    job["_deferred"] = bool(defer)
    _store(job)
    return job


def _prepare_follow_job(job, normalized, enabled, operation_id):
    ui = _runtime_for_follow(job, enabled)
    if ui is None:
        return False
    parent = _target_parent_for_follow(job, normalized)
    return parent is not None and _configure_follow_pane(job, ui, parent, operation_id)


def _dispatch_follow_job(job, operation_id, animate, defer):
    if bool(animate) and defer:
        job["framing"]["animation"] = "scheduled"
        _schedule(operation_id)
        return _public(job)
    return _apply_job(operation_id)


def start_follow(
    paths,
    animate=True,
    action="view",
    framing="auto",
    enabled=True,
    request_id=None,
    _defer=True,
):
    """Validate and start one bounded follow operation."""
    normalized = _normalize_paths(paths)
    action = str(action)
    framing = str(framing)
    request_id = str(request_id) if request_id is not None else None
    _validate_options(action, framing, request_id)
    fingerprint = _fingerprint(normalized, animate, action, framing, enabled)
    _prune()

    replayed = _replayed_follow(request_id, fingerprint)
    if replayed is not None:
        return replayed
    if len(_JOBS) >= MAX_JOBS:
        return _capacity_receipt(normalized, animate, action, framing)

    operation_id = request_id or secrets.token_urlsafe(18)
    job = _create_follow_job(
        operation_id, fingerprint, normalized, animate, action, framing, _defer
    )
    if not _prepare_follow_job(job, normalized, enabled, operation_id):
        return _public(job)
    return _dispatch_follow_job(job, operation_id, animate, _defer)


def get_follow_status(operation_id):
    """Return one bounded receipt, expiring stale pending work first."""
    _prune()
    job = _JOBS.get(str(operation_id))
    if job is None:
        raise KeyError("Unknown or expired follow operation")
    return _public(job)


def cancel_follow(operation_id):
    """Cancel a pending job exactly once; terminal receipts remain unchanged."""
    _prune()
    job = _JOBS.get(str(operation_id))
    if job is None:
        raise KeyError("Unknown or expired follow operation")
    if (
        job["status"] == "scheduled"
        and job.get("_animation") is not None
        and _PANE_GENERATION.get(job["_pane_key"]) == job["_generation"]
    ):
        _restore_snapshot(job.get("_pane"), job.get("previous"))
    _finish(job, "cancelled")
    return _public(job)


def focus(paths, animate=True):
    """Synchronous compatibility adapter for the original focus route.

    Legacy callers still receive ``focused``, ``pane`` and ``animate``. Missing
    targets/UI retain their historic exceptions until the controller is wired to
    ``start_follow`` and its typed suppression receipt.
    """
    normalized = _normalize_paths(paths)
    ui = _get_ui()
    if ui is None or _perform_mode(ui):
        raise RuntimeError("No Network Editor pane is available to focus")
    nodes, missing = _resolve(normalized)
    parent, same_parent = _common_parent(nodes)
    if missing or not same_parent:
        raise ValueError("No compatible operator group to focus")
    pane, _strategy = _select_pane(ui, _path(parent))
    if pane is None:
        raise RuntimeError("No Network Editor pane is available to focus")
    pane.owner = parent
    _set_exact_selection(parent, nodes)
    pane.homeSelected(zoom=True)
    return {
        "focused": [_path(node) for node in nodes if _path(node)],
        "pane": _pane_name(pane),
        "animate": bool(animate),
    }


def _reset_for_tests():
    """Clear bounded module state; intentionally private and test-only."""
    _JOBS.clear()
    _REQUEST_INDEX.clear()
    _PANE_GENERATION.clear()
