"""Param-mode + DAT-text endpoints — survive TDMCP_BRIDGE_ALLOW_EXEC=0.

Promote reactive authoring (parameter mode / expression / bind / constant) and
whole-text DAT editing off `/api/exec` so they keep working when arbitrary code
execution is disabled in TouchDesigner.

Pure module of top-level functions taking primitives. `op` is bound from `td`
at import time (mirroring mcp/services/api_service.py) so the module imports
cleanly off-TD and the test harness can patch `op` per-test. Hard failures raise
ValueError / LookupError; the router turns them into the 400 envelope.

ParMode is NOT importable as `td.ParMode` or a bare global (confirmed live —
all three import forms raise). Resolve the enum class from a LIVE parameter:
`ModeCls = type(par.mode)` then `ModeCls.EXPRESSION / .BIND / .CONSTANT /
.EXPORT`. (`tdutils.TDDefinitions.ParMode` is the real home if ever needed.)
This also fixes the latent bug where `_par.mode = ParMode.EXPRESSION` silently
fell into an except branch every time.
"""

import math

import td

from mcp.services import api_service

# TouchDesigner injects globals (op, ParMode, operator classes) only into
# DAT/Textport scope, not into imported modules — so reach them via `td`.
op = td.op


def _json_safe(value):
    """Coerce a parameter value into something json.dumps can serialize."""
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    try:
        _path = getattr(value, "path", None)
        if _path is not None:
            return str(_path)
    except Exception:  # noqa: BLE001
        pass
    try:
        return str(value)
    except Exception:  # noqa: BLE001
        return None


def _normalize_mode(par):
    """Return the UPPER mode name (CONSTANT/EXPRESSION/EXPORT/BIND) for a Par."""
    try:
        _raw = par.mode
    except Exception:  # noqa: BLE001
        return "UNKNOWN"
    if _raw is None:
        return "UNKNOWN"
    # par.mode.name is the clean enum name; fall back to str().split() parsing.
    name = getattr(_raw, "name", None)
    if name:
        return str(name).upper()
    return str(_raw).split(".")[-1].upper()


def _param_entry(par, non_default_only=False):
    pname = par.name
    mode = _normalize_mode(par)
    if non_default_only and mode == "CONSTANT":
        return None, None
    entry = {"name": pname, "mode": mode}
    warnings = []
    try:
        entry["value"] = _json_safe(par.eval())
    except Exception as exc:  # noqa: BLE001
        warnings.append("Could not eval %s: %s" % (pname, exc))
    try:
        expr = par.expr
        if expr:
            entry["expr"] = str(expr)
    except Exception:  # noqa: BLE001
        pass
    try:
        bind_expr = getattr(par, "bindExpr", "")
        if bind_expr:
            entry["bind_expr"] = str(bind_expr)
    except Exception:  # noqa: BLE001
        pass
    try:
        export_op = par.exportOP
        if export_op is not None:
            entry["export_op"] = export_op.path
    except Exception:  # noqa: BLE001
        pass
    return entry, warnings


def read_param_modes(path, keys=None, non_default_only=False):
    """Report each parameter's mode + value + expression strings.

    Returns {path, type, name, parameters:[{name, mode, value?, expr?,
    bind_expr?, export_op?}], warnings}. Raises LookupError if the node is
    missing so the router answers 400.
    """
    node = op(path)  # noqa: F821 - TD global
    if node is None:
        raise LookupError("Node not found: %s" % path)
    report = {
        "path": path,
        "type": getattr(node, "type", "") or "",
        "name": getattr(node, "name", "") or "",
        "parameters": [],
        "warnings": [],
    }
    _keys = set(keys) if keys else None
    for par in node.pars():
        try:
            pname = par.name
            if _keys is not None and pname not in _keys:
                continue
            entry, warnings = _param_entry(par, non_default_only)
            report["warnings"].extend(warnings or [])
            if entry is None:
                continue
            report["parameters"].append(entry)
        except Exception as exc:  # noqa: BLE001
            report["warnings"].append("Error reading parameter: %s" % exc)
    return report


def read_param_modes_batch(items, continue_on_error=True):
    """Batched wrapper over read_param_modes — one round-trip for N nodes.

    Promotes multi-node parameter-mode inspection from N HTTP calls to 1 by
    looping the singular ``read_param_modes`` per item. Per-item failures
    (missing node, eval explosion) are isolated as a structured ``error`` field
    so one bad path never poisons the rest. Cap at 256 items to protect the
    bridge from runaway payloads.

    Args:
        items: list of ``{path, keys?, non_default_only?}`` dicts.
        continue_on_error: when False, the first item failure aborts the batch.

    Returns ``{items: [<same shape as read_param_modes>, ...]}``.
    """
    if not isinstance(items, list):
        raise ValueError("'items' must be a JSON array.")
    if len(items) > 256:
        raise ValueError("Too many items (max 256, got %d)." % len(items))
    out = []
    for raw in items:
        if not isinstance(raw, dict):
            raise ValueError("Each item must be a JSON object.")
        path = raw.get("path")
        keys = raw.get("keys")
        ndo = bool(raw.get("non_default_only", False))
        try:
            out.append(read_param_modes(path, keys=keys, non_default_only=ndo))
        except Exception as exc:  # noqa: BLE001
            if not continue_on_error:
                raise
            out.append(
                {
                    "path": path or "",
                    "type": "",
                    "name": "",
                    "parameters": [],
                    "warnings": [],
                    "error": str(exc),
                }
            )
    return {"items": out}


