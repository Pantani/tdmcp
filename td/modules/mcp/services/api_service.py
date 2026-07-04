"""Core node CRUD, Python execution, method calls and server info.

All functions assume the TouchDesigner globals (`op`, `app`, `project`) are
available, which is the case when this package is imported from a running TD.
"""

import io
import math
import re
import sys
import time
import traceback
from contextlib import redirect_stdout
from datetime import datetime, timezone

import td

# TouchDesigner injects globals (op, app, project, operator classes) only into
# DAT/Textport scope, not into imported modules — so reach them via `td`.
op = td.op
app = td.app
project = td.project

_TYPE_RE = re.compile(r"[A-Za-z][A-Za-z0-9_]*$")
_STARTED_AT = datetime.now(timezone.utc)
_STARTED_MONOTONIC = time.monotonic()
_LAST_HEALTH_AT = _STARTED_AT
_HEARTBEAT_STALE_AFTER_SECONDS = 10.0


def op_type(node):
    """Returns the operator type string, e.g. 'noiseTOP'."""
    return getattr(node, "OPType", None) or getattr(node, "type", "") or ""


def _resolve_type(type_name):
    """Resolves an operator type string to its class via the td module."""
    if not type_name or not _TYPE_RE.match(type_name):
        raise ValueError("Invalid operator type: %r" % (type_name,))
    cls = getattr(td, type_name, None)
    if cls is None:
        raise ValueError("Unknown operator type: %s" % type_name)
    return cls


def node_ref(node):
    return {"path": node.path, "type": op_type(node), "name": node.name}


def _jsonable(value):
    try:
        import json

        json.dumps(value)
        return value
    except Exception:  # noqa: BLE001
        return str(value)


def _iso_utc(value):
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _safe_attr(obj, *names):
    if obj is None:
        return None
    for name in names:
        try:
            value = getattr(obj, name)
        except Exception:  # noqa: BLE001
            continue
        if value is not None:
            return value
    return None


def _safe_number(obj, *names, integer=False):
    value = _safe_attr(obj, *names)
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except Exception:  # noqa: BLE001
        return None
    if not math.isfinite(number):
        return None
    return int(number) if integer else number


def _first_number(sources, integer=False):
    for obj, names in sources:
        number = _safe_number(obj, *names, integer=integer)
        if number is not None:
            return number
    return None


def _health_performance(webserver):
    performance = {
        "available": False,
        "cook_time_ms": _first_number(
            (
                (webserver, ("cookTime", "cook_time", "cookTimeMS")),
                (app, ("cookTime", "cook_time", "cookTimeMS")),
            )
        ),
        "cook_count": _first_number(
            (
                (webserver, ("cookCount", "cook_count")),
                (app, ("cookCount", "cook_count")),
            ),
            integer=True,
        ),
        "cook_frame": _first_number(
            (
                (webserver, ("cookFrame", "cook_frame", "cookAbsFrame")),
                (app, ("cookFrame", "cook_frame", "cookAbsFrame", "frame")),
            ),
            integer=True,
        ),
        "dropped_frames": _first_number(
            (
                (app, ("droppedFrames", "dropped_frames", "numDroppedFrames")),
                (project, ("droppedFrames", "dropped_frames", "numDroppedFrames")),
            ),
            integer=True,
        ),
        "fps": _first_number(
            (
                (app, ("fps", "cookRate", "rate")),
                (project, ("fps", "cookRate", "rate")),
            )
        ),
        "gpu_memory_mb": _first_number(
            ((app, ("gpuMemory", "gpuMemoryMB", "gpuMemoryUsed", "gpu_memory_mb")),)
        ),
        "gpu_memory_total_mb": _first_number(
            ((app, ("gpuMemoryTotal", "gpuMemoryTotalMB", "gpu_memory_total_mb")),)
        ),
        "gpu_memory_free_mb": _first_number(
            ((app, ("gpuMemoryFree", "gpuMemoryFreeMB", "gpu_memory_free_mb")),)
        ),
    }
    performance["available"] = any(
        value is not None for key, value in performance.items() if key != "available"
    )
    return performance


def _health_touchdesigner_info():
    raw = get_info()
    info = {}
    for key, value in raw.items():
        if value is not None:
            info[key] = _jsonable(value)
    return info


