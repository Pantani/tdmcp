"""Bounded main-thread jobs for one temporary TouchDesigner artist workspace.

REST-facing functions validate and retain JSON only.  Every TouchDesigner OP or
Pane is acquired inside a scheduled callback and discarded before that callback
returns.  Restore is compare-and-swap and ``Pane.close()`` is verified on a
second frame because the 2025.32820 live probe proved close is deferred.
"""

import copy
import hashlib
import json
import math
import re
import secrets
import threading
import time
from collections import OrderedDict

try:
    import td
except ImportError:  # pragma: no cover - TouchDesigner supplies this module.
    td = None


MAX_PANES = 16
MAX_RECORDS = 8
APPLY_TTL_SECONDS = 2.0
MAX_SETTLE_READBACKS = 12
TERMINAL_RETENTION_SECONDS = 60.0
_PATH_MAX = 1024
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
_VIEWER_MODES = {"top_output": "TOPVIEWER", "panel_controls": "PANEL"}
_TERMINAL = {"restored", "cancelled", "expired", "suppressed", "conflicted", "failed"}
_NON_TERMINAL = {
    "scheduled",
    "active",
    "restore_scheduled",
    "cancel_scheduled",
    "cleanup_scheduled",
}


class WorkspaceError(ValueError):
    """Typed service error suitable for the bridge error envelope."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


_LOCK = threading.RLock()
_RECORDS = OrderedDict()
_IDEMPOTENCY = {}
_RUNTIME_OVERRIDE = None
_SCHEDULER_OVERRIDE = None
_CLOCK = time.monotonic


def _fail(code, message):
    raise WorkspaceError(code, message)


def _runtime():
    return _RUNTIME_OVERRIDE if _RUNTIME_OVERRIDE is not None else td


def _now():
    return float(_CLOCK())


def _json_hash(value):
    encoded = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _token(value, field="idempotency_key"):
    if not isinstance(value, str) or not _ID_RE.fullmatch(value):
        _fail("invalid_workspace_request", "%s must contain 16 to 128 safe characters" % field)
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _path(value, field):
    if not isinstance(value, str) or not value.startswith("/"):
        _fail("invalid_workspace_request", "%s must be an absolute path" % field)
    if len(value) > _PATH_MAX or any(char in value for char in ("\x00", "\r", "\n")):
        _fail("invalid_workspace_request", "%s is invalid or too long" % field)
    parts = value.split("/")[1:]
    if value != "/" and any(part in ("", ".", "..") for part in parts):
        _fail("invalid_workspace_request", "%s must be normalized" % field)
    return value.rstrip("/") or "/"


def _bounded_number(value, field, minimum, maximum, integer=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail("invalid_workspace_request", "%s must be numeric" % field)
    number = float(value)
    if not math.isfinite(number) or number < minimum or number > maximum:
        _fail("invalid_workspace_request", "%s is outside its allowed range" % field)
    if integer and not number.is_integer():
        _fail("invalid_workspace_request", "%s must be an integer" % field)
    return int(number) if integer else number


def _validate_open(payload):
    if not isinstance(payload, dict):
        _fail("invalid_workspace_request", "workspace payload must be an object")
    allowed = {
        "network_path",
        "viewer_path",
        "viewer_mode",
        "split_ratio",
        "lease_seconds",
        "idempotency_key",
    }
    unknown = sorted(set(payload) - allowed)
    if unknown:
        _fail("invalid_workspace_request", "unsupported fields: %s" % ", ".join(unknown))
    mode = payload.get("viewer_mode")
    if mode not in _VIEWER_MODES:
        _fail("invalid_workspace_request", "viewer_mode must be top_output or panel_controls")
    return {
        "network_path": _path(payload.get("network_path"), "network_path"),
        "viewer_path": _path(payload.get("viewer_path"), "viewer_path"),
        "viewer_mode": mode,
        "split_ratio": _bounded_number(payload.get("split_ratio", 0.62), "split_ratio", 0.35, 0.75),
        "lease_seconds": _bounded_number(payload.get("lease_seconds", 300), "lease_seconds", 30, 900, True),
        "idempotency_token": _token(payload.get("idempotency_key")),
    }


def _validate_lifecycle(payload):
    if not isinstance(payload, dict) or set(payload) != {"idempotency_key"}:
        _fail("invalid_workspace_request", "lifecycle payload requires only idempotency_key")
    return _token(payload.get("idempotency_key"))


def _workspace_id(value):
    if not isinstance(value, str) or not _ID_RE.fullmatch(value):
        _fail("workspace_not_found", "workspace id is invalid")
    return value


def _project_root(path):
    parts = path.split("/")
    return parts[1] if len(parts) > 1 else ""


def _public(record, action=None, deduplicated=False):
    result = {key: copy.deepcopy(value) for key, value in record.items() if not key.startswith("_")}
    result["action"] = action or result["action"]
    result["deduplicated"] = bool(deduplicated)
    return result


def _finish_locked(record, status, reason=None, warning=None):
    record["status"] = status
    record["reason"] = reason
    record["expires_at"] = None
    record["_finished_at"] = _now()
    if warning and len(record["warnings"]) < 16:
        record["warnings"].append(str(warning)[:512])


def _drop_locked(workspace_id):
    record = _RECORDS.pop(workspace_id, None)
    if record is None:
        return
    tokens = [record.get("_open_token")]
    tokens.extend(record.get("_action_tokens", {}).values())
    for token in tokens:
        if token and _IDEMPOTENCY.get(token, {}).get("workspace_id") == workspace_id:
            _IDEMPOTENCY.pop(token, None)


def _prune_locked(now=None):
    current = _now() if now is None else now
    for workspace_id, record in list(_RECORDS.items()):
        if (
            record["status"] == "scheduled"
            and record.get("_owned_identity") is None
            and current >= record["expires_at"]
        ):
            _finish_locked(record, "suppressed", "apply_timeout")
        finished = record.get("_finished_at")
        if finished is not None and current - finished >= TERMINAL_RETENTION_SECONDS:
            _drop_locked(workspace_id)
    terminal_ids = [key for key, value in _RECORDS.items() if value["status"] in _TERMINAL]
    while len(terminal_ids) > MAX_RECORDS:
        _drop_locked(terminal_ids.pop(0))


def _new_record(request):
    now = _now()
    workspace_id = secrets.token_urlsafe(18)
    return {
        "workspace_id": workspace_id,
        "action": "open",
        "status": "scheduled",
        "deduplicated": False,
        "created_at": now,
        "expires_at": now + APPLY_TTL_SECONDS,
        "targets": {
            "network_path": request["network_path"],
            "viewer_path": request["viewer_path"],
            "viewer_mode": request["viewer_mode"],
            "split_ratio": request["split_ratio"],
        },
        "source_pane": None,
        "owned_pane": None,
        "baseline": None,
        "workspace": None,
        "cleanup": {
            "attempted": False,
            "owned_pane_closed": False,
            "source_restored": False,
            "baseline_verified": False,
        },
        "reason": None,
        "warnings": [],
        "undo_label": None,
        "_lease_seconds": request["lease_seconds"],
        "_generation": 1,
        "_finished_at": None,
        "_open_token": request["idempotency_token"],
        "_request_hash": _json_hash({key: value for key, value in request.items() if key != "idempotency_token"}),
        "_action_tokens": {},
        "_baseline_snapshot": None,
        "_workspace_snapshot": None,
        "_source_before": None,
        "_source_active": None,
        "_target_before": None,
        "_target_active": None,
        "_owned_identity": None,
        "_settle_fingerprint": None,
        "_settle_attempts": 0,
        "_terminal_after_restore": None,
        "_terminal_reason": None,
        "_verify_attempts": 0,
    }


def _register_token_locked(token, workspace_id, action, fingerprint):
    existing = _IDEMPOTENCY.get(token)
    if existing is not None:
        if existing["action"] != action or existing["fingerprint"] != fingerprint:
            _fail("idempotency_conflict", "idempotency key was reused with different input")
        return existing
    value = {"workspace_id": workspace_id, "action": action, "fingerprint": fingerprint}
    _IDEMPOTENCY[token] = value
    return None


def _active_capacity_locked():
    return any(record["status"] in _NON_TERMINAL for record in _RECORDS.values())


def _schedule(callback, delay_frames=1, delay_ms=None, wall_time=False):
    if _SCHEDULER_OVERRIDE is not None:
        _SCHEDULER_OVERRIDE(callback, delay_frames=delay_frames, delay_ms=delay_ms, wall_time=wall_time)
        return
    runtime = _runtime()
    runner = getattr(runtime, "run", None) if runtime is not None else None
    if not callable(runner):
        raise RuntimeError("TouchDesigner frame scheduling is unavailable")
    if delay_ms is None:
        runner("args[0]()", callback, delayFrames=delay_frames)
    else:
        runner("args[0]()", callback, delayMilliSeconds=int(delay_ms), wallTime=wall_time)


def _schedule_open(workspace_id, generation):
    _schedule(lambda: _apply_open(workspace_id, generation), delay_frames=1)


def _schedule_open_readback(workspace_id, generation):
    _schedule(lambda: _readback_open(workspace_id, generation), delay_frames=1)


def _schedule_restore(workspace_id, generation):
    _schedule(lambda: _apply_lifecycle_cleanup(workspace_id, generation), delay_frames=1)


def _schedule_verify(workspace_id, generation):
    _schedule(lambda: _verify_restore(workspace_id, generation), delay_frames=1)


def _schedule_lease(workspace_id, generation, seconds):
    _schedule(
        lambda: _lease_expired(workspace_id, generation),
        delay_frames=0,
        delay_ms=int(seconds * 1000),
        wall_time=True,
    )


def _record_for_callback(workspace_id, generation, statuses):
    with _LOCK:
        record = _RECORDS.get(workspace_id)
        if record is None or record["_generation"] != generation or record["status"] not in statuses:
            return None
        return copy.deepcopy(record)


def _op_path(value):
    try:
        return str(value.path)
    except Exception:  # noqa: BLE001
        return None


def _pane_type(pane):
    try:
        return str(pane.type).replace("PaneType.", "").upper().replace("_", "")
    except Exception:  # noqa: BLE001
        return ""


def _family(node):
    for name in ("TOP", "COMP"):
        try:
            if bool(getattr(node, "is%s" % name)):
                return name
        except Exception:  # noqa: BLE001
            pass
    value = str(getattr(node, "OPType", None) or getattr(node, "type", "")).upper()
    return next((name for name in ("TOP", "COMP") if value.endswith(name)), None)


def _parent(node):
    try:
        value = node.parent
        return value() if callable(value) else value
    except Exception:  # noqa: BLE001
        return None


def _pane_scalar(pane, name, default=None):
    try:
        value = getattr(pane, name)
    except Exception:  # noqa: BLE001
        return default
    if value is None or type(value) in (str, bool, int, float):  # noqa: E721
        return value
    return str(value)


def _viewport(pane):
    values = {}
    for name in ("x", "y", "zoom"):
        value = _pane_scalar(pane, name)
        if isinstance(value, (int, float)) and math.isfinite(float(value)):
            values[name] = round(float(value), 6)
    return values if len(values) == 3 else None


def _pane_descriptor(pane):
    pane_id = _pane_scalar(pane, "id")
    if isinstance(pane_id, bool) or not isinstance(pane_id, int):
        raise RuntimeError("pane id is unavailable")
    ratio = _pane_scalar(pane, "ratio")
    ratio = round(float(ratio), 6) if isinstance(ratio, (int, float)) else None
    try:
        owner_path = _op_path(pane.owner)
    except Exception:  # noqa: BLE001
        owner_path = None
    return {
        "id": pane_id,
        "name": _pane_scalar(pane, "name"),
        "type": _pane_type(pane),
        "owner": owner_path,
        "link": _pane_scalar(pane, "link"),
        "ratio": ratio,
        "maximize": bool(_pane_scalar(pane, "maximize", False)),
        "open": bool(_pane_scalar(pane, "open", True)),
        "viewport": _viewport(pane),
    }


def _pane_list(runtime):
    ui = getattr(runtime, "ui", None)
    panes_obj = getattr(ui, "panes", None) if ui is not None else None
    if panes_obj is None:
        raise RuntimeError("ui unavailable")
    panes = list(panes_obj)
    if len(panes) > MAX_PANES:
        raise OverflowError("pane limit")
    descriptors = [_pane_descriptor(pane) for pane in panes]
    ids = [item["id"] for item in descriptors]
    names = [item["name"] for item in descriptors if item["name"]]
    if len(ids) != len(set(ids)) or len(names) != len(set(names)):
        raise RuntimeError("pane identity is ambiguous")
    return ui, panes_obj, panes, descriptors


def _active_id(panes_obj):
    current = getattr(panes_obj, "current", None)
    return _pane_scalar(current, "id") if current is not None else None


def _selected_paths(owner):
    try:
        return sorted(path for path in (_op_path(node) for node in owner.selectedChildren) if path)
    except Exception:  # noqa: BLE001
        return []


def _target_state(parent):
    current = getattr(parent, "currentChild", None)
    return {
        "parent_path": _op_path(parent),
        "current_path": _op_path(current),
        "selected_paths": _selected_paths(parent),
    }


def _snapshot(runtime, target_parent=None):
    _ui, panes_obj, _panes, descriptors = _pane_list(runtime)
    value = {
        "panes": sorted(descriptors, key=lambda item: item["id"]),
        "active_id": _active_id(panes_obj),
        "target_state": _target_state(target_parent) if target_parent is not None else None,
    }
    value["fingerprint"] = _json_hash(value)
    return value


def _pane_by_id(runtime, pane_id, name=None):
    _ui, _panes_obj, panes, _descriptors = _pane_list(runtime)
    for pane in panes:
        if _pane_scalar(pane, "id") == pane_id and (name is None or _pane_scalar(pane, "name") == name):
            return pane
    return None


def _perform_mode(runtime):
    for source in (getattr(runtime, "ui", None), getattr(runtime, "project", None)):
        try:
            if bool(source.performMode):
                return True
        except Exception:  # noqa: BLE001
            pass
    return False


def _required_op(runtime, path):
    node = runtime.op(path)
    if node is None:
        raise LookupError("target_not_found")
    return node


def _require_family(node, family):
    if _family(node) != family:
        raise TypeError("wrong_target_family")


def _target_parent(viewer, mode):
    if mode != "top_output":
        _require_family(viewer, "COMP")
        if getattr(viewer, "panel", None) is None:
            raise TypeError("wrong_target_family")
        return None
    _require_family(viewer, "TOP")
    parent = _parent(viewer)
    _require_family(parent, "COMP")
    return parent


def _resolve_targets(runtime, record):
    network = _required_op(runtime, record["targets"]["network_path"])
    viewer = _required_op(runtime, record["targets"]["viewer_path"])
    if _project_root(_op_path(network)) != _project_root(_op_path(viewer)):
        raise LookupError("cross_project")
    _require_family(network, "COMP")
    mode = record["targets"]["viewer_mode"]
    return network, viewer, _target_parent(viewer, mode)


def _source_pane(runtime):
    _ui, panes_obj, panes, _descriptors = _pane_list(runtime)
    current_id = _active_id(panes_obj)
    source = next((pane for pane in panes if _pane_scalar(pane, "id") == current_id), None)
    if source is None or _pane_type(source) != "NETWORKEDITOR":
        raise LookupError("no_active_network_editor")
    descriptor = _pane_descriptor(source)
    if descriptor["maximize"] or not descriptor["open"]:
        raise LookupError("source_pane_unavailable")
    return source


def _require_split_capacity(runtime):
    _ui, _panes_obj, panes, _descriptors = _pane_list(runtime)
    if len(panes) >= MAX_PANES:
        raise OverflowError("pane limit")


def _set_viewer_target(runtime, pane, viewer, target_parent, mode):
    if mode == "top_output":
        viewer.current = True
        pane.owner = target_parent
    else:
        pane.owner = viewer


def _pane_type_value(pane, name):
    try:
        pane_type = type(pane.type)
        value = getattr(pane_type, name, None)
    except Exception:  # noqa: BLE001
        value = None
    if value is None:
        raise RuntimeError("pane type is unavailable")
    return value


def _apply_split(runtime, source, viewer, target_parent, record, progress):
    created = source.splitRight()
    owned_name = "tdmcp_workspace_%s" % record["workspace_id"][-10:]
    progress["owned_identity"] = {
        "id": _pane_scalar(created, "id"),
        "name": _pane_scalar(created, "name"),
        "owned_name": owned_name,
    }
    created.name = owned_name
    progress["owned_identity"]["name"] = owned_name
    changed = created.changeType(_pane_type_value(created, _VIEWER_MODES[record["targets"]["viewer_mode"]]))
    created = None
    changed.name = owned_name
    progress["owned_identity"] = {
        "id": _pane_scalar(changed, "id"),
        "name": owned_name,
        "owned_name": owned_name,
    }
    _set_viewer_target(runtime, changed, viewer, target_parent, record["targets"]["viewer_mode"])
    source.owner = runtime.op(record["targets"]["network_path"])
    source.ratio = record["targets"]["split_ratio"]
    return changed


def _require_readback(condition, message):
    if not condition:
        raise RuntimeError(message)


def _require_ratio(actual, expected, message):
    _require_readback(actual is not None and abs(actual - expected) <= 0.005, message)


def _validate_open_readback(source, owned, viewer, target_parent, record):
    source_desc = _pane_descriptor(source)
    owned_desc = _pane_descriptor(owned)
    expected_type = _VIEWER_MODES[record["targets"]["viewer_mode"]]
    expected_owner = _op_path(target_parent if target_parent is not None else viewer)
    ratio = record["targets"]["split_ratio"]
    _require_readback(
        source_desc["owner"] == record["targets"]["network_path"],
        "source owner readback mismatch",
    )
    _require_readback(
        owned_desc["type"] == expected_type and owned_desc["owner"] == expected_owner,
        "viewer readback mismatch",
    )
    _require_ratio(source_desc["ratio"], ratio, "source ratio readback mismatch")
    _require_ratio(owned_desc["ratio"], 1.0 - ratio, "viewer ratio readback mismatch")
    top_current = _target_state(target_parent)["current_path"] if target_parent is not None else None
    _require_readback(
        target_parent is None or top_current == record["targets"]["viewer_path"],
        "TOP Viewer currentChild readback mismatch",
    )
    return source_desc, owned_desc


def _restore_target(runtime, state):
    if state is None:
        return
    parent = runtime.op(state["parent_path"])
    if parent is None:
        raise RuntimeError("target parent disappeared")
    for node in list(getattr(parent, "selectedChildren", []) or []):
        node.selected = False
    for path in state["selected_paths"]:
        node = runtime.op(path)
        if node is not None and _parent(node) is parent:
            node.selected = True
    current = runtime.op(state["current_path"]) if state["current_path"] else None
    if current is not None:
        current.current = True


def _restore_source(runtime, state):
    source = _pane_by_id(runtime, state["id"], state["name"])
    if source is None or _pane_type(source) != "NETWORKEDITOR":
        raise RuntimeError("source pane disappeared")
    owner = runtime.op(state["owner"])
    if state["owner"] and owner is None:
        raise RuntimeError("source owner disappeared")
    source.owner = owner
    for name in ("link", "ratio", "maximize"):
        if state.get(name) is not None:
            setattr(source, name, state[name])
    for name, value in (state.get("viewport") or {}).items():
        setattr(source, name, value)


def _receipt_pane(descriptor):
    return {"id": descriptor["id"], "name": descriptor["name"], "type": descriptor["type"]}


def _compact_snapshot(snapshot):
    if "panes" not in snapshot:
        return {
            "pane_count": snapshot["pane_count"],
            "fingerprint": snapshot["fingerprint"],
        }
    return {"pane_count": len(snapshot["panes"]), "fingerprint": snapshot["fingerprint"]}


def _store_pending_open(workspace_id, generation, values):
    with _LOCK:
        record = _RECORDS.get(workspace_id)
        if record is None or record["_generation"] != generation or record["status"] != "scheduled":
            return False
        record["_baseline_snapshot"] = _compact_snapshot(values["baseline"])
        record["_source_before"] = values["source_before"]
        record["_target_before"] = values["target_before"]
        record["_owned_identity"] = {
            "id": values["owned"]["id"],
            "name": values["owned"]["name"],
            "owned_name": values["owned"]["name"],
        }
        record["_settle_fingerprint"] = None
        record["_settle_attempts"] = 0
        return True


def _publish_active_locked(record, values):
    record["status"] = "active"
    record["expires_at"] = _now() + record["_lease_seconds"]
    record["source_pane"] = _receipt_pane(values["source_active"])
    record["owned_pane"] = _receipt_pane(values["owned"])
    record["baseline"] = copy.deepcopy(record["_baseline_snapshot"])
    record["workspace"] = _compact_snapshot(values["workspace"])
    record["_workspace_snapshot"] = _compact_snapshot(values["workspace"])
    record["_source_active"] = values["source_active"]
    record["_target_active"] = values["target_active"]


def _store_settle_candidate(workspace_id, generation, values):
    with _LOCK:
        record = _RECORDS.get(workspace_id)
        if record is None or record["_generation"] != generation or record["status"] != "scheduled":
            return "stale"
        fingerprint = values["workspace"]["fingerprint"]
        stable = record["_settle_fingerprint"] == fingerprint
        record["_settle_fingerprint"] = fingerprint
        record["_settle_attempts"] += 1
        if stable:
            _publish_active_locked(record, values)
            return "active"
        return (
            "unstable"
            if record["_settle_attempts"] >= MAX_SETTLE_READBACKS
            else "retry"
        )


def _suppress_callback(workspace_id, generation, reason, warning=None):
    with _LOCK:
        record = _RECORDS.get(workspace_id)
        if record is not None and record["_generation"] == generation and record["status"] == "scheduled":
            _finish_locked(record, "suppressed", reason, warning)


def _open_reason(error):
    if isinstance(error, OverflowError):
        return "pane_limit"
    if isinstance(error, (LookupError, TypeError)) and error.args:
        return error.args[0]
    return "callback_error"


def _owned_cleanup_candidates(runtime, owned_identity):
    _ui, _panes_obj, panes, _descriptors = _pane_list(runtime)
    return [
        pane
        for pane in panes
        if _pane_scalar(pane, "id") == owned_identity["id"]
        or _pane_scalar(pane, "name") == owned_identity.get("owned_name")
    ]


def _close_owned_identity(runtime, owned_identity):
    if owned_identity is None:
        return False
    candidates = _owned_cleanup_candidates(runtime, owned_identity)
    if len(candidates) != 1:
        return False
    candidates[0].close()
    return True


def _attempt_open_cleanup(runtime, source_before, target_before, owned_identity):
    cleanup = {"attempted": True, "owned_pane_closed": False, "source_restored": False, "baseline_verified": False}
    try:
        _restore_source(runtime, source_before)
        _restore_target(runtime, target_before)
        cleanup["source_restored"] = True
        cleanup["owned_pane_closed"] = _close_owned_identity(runtime, owned_identity)
    except Exception:  # noqa: BLE001
        pass
    return cleanup


def _store_open_cleanup(
    workspace_id,
    generation,
    baseline,
    target_before,
    owned_identity,
    cleanup,
    terminal,
    terminal_reason,
):
    with _LOCK:
        record = _RECORDS.get(workspace_id)
        if record is None or record["_generation"] != generation:
            return False
        record["cleanup"] = cleanup
        record["_baseline_snapshot"] = _compact_snapshot(baseline)
        record["_target_before"] = target_before
        record["_owned_identity"] = copy.deepcopy(owned_identity)
        record["_terminal_after_restore"] = terminal
        record["_terminal_reason"] = terminal_reason
        record["status"] = "cleanup_scheduled" if cleanup["owned_pane_closed"] else "failed"
        if record["status"] == "failed":
            _finish_locked(record, "failed", "callback_error", "Workspace apply failed; cleanup was not verified.")
        return cleanup["owned_pane_closed"]


def _schedule_open_cleanup_verification(workspace_id, generation):
    try:
        _schedule_verify(workspace_id, generation)
    except Exception:  # noqa: BLE001
        with _LOCK:
            record = _RECORDS.get(workspace_id)
            if record is not None and record["_generation"] == generation:
                _finish_locked(record, "failed", "scheduling_error", "Deferred cleanup verification could not be scheduled.")


def _compensate_open(
    runtime,
    workspace_id,
    generation,
    baseline,
    source_before,
    target_before,
    owned_identity,
    terminal="failed",
    terminal_reason="callback_error",
):
    cleanup = _attempt_open_cleanup(runtime, source_before, target_before, owned_identity)
    if _store_open_cleanup(
        workspace_id,
        generation,
        baseline,
        target_before,
        owned_identity,
        cleanup,
        terminal,
        terminal_reason,
    ):
        _schedule_open_cleanup_verification(workspace_id, generation)


def _open_preflight_reason(record, runtime):
    if _now() >= record["expires_at"]:
        return "apply_timeout"
    if runtime is None or getattr(runtime, "ui", None) is None:
        return "ui_unavailable"
    if _perform_mode(runtime):
        return "perform_mode"
    return None


def _optional_target_state(target_parent):
    return _target_state(target_parent) if target_parent is not None else None


def _open_transaction(runtime, record, progress):
    _network, viewer, target_parent = _resolve_targets(runtime, record)
    _require_split_capacity(runtime)
    source = _source_pane(runtime)
    progress["target_before"] = _optional_target_state(target_parent)
    progress["baseline"] = _snapshot(runtime, target_parent)
    progress["source_before"] = _pane_descriptor(source)
    owned = _apply_split(runtime, source, viewer, target_parent, record, progress)
    source_active, owned_desc = _validate_open_readback(source, owned, viewer, target_parent, record)
    workspace = _snapshot(runtime, target_parent)
    _require_readback(
        len(workspace["panes"]) == len(progress["baseline"]["panes"]) + 1,
        "split readback mismatch",
    )
    return {
        "baseline": progress["baseline"],
        "source_before": progress["source_before"],
        "target_before": progress["target_before"],
        "owned": owned_desc,
    }


def _cleanup_missing_lease(workspace_id, generation):
    with _LOCK:
        record = _RECORDS.get(workspace_id)
        if record is None or record["_generation"] != generation or record["status"] != "active":
            return
        next_generation = _begin_restore_locked(record, "failed", "scheduling_error")
    _apply_restore(workspace_id, next_generation)


def _compensate_pending_open(runtime, workspace_id, generation, record):
    _compensate_open(
        runtime,
        workspace_id,
        generation,
        record["_baseline_snapshot"],
        record["_source_before"],
        record["_target_before"],
        record["_owned_identity"],
    )


def _schedule_readback_or_compensate(runtime, workspace_id, generation, record):
    try:
        _schedule_open_readback(workspace_id, generation)
    except Exception:  # noqa: BLE001
        _compensate_pending_open(runtime, workspace_id, generation, record)


def _schedule_open_deadline(workspace_id, generation, expires_at):
    remaining_ms = max(1, int((expires_at - _now()) * 1000))
    _schedule(
        lambda: _open_deadline_expired(workspace_id, generation),
        delay_frames=0,
        delay_ms=remaining_ms,
        wall_time=True,
    )


def _start_open_settle(runtime, workspace_id, generation, record, values, progress):
    if not _store_pending_open(workspace_id, generation, values):
        _compensate_open(
            runtime,
            workspace_id,
            generation,
            progress["baseline"],
            progress["source_before"],
            progress["target_before"],
            progress["owned_identity"],
        )
        return
    pending = _record_for_callback(workspace_id, generation, {"scheduled"})
    if pending is None:
        return
    try:
        _schedule_open_deadline(workspace_id, generation, pending["expires_at"])
    except Exception:  # noqa: BLE001
        _compensate_pending_open(runtime, workspace_id, generation, pending)
        return
    _schedule_readback_or_compensate(runtime, workspace_id, generation, pending)


def _settle_readback(runtime, record):
    _network, viewer, target_parent = _resolve_targets(runtime, record)
    source_state = record["_source_before"]
    owned_state = record["_owned_identity"]
    source = _pane_by_id(runtime, source_state["id"], source_state["name"])
    owned = _pane_by_id(runtime, owned_state["id"], owned_state["name"])
    _require_readback(source is not None, "source pane disappeared during open readback")
    _require_readback(owned is not None, "owned pane disappeared during open readback")
    source_active, owned_desc = _validate_open_readback(
        source,
        owned,
        viewer,
        target_parent,
        record,
    )
    workspace = _snapshot(runtime, target_parent)
    _require_readback(
        len(workspace["panes"]) == record["_baseline_snapshot"]["pane_count"] + 1,
        "settled split pane count mismatch",
    )
    return {
        "source_active": source_active,
        "owned": owned_desc,
        "workspace": workspace,
        "target_active": _optional_target_state(target_parent),
    }


def _lease_active_open(workspace_id, generation, record):
    try:
        _schedule_lease(workspace_id, generation, record["_lease_seconds"])
    except Exception:  # noqa: BLE001
        _cleanup_missing_lease(workspace_id, generation)


def _handle_settle_outcome(runtime, workspace_id, generation, record, outcome):
    if outcome == "retry":
        _schedule_readback_or_compensate(runtime, workspace_id, generation, record)
        return
    if outcome == "unstable":
        _compensate_pending_open(runtime, workspace_id, generation, record)
        return
    if outcome == "active":
        _lease_active_open(workspace_id, generation, record)


def _readback_open(workspace_id, generation):
    record = _record_for_callback(workspace_id, generation, {"scheduled"})
    if record is None:
        return
    runtime = _runtime()
    preflight = _open_preflight_reason(record, runtime)
    if preflight is not None:
        _compensate_pending_open(runtime, workspace_id, generation, record)
        return
    try:
        values = _settle_readback(runtime, record)
    except Exception:  # noqa: BLE001
        _compensate_pending_open(runtime, workspace_id, generation, record)
        return
    outcome = _store_settle_candidate(workspace_id, generation, values)
    _handle_settle_outcome(runtime, workspace_id, generation, record, outcome)


def _open_deadline_expired(workspace_id, generation):
    record = _record_for_callback(workspace_id, generation, {"scheduled"})
    if record is None or _now() < record["expires_at"]:
        return
    _compensate_pending_open(_runtime(), workspace_id, generation, record)


def _handle_open_failure(runtime, workspace_id, generation, error, progress):
    if progress["baseline"] is None or progress["source_before"] is None:
        _suppress_callback(workspace_id, generation, _open_reason(error))
        return
    _compensate_open(
        runtime,
        workspace_id,
        generation,
        progress["baseline"],
        progress["source_before"],
        progress["target_before"],
        progress["owned_identity"],
    )


def _apply_open(workspace_id, generation):
    record = _record_for_callback(workspace_id, generation, {"scheduled"})
    if record is None:
        return
    runtime = _runtime()
    preflight = _open_preflight_reason(record, runtime)
    if preflight is not None:
        _suppress_callback(workspace_id, generation, preflight)
        return
    progress = {"baseline": None, "source_before": None, "target_before": None, "owned_identity": None}
    try:
        values = _open_transaction(runtime, record, progress)
    except Exception as error:  # noqa: BLE001
        _handle_open_failure(runtime, workspace_id, generation, error, progress)
        return
    _start_open_settle(runtime, workspace_id, generation, record, values, progress)


def _current_restore_snapshot(runtime, record):
    target_parent = None
    target_state = record.get("_target_active")
    if target_state is not None:
        target_parent = runtime.op(target_state["parent_path"])
    return _snapshot(runtime, target_parent)


def _mark_conflict(workspace_id, generation, reason):
    with _LOCK:
        record = _RECORDS.get(workspace_id)
        if record is not None and record["_generation"] == generation:
            _finish_locked(record, "conflicted", reason)


def _reapply_active(runtime, record):
    _restore_source(runtime, record["_source_active"])
    _restore_target(runtime, record["_target_active"])


def _restore_conflict_reason(runtime, record):
    if runtime is None or getattr(runtime, "ui", None) is None or _perform_mode(runtime):
        return "ui_unavailable"
    try:
        current = _current_restore_snapshot(runtime, record)
    except Exception:  # noqa: BLE001
        return "artist_layout_changed"
    if current["fingerprint"] == record["_workspace_snapshot"]["fingerprint"]:
        return None
    owned = record["_owned_identity"]
    if _pane_by_id(runtime, owned["id"], owned["name"]) is None:
        return "owned_pane_missing"
    return "artist_layout_changed"


def _close_owned_workspace(runtime, record):
    cleanup = {"attempted": True, "owned_pane_closed": False, "source_restored": False, "baseline_verified": False}
    try:
        _restore_source(runtime, record["_source_before"])
        _restore_target(runtime, record["_target_before"])
        cleanup["source_restored"] = True
        owned = _pane_by_id(runtime, record["_owned_identity"]["id"], record["_owned_identity"]["name"])
        if owned is None:
            raise RuntimeError("owned pane disappeared")
        owned.close()
        cleanup["owned_pane_closed"] = True
    except Exception:  # noqa: BLE001
        try:
            _reapply_active(runtime, record)
        except Exception:  # noqa: BLE001
            pass
        return cleanup, False
    return cleanup, True


def _store_restore_progress(workspace_id, generation, cleanup, closed):
    with _LOCK:
        live = _RECORDS.get(workspace_id)
        if live is None or live["_generation"] != generation:
            return False
        live["cleanup"] = cleanup
        if closed:
            live["status"] = "cleanup_scheduled"
        else:
            _finish_locked(
                live,
                "failed",
                "callback_error",
                "Workspace restore failed; active state was not claimed as restored.",
            )
        return closed


def _schedule_restore_verification(workspace_id, generation):
    try:
        _schedule_verify(workspace_id, generation)
    except Exception:  # noqa: BLE001
        with _LOCK:
            live = _RECORDS.get(workspace_id)
            if live is not None and live["_generation"] == generation:
                _finish_locked(live, "failed", "scheduling_error", "Deferred close verification could not be scheduled.")


def _apply_restore(workspace_id, generation):
    record = _record_for_callback(workspace_id, generation, {"restore_scheduled", "cancel_scheduled"})
    if record is None:
        return
    runtime = _runtime()
    conflict = _restore_conflict_reason(runtime, record)
    if conflict is not None:
        _mark_conflict(workspace_id, generation, conflict)
        return
    cleanup, closed = _close_owned_workspace(runtime, record)
    if not _store_restore_progress(workspace_id, generation, cleanup, closed):
        return
    _schedule_restore_verification(workspace_id, generation)


def _apply_lifecycle_cleanup(workspace_id, generation):
    record = _record_for_callback(
        workspace_id,
        generation,
        {"restore_scheduled", "cancel_scheduled"},
    )
    if record is None:
        return
    if record["_workspace_snapshot"] is not None:
        _apply_restore(workspace_id, generation)
        return
    _compensate_open(
        _runtime(),
        workspace_id,
        generation,
        record["_baseline_snapshot"],
        record["_source_before"],
        record["_target_before"],
        record["_owned_identity"],
        terminal="cancelled",
        terminal_reason="client_cancelled",
    )


def _baseline_verified(runtime, record):
    try:
        target_parent = runtime.op(record["_target_before"]["parent_path"]) if record["_target_before"] else None
        current = _snapshot(runtime, target_parent)
        return current["fingerprint"] == record["_baseline_snapshot"]["fingerprint"]
    except Exception:  # noqa: BLE001
        return False


def _store_baseline_verification(workspace_id, generation, verified):
    with _LOCK:
        live = _RECORDS.get(workspace_id)
        if live is None or live["_generation"] != generation:
            return False
        live["cleanup"]["baseline_verified"] = verified
        if not verified:
            live["_verify_attempts"] += 1
            if live["_verify_attempts"] < 2:
                return True
            _finish_locked(
                live,
                "failed",
                "callback_error",
                "Bounded later-frame baseline verification failed.",
            )
            return False
        terminal = live["_terminal_after_restore"] or "restored"
        reason = live["_terminal_reason"]
        _finish_locked(live, terminal, reason)
        return False


def _verify_restore(workspace_id, generation):
    record = _record_for_callback(workspace_id, generation, {"cleanup_scheduled"})
    if record is None:
        return
    retry = _store_baseline_verification(
        workspace_id,
        generation,
        _baseline_verified(_runtime(), record),
    )
    if retry:
        _schedule_restore_verification(workspace_id, generation)


def _begin_restore_locked(record, terminal, reason):
    record["_generation"] += 1
    record["status"] = "cancel_scheduled" if terminal == "cancelled" else "restore_scheduled"
    record["_terminal_after_restore"] = terminal
    record["_terminal_reason"] = reason
    return record["_generation"]


def _lease_expired(workspace_id, generation):
    with _LOCK:
        record = _RECORDS.get(workspace_id)
        if record is None or record["_generation"] != generation or record["status"] != "active":
            return
        if record["expires_at"] is not None and _now() < record["expires_at"]:
            return
        next_generation = _begin_restore_locked(record, "expired", "lease_expired")
    _apply_restore(workspace_id, next_generation)


def open_workspace(payload):
    """Validate, allocate and schedule one workspace without touching TD objects."""
    request = _validate_open(payload)
    record = _new_record(request)
    with _LOCK:
        _prune_locked()
        duplicate = _register_token_locked(record["_open_token"], record["workspace_id"], "open", record["_request_hash"])
        if duplicate is not None:
            existing = _RECORDS.get(duplicate["workspace_id"])
            if existing is None:
                _fail("workspace_not_found", "deduplicated workspace receipt expired")
            return _public(existing, "open", True)
        if _active_capacity_locked():
            _finish_locked(record, "suppressed", "workspace_capacity")
        _RECORDS[record["workspace_id"]] = record
        generation = record["_generation"]
    if record["status"] == "scheduled":
        try:
            _schedule_open(record["workspace_id"], generation)
        except Exception:  # noqa: BLE001
            with _LOCK:
                _finish_locked(record, "failed", "scheduling_error")
    return _public(record, "open")


def get_workspace_status(workspace_id):
    """Return one bounded receipt; this function never accesses TouchDesigner."""
    clean_id = _workspace_id(workspace_id)
    with _LOCK:
        _prune_locked()
        record = _RECORDS.get(clean_id)
        if record is None:
            _fail("workspace_not_found", "workspace receipt was not found")
        return _public(record, "status")


def _required_record_locked(workspace_id):
    record = _RECORDS.get(workspace_id)
    if record is None:
        _fail("workspace_not_found", "workspace receipt was not found")
    return record


def _cancel_transition_locked(record):
    if record["status"] == "scheduled":
        if record["_owned_identity"] is not None:
            return _begin_restore_locked(record, "cancelled", "client_cancelled")
        record["_generation"] += 1
        _finish_locked(record, "cancelled", "client_cancelled")
        return None
    if record["status"] != "active":
        _fail("workspace_conflict", "workspace transition is already in progress")
    return _begin_restore_locked(record, "cancelled", "client_cancelled")


def _restore_transition_locked(record):
    if record["status"] != "active":
        _fail("workspace_conflict", "workspace transition is already in progress")
    return _begin_restore_locked(record, "restored", None)


def _lifecycle_transition_locked(record, action):
    if record["status"] in _TERMINAL:
        return None
    if action == "cancel":
        return _cancel_transition_locked(record)
    return _restore_transition_locked(record)


def _lifecycle(workspace_id, payload, action):
    clean_id = _workspace_id(workspace_id)
    token = _validate_lifecycle(payload)
    fingerprint = _json_hash({"workspace_id": clean_id, "action": action})
    with _LOCK:
        _prune_locked()
        record = _required_record_locked(clean_id)
        if token in _IDEMPOTENCY:
            _register_token_locked(token, clean_id, action, fingerprint)
            return _public(record, action, True), None
        if record["status"] in _TERMINAL:
            return _public(record, action), None
        generation = _lifecycle_transition_locked(record, action)
        _register_token_locked(token, clean_id, action, fingerprint)
        record["_action_tokens"][action] = token
        return _public(record, action), generation


def restore_workspace(workspace_id, payload):
    """Schedule compare-and-swap restoration; completion is later-frame verified."""
    receipt, generation = _lifecycle(workspace_id, payload, "restore")
    if generation is not None:
        try:
            _schedule_restore(workspace_id, generation)
        except Exception:  # noqa: BLE001
            with _LOCK:
                record = _RECORDS.get(workspace_id)
                if record is not None and record["_generation"] == generation:
                    _finish_locked(record, "failed", "scheduling_error")
            return get_workspace_status(workspace_id) | {"action": "restore"}
    return receipt


def cancel_workspace(workspace_id, payload):
    """Cancel before apply or schedule the same CAS cleanup after apply."""
    receipt, generation = _lifecycle(workspace_id, payload, "cancel")
    if generation is not None:
        try:
            _schedule_restore(workspace_id, generation)
        except Exception:  # noqa: BLE001
            with _LOCK:
                record = _RECORDS.get(workspace_id)
                if record is not None and record["_generation"] == generation:
                    _finish_locked(record, "failed", "scheduling_error")
            return get_workspace_status(workspace_id) | {"action": "cancel"}
    return receipt


def _configure_for_tests(runtime=None, scheduler=None, clock=None):
    global _RUNTIME_OVERRIDE, _SCHEDULER_OVERRIDE, _CLOCK
    _RUNTIME_OVERRIDE = runtime
    _SCHEDULER_OVERRIDE = scheduler
    _CLOCK = clock or time.monotonic


def _reset_for_tests():
    global _RUNTIME_OVERRIDE, _SCHEDULER_OVERRIDE, _CLOCK
    with _LOCK:
        _RECORDS.clear()
        _IDEMPOTENCY.clear()
    _RUNTIME_OVERRIDE = None
    _SCHEDULER_OVERRIDE = None
    _CLOCK = time.monotonic