def _write_param_mode(par, param, norm, mode_cls, expr=None, value=None):
    if norm == "expression":
        if not expr:
            raise ValueError("expr is required for mode 'expression' (param %s)" % param)
        par.expr = expr
        par.mode = mode_cls.EXPRESSION
        return
    if norm == "bind":
        if not expr:
            raise ValueError("expr is required for mode 'bind' (param %s)" % param)
        par.bindExpr = expr
        par.mode = mode_cls.BIND
        return
    if norm == "constant":
        _write_constant(par, param, value, mode_cls)
        return
    raise ValueError("Unknown mode %r (expected expression|bind|constant)" % norm)


def _write_constant(par, param, value, mode_cls):
    """Set a parameter to a constant value, rejecting invalid fixed-Menu values."""
    if value is None:
        raise ValueError("value is required for mode 'constant' (param %s)" % param)
    menu_err = api_service.menu_value_error(par, value)
    if menu_err is not None:
        raise ValueError("Invalid value for %s: %s" % (param, menu_err))
    par.val = value
    par.mode = mode_cls.CONSTANT


def _readback_expr(par, norm):
    if norm not in ("bind", "expression"):
        return ""
    attr = "bindExpr" if norm == "bind" else "expr"
    try:
        return str(getattr(par, attr, "") or "")
    except Exception:  # noqa: BLE001
        return ""


def set_param_mode(path, param, mode, expr=None, value=None):
    """Set one parameter's mode to expression / bind / constant.

    Uses ModeCls = type(par.mode) for the enum (ParMode is not importable).
    Returns {path, param, mode, readback_mode, readback_expr}. Raises on
    not-found / unknown param / missing expr / bad value.
    """
    node = op(path)  # noqa: F821 - TD global
    if node is None:
        raise LookupError("Node not found: %s" % path)
    par = getattr(node.par, param, None)
    if par is None:
        raise ValueError("No such parameter: %s on %s" % (param, path))

    # Resolve the ParMode enum class from a live parameter — ParMode is NOT a
    # bare global / td.ParMode. This is the robust path AND the bug fix.
    mode_cls = type(par.mode)

    norm = str(mode or "expression").strip().lower()
    _write_param_mode(par, param, norm, mode_cls, expr=expr, value=value)

    # Read back from the attribute that matches the mode just written: bind lives in
    # par.bindExpr, expression in par.expr; a constant has no expression (par.expr may
    # hold a stale one, so report empty rather than something misleading).
    return {
        "path": path,
        "param": param,
        "mode": norm,
        "readback_mode": _normalize_mode(par),
        "readback_expr": _readback_expr(par, norm),
    }


def is_dat(path):
    """True when ``path`` resolves to a DAT. Used to disambiguate the ``…/text``
    route from a node literally named ``text``: the WebServer DAT decodes %2F, so the
    router cannot tell a 'text' endpoint suffix from a 'text' node name by shape."""
    return bool(getattr(op(path), "isDAT", False))  # noqa: F821 - TD global


def get_dat_text(path):
    """Return {path, text, is_table, num_rows, num_cols} for a DAT.

    Raises LookupError if the node is missing, ValueError if it is not a DAT.
    """
    node = op(path)  # noqa: F821 - TD global
    if node is None:
        raise LookupError("Node not found: %s" % path)
    if not getattr(node, "isDAT", False):
        raise ValueError("%s is not a DAT." % path)
    return {
        "path": path,
        "text": node.text,
        "is_table": bool(getattr(node, "isTable", False)),
        "num_rows": int(getattr(node, "numRows", 0) or 0),
        "num_cols": int(getattr(node, "numCols", 0) or 0),
    }


def put_dat_text(path, text):
    """Overwrite a DAT's whole `.text`. Returns {path, old_length, new_length}.

    Raises LookupError if the node is missing, ValueError if it is not a DAT.
    """
    node = op(path)  # noqa: F821 - TD global
    if node is None:
        raise LookupError("Node not found: %s" % path)
    if not getattr(node, "isDAT", False):
        raise ValueError("%s is not a DAT." % path)
    old_length = len(node.text)
    node.text = text
    return {"path": path, "old_length": old_length, "new_length": len(text)}