def menu_value_error(par, value):
    """Error string when `par` is a fixed Menu whose value is invalid, else None.

    A TouchDesigner Menu par silently coerces an unrecognized value to index 0 — a
    confusing no-op that looks like success. Validate against its menuNames/
    menuLabels and surface an explicit error listing the valid entries instead.
    Only the fixed `Menu` style is restricted; `StrMenu` accepts arbitrary strings
    by design, so it is never rejected here.
    """
    if getattr(par, "style", None) != "Menu":
        return None
    names = list(getattr(par, "menuNames", None) or [])
    labels = list(getattr(par, "menuLabels", None) or [])
    if not names:
        return None  # menu list unavailable — cannot validate, so don't block
    if str(value) in names or str(value) in labels:
        return None
    return "%r is not a valid menu value (valid: %s)" % (value, ", ".join(names))


def _apply_one_param(node, key, value):
    """Set one parameter; return None on success or a human error reason."""
    par = getattr(node.par, key, None)
    if par is None:
        return "unknown parameter name"
    menu_err = menu_value_error(par, value)
    if menu_err is not None:
        return menu_err
    try:
        par.val = value
    except Exception as exc:  # noqa: BLE001
        return "could not set value (%s)" % exc
    return None


def apply_parameters(node, parameters):
    """Apply {name: value} params; return (applied_names, failures).

    `failures` is a list of {"name", "reason"} — an unknown name, an invalid Menu
    value (would otherwise be silently coerced), or a set that raised. Good params
    are applied even when a sibling fails, so the caller can report per-param.
    """
    applied, failures = [], []
    for key, value in (parameters or {}).items():
        reason = _apply_one_param(node, key, value)
        if reason is None:
            applied.append(key)
        else:
            failures.append({"name": key, "reason": reason})
    return applied, failures


def _existing_child(parent, name):
    """Return the existing direct child named `name`, or None.

    Only meaningful when a name was requested — without one TD auto-generates a
    unique name, so there is nothing to collide with. `parent.op(name)` resolves a
    child by relative name and returns None when absent.
    """
    if not name:
        return None
    return parent.op(name)


def _create_or_reuse(parent, cls, type_name, name, parent_path):
    """Create the operator, or reuse an identically-named+typed one already there.

    Idempotent: re-issuing the same create (e.g. an agent retry) returns the
    existing node with `already_existed=True` instead of failing or letting TD
    auto-rename to `<name>1`. A name collision with a DIFFERENT type is an explicit
    error — we never silently replace or rename an operator the artist may rely on.
    """
    existing = _existing_child(parent, name)
    if existing is None:
        node = parent.create(cls, name) if name else parent.create(cls)
        return node, False
    actual = op_type(existing)
    if actual != type_name:
        raise ValueError(
            "Name collision: %r already exists at %s as a %s, not a %s. "
            "Rename or delete it, or choose a different name."
            % (name, parent_path, actual or "unknown type", type_name)
        )
    return existing, True


def create_node(parent_path, type_name, name=None, parameters=None):
    parent = op(parent_path)  # noqa: F821 - TD global
    if parent is None:
        raise LookupError("Parent not found: %s" % parent_path)
    cls = _resolve_type(type_name)
    node, already_existed = _create_or_reuse(parent, cls, type_name, name, parent_path)
    ref = node_ref(node)
    if already_existed:
        ref["already_existed"] = True
    if parameters:
        # The node is created regardless; surface any params that did not apply
        # (unknown name or bad value) as a non-fatal warning rather than dropping
        # them silently. The caller (create_td_node) relays these to the user.
        _applied, failures = apply_parameters(node, parameters)
        if failures:
            ref["parameter_warnings"] = sorted(f["name"] for f in failures)
    return ref


def delete_node(path, mode="delete"):
    """Remove a node, or (mode='bypass') just bypass it — a safer, reversible middle ground.

    'bypass' sets the operator's bypass flag instead of destroying it, so the artist can
    re-enable it with one click; 'delete' (default) destroys it as before.
    """
    node = op(path)  # noqa: F821
    if node is None:
        raise LookupError("Node not found: %s" % path)
    if mode == "bypass":
        node.bypass = True
        return {"bypassed": path, "mode": "bypass"}
    if mode != "delete":
        raise ValueError("Unknown delete mode %r (expected 'delete' or 'bypass')." % mode)
    node.destroy()
    return {"deleted": path, "mode": "delete"}


def get_nodes(parent_path=None):
    parent = op(parent_path or "/")  # noqa: F821
    if parent is None:
        raise LookupError("Parent not found: %s" % parent_path)
    children = parent.findChildren(depth=1) if hasattr(parent, "findChildren") else []
    return {"nodes": [node_ref(c) for c in children]}


def _flags(node):
    out = {}
    for attr in ("bypass", "render", "display", "lock", "allowCooking", "cloneImmune"):
        try:
            v = getattr(node, attr)
            if isinstance(v, bool):
                out[attr] = v
        except Exception:  # noqa: BLE001
            pass
    # clone is COMP-only and lives on .par.clone (path to master), NOT op.clone.
    try:
        if hasattr(node, "isClone"):
            out["is_clone"] = bool(node.isClone)
    except Exception:  # noqa: BLE001
        pass
    try:
        cp = getattr(node.par, "clone", None)
        if cp is not None:
            cv = cp.eval()
            out["clone"] = str(cv) if cv else None
    except Exception:  # noqa: BLE001
        pass
    return out


def _indexed_inputs(node):
    # Faithful, index-aware: iterate inputConnectors (NOT node.inputs, which omits empty
    # slots). Each wire => {in_index, from, out_index}. Multi-input TOPs pack contiguously,
    # so the indices reported are the live/current ones.
    wires = []
    try:
        for ic in node.inputConnectors:
            try:
                in_index = ic.index
            except Exception:  # noqa: BLE001
                in_index = None
            try:
                conns = list(ic.connections)
            except Exception:  # noqa: BLE001
                conns = []
            for oc in conns:
                try:
                    wires.append(
                        {"in_index": in_index, "from": oc.owner.path, "out_index": oc.index}
                    )
                except Exception:  # noqa: BLE001
                    pass
    except Exception:  # noqa: BLE001
        pass
    return wires


def _node_parameters(node):
    pars = {}
    try:
        for par in node.pars():
            try:
                pars[par.name] = _jsonable(par.eval())
            except Exception:  # noqa: BLE001
                pars[par.name] = None
    except Exception:  # noqa: BLE001
        pars = {}
    return pars


def _node_errors(node):
    try:
        err = node.errors(recurse=False)
        return [str(err)] if err else []
    except Exception:  # noqa: BLE001
        return None


def _node_optional_attrs(node):
    detail = {}
    try:
        detail["nodeX"] = node.nodeX
        detail["nodeY"] = node.nodeY
    except Exception:  # noqa: BLE001
        pass
    try:
        if node.comment:
            detail["comment"] = node.comment
    except Exception:  # noqa: BLE001
        pass
    try:
        detail["color"] = list(node.color)  # tuple -> JSON list
    except Exception:  # noqa: BLE001
        pass
    try:
        if node.tags:
            detail["tags"] = sorted(str(t) for t in node.tags)  # set -> sorted list
    except Exception:  # noqa: BLE001
        pass
    return detail


def node_detail(node):
    inputs = [c.path for c in getattr(node, "inputs", []) if c]
    outputs = [c.path for c in getattr(node, "outputs", []) if c]
    detail = node_ref(node)
    detail.update(
        {
            "parameters": _node_parameters(node),
            "inputs": inputs,
            "outputs": outputs,
            "flags": _flags(node),
            "wires_in": _indexed_inputs(node),
        }
    )
    # op.errors() returns a STRING (not a list) — wrap it so a multi-line message is
    # ONE entry, never iterated char-by-char.
    errors = _node_errors(node)
    if errors is not None:
        detail["errors"] = errors
    detail.update(_node_optional_attrs(node))
    return detail


def get_node(path):
    node = op(path)  # noqa: F821
    if node is None:
        raise LookupError("Node not found: %s" % path)
    return node_detail(node)


def update_parameters(path, parameters):
    node = op(path)  # noqa: F821
    if node is None:
        raise LookupError("Node not found: %s" % path)
    params = parameters or {}
    # Reject unknown parameter names up front (atomic: apply nothing) so a typo
    # like `gain` on a levelTOP fails loudly instead of being silently dropped.
    unknown = [k for k in params if getattr(node.par, k, None) is None]
    if unknown:
        raise ValueError(
            "Unknown parameter(s) on %s (%s): %s. "
            "Use get_td_node_parameters to see the valid parameter names."
            % (path, op_type(node), ", ".join(sorted(unknown)))
        )
    applied, failures = apply_parameters(node, params)
    if failures:
        details = "; ".join(
            "%s (%s)" % (f["name"], f["reason"])
            for f in sorted(failures, key=lambda f: f["name"])
        )
        raise ValueError(
            "Could not set parameter(s) on %s (%s): %s. Applied: %s."
            % (path, op_type(node), details, ", ".join(sorted(applied)) or "none")
        )
    return node_detail(node)


def exec_script(script, return_output=True):
    buf = io.StringIO()
    # Seed the exec namespace with the full TD namespace (op, ParMode, operator
    # classes, …) so scripts behave like they would in a DAT/Textport.
    namespace = dict(vars(td))
    namespace["op"] = op
    try:
        with redirect_stdout(buf):
            exec(script, namespace)  # noqa: S102 - intentional, runs inside TD
    except Exception:  # noqa: BLE001
        raise RuntimeError(traceback.format_exc())
    result = {"stdout": buf.getvalue() if return_output else ""}
    if namespace.get("result") is not None:
        result["result"] = _jsonable(namespace["result"])
    return result


def call_method(path, method, args=None, kwargs=None):
    node = op(path)  # noqa: F821
    if node is None:
        raise LookupError("Node not found: %s" % path)
    fn = getattr(node, method, None)
    if not callable(fn):
        raise AttributeError("%s has no callable method %s" % (path, method))
    value = fn(*(args or []), **(kwargs or {}))
    return {"result": _jsonable(value)}


def get_node_errors(path, recursive=False):
    node = op(path)  # noqa: F821
    if node is None:
        return {"errors": []}
    targets = [node]
    if recursive and hasattr(node, "findChildren"):
        targets += node.findChildren()
    out = []
    for target in targets:
        for kind in ("errors", "warnings"):
            try:
                fn = getattr(target, kind)
                text = fn(recurse=False) if callable(fn) else fn
            except Exception:  # noqa: BLE001
                text = ""
            if text:
                out.append({"path": target.path, "message": text, "type": kind[:-1]})
    return {"errors": out}


def get_info():
    info = {"python_version": sys.version.split()[0]}
    try:
        info["td_version"] = app.version  # noqa: F821
    except Exception:  # noqa: BLE001
        pass
    try:
        info["build"] = app.build  # noqa: F821
    except Exception:  # noqa: BLE001
        pass
    try:
        info["project"] = project.name  # noqa: F821
    except Exception:  # noqa: BLE001
        pass
    try:
        from utils.version import BRIDGE_VERSION

        info["bridge_version"] = BRIDGE_VERSION
    except Exception:  # noqa: BLE001
        info["bridge_version"] = "unknown"
    return info


def get_health(webserver=None):
    global _LAST_HEALTH_AT
    now = datetime.now(timezone.utc)
    timestamp = _iso_utc(now)
    last_seen_at = _LAST_HEALTH_AT
    heartbeat_age_seconds = round(max(0.0, (now - last_seen_at).total_seconds()), 3)
    heartbeat_stale = heartbeat_age_seconds > _HEARTBEAT_STALE_AFTER_SECONDS
    _LAST_HEALTH_AT = now
    info = _health_touchdesigner_info()
    performance = _health_performance(webserver)
    degraded_signals = []
    warnings = []

    if not any(info.get(key) for key in ("td_version", "build", "project")):
        degraded_signals.append("touchdesigner")
        warnings.append("TouchDesigner app/project metadata is unavailable.")
    if not performance["available"]:
        degraded_signals.append("performance")
        warnings.append("Optional TouchDesigner performance metrics are unavailable.")

    state = "degraded" if degraded_signals else "ok"
    return {
        "state": state,
        "status": state,
        "timestamp": timestamp,
        "started_at": _iso_utc(_STARTED_AT),
        "uptime_seconds": round(max(0.0, time.monotonic() - _STARTED_MONOTONIC), 3),
        "heartbeat": {
            "last_seen_at": _iso_utc(last_seen_at),
            "age_seconds": heartbeat_age_seconds,
            "stale": heartbeat_stale,
            "stale_after_seconds": _HEARTBEAT_STALE_AFTER_SECONDS,
        },
        "touchdesigner": info,
        "performance": performance,
        "degraded_signals": degraded_signals,
        "warnings": warnings,
    }
