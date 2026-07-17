"""Param-mode + DAT-text endpoints with controller-enforced code authorization.

Promote parameter-mode and DAT-text operations off `/api/exec`. Constant,
reset, unbind, and reads survive exec-off; the controller rejects caller-supplied
expression/bind and DAT source text unless code execution is explicitly enabled.

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
import os
import tempfile

import td

from mcp.services import api_service

# TouchDesigner injects globals (op, ParMode, operator classes) only into
# DAT/Textport scope, not into imported modules — so reach them via `td`.
op = td.op

_SOURCE_LANGUAGES = {
    "python": (".py", "python"),
    "glsl": (".glsl", "glsl"),
    "text": (".txt", "text"),
    "json": (".json", "json"),
}
_LANGUAGE_BY_EXTENSION = {ext: name for name, (ext, _td_name) in _SOURCE_LANGUAGES.items()}
_UTF8_BOM = b"\xef\xbb\xbf"


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


def _write_expression(par, param, mode_cls, expr, _value):
    if not expr:
        raise ValueError("expr is required for mode 'expression' (param %s)" % param)
    par.expr = expr
    par.mode = mode_cls.EXPRESSION


def _write_bind(par, param, mode_cls, expr, _value):
    if not expr:
        raise ValueError("expr is required for mode 'bind' (param %s)" % param)
    par.bindExpr = expr
    par.mode = mode_cls.BIND


def _write_constant_mode(par, param, mode_cls, _expr, value):
    _write_constant(par, param, value, mode_cls)


def _write_reset(par, _param, mode_cls, _expr, _value):
    reset = getattr(par, "reset", None)
    if callable(reset):
        reset()
        return
    if hasattr(par, "default"):
        par.val = par.default
    par.expr = ""
    par.bindExpr = ""
    par.mode = mode_cls.CONSTANT


def _write_unbind(par, _param, mode_cls, _expr, _value):
    par.val = par.eval()
    par.mode = mode_cls.CONSTANT


_MODE_WRITERS = {
    "expression": _write_expression,
    "bind": _write_bind,
    "constant": _write_constant_mode,
    "reset": _write_reset,
    "unbind": _write_unbind,
}


def _write_param_mode(par, param, norm, mode_cls, expr=None, value=None):
    writer = _MODE_WRITERS.get(norm)
    if writer is None:
        raise ValueError(
            "Unknown mode %r (expected expression|bind|constant|reset|unbind)" % norm
        )
    writer(par, param, mode_cls, expr, value)


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
    """Set one parameter's mode to expression/bind/constant/reset/unbind.

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


def _require_dat(path):
    node = op(path)  # noqa: F821 - TD global
    if node is None:
        raise LookupError("Node not found: %s" % path)
    if not getattr(node, "isDAT", False):
        raise ValueError("%s is not a DAT." % path)
    return node


def _par_value(par):
    if par is None:
        return None
    try:
        return par.eval()
    except Exception:  # noqa: BLE001
        return getattr(par, "val", None)


def _source_pars(node):
    pars = getattr(node, "par", None)
    return {
        name: getattr(pars, name, None) if pars is not None else None
        for name in ("file", "syncfile", "language")
    }


def _project_root():
    folder = getattr(getattr(td, "project", None), "folder", None)
    if not folder:
        raise RuntimeError("TouchDesigner project folder is unavailable.")
    return os.path.realpath(str(folder))


def _safe_source_path(relative_path, create_parent=False):
    if not isinstance(relative_path, str) or not relative_path.strip():
        raise ValueError("source_path must be a non-empty project-relative path.")
    if any(ch in relative_path for ch in ("\x00", "\n", "\r")):
        raise ValueError("source_path contains an invalid control character.")
    normalized = relative_path.replace("\\", "/")
    if normalized.startswith("/") or os.path.isabs(normalized):
        raise ValueError("source_path must be relative to the TouchDesigner project folder.")
    parts = [part for part in normalized.split("/") if part not in ("", ".")]
    if not parts or any(part == ".." for part in parts):
        raise ValueError("source_path traversal is not allowed.")
    relative = "/".join(parts)
    root = _project_root()
    candidate = os.path.realpath(os.path.join(root, *parts))
    try:
        contained = os.path.commonpath([root, candidate]) == root
    except ValueError:
        contained = False
    if not contained:
        raise ValueError("source_path escapes the TouchDesigner project folder.")
    parent = os.path.dirname(candidate)
    if create_parent:
        os.makedirs(parent, exist_ok=True)
        if os.path.commonpath([root, os.path.realpath(parent)]) != root:
            raise ValueError("source_path parent escapes through a symlink.")
    return relative, candidate


def _decode_source(raw):
    has_bom = raw.startswith(_UTF8_BOM)
    body = raw[len(_UTF8_BOM) :] if has_bom else raw
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("Source file must be valid UTF-8: %s" % exc)
    newline = "crlf" if b"\r\n" in body else "lf"
    return text, ("utf8" if has_bom else "none"), newline


def _encode_source(text, newline, bom):
    normalized = str(text).replace("\r\n", "\n").replace("\r", "\n")
    if newline == "crlf":
        normalized = normalized.replace("\n", "\r\n")
    raw = normalized.encode("utf-8")
    return (_UTF8_BOM + raw) if bom == "utf8" else raw


def _source_metadata(node, require_file=False):
    pars = _source_pars(node)
    file_value = _par_value(pars["file"])
    sync_value = bool(_par_value(pars["syncfile"]))
    if not file_value or not sync_value:
        if require_file:
            raise ValueError("DAT is not linked to a synced project source file.")
        return None
    relative, absolute = _safe_source_path(str(file_value))
    if not os.path.isfile(absolute):
        if require_file:
            raise ValueError("Synced DAT source file does not exist: %s" % relative)
        return None
    return relative, absolute, pars


def _resolve_language(source_path, language):
    extension = os.path.splitext(source_path)[1].lower()
    inferred = _LANGUAGE_BY_EXTENSION.get(extension)
    chosen = language or inferred or "text"
    if chosen not in _SOURCE_LANGUAGES:
        raise ValueError("language must be one of: %s" % ", ".join(sorted(_SOURCE_LANGUAGES)))
    expected_extension = _SOURCE_LANGUAGES[chosen][0]
    if language and extension and extension != expected_extension:
        raise ValueError(
            "source_path extension %s does not match language %s (%s)."
            % (extension, chosen, expected_extension)
        )
    return chosen, _SOURCE_LANGUAGES[chosen][1]


def _snapshot_source_pars(pars):
    return {name: _par_value(par) for name, par in pars.items() if par is not None}


def _restore_source_pars(pars, snapshot):
    for name, value in snapshot.items():
        par = pars.get(name)
        if par is not None:
            par.val = value


def _atomic_source_write(node, source_path, text, language=None, newline="preserve", bom="preserve"):
    if newline not in ("preserve", "lf", "crlf"):
        raise ValueError("newline must be preserve, lf, or crlf.")
    if bom not in ("preserve", "none", "utf8"):
        raise ValueError("bom must be preserve, none, or utf8.")
    relative, absolute = _safe_source_path(source_path, create_parent=True)
    chosen_language, td_language = _resolve_language(relative, language)
    previous = None
    old_text = ""
    old_bom = "none"
    old_newline = "lf"
    if os.path.isfile(absolute):
        with open(absolute, "rb") as source:
            previous = source.read()
        old_text, old_bom, old_newline = _decode_source(previous)
    resolved_newline = old_newline if newline == "preserve" else newline
    resolved_bom = old_bom if bom == "preserve" else bom
    payload = _encode_source(text, resolved_newline, resolved_bom)
    pars = _source_pars(node)
    if pars["file"] is None or pars["syncfile"] is None:
        raise ValueError("DAT does not expose file/syncfile parameters required for source sync.")
    par_snapshot = _snapshot_source_pars(pars)
    temp_path = None
    warnings = []
    try:
        with tempfile.NamedTemporaryFile("wb", dir=os.path.dirname(absolute), delete=False) as tmp:
            temp_path = tmp.name
            tmp.write(payload)
        os.replace(temp_path, absolute)
        temp_path = None
        pars["file"].val = relative
        pars["syncfile"].val = True
        if pars["language"] is not None:
            pars["language"].val = td_language
        else:
            warnings.append("DAT language parameter is unavailable; source language was not assigned.")
    except Exception:
        if temp_path and os.path.exists(temp_path):
            os.unlink(temp_path)
        if previous is None:
            if os.path.exists(absolute):
                os.unlink(absolute)
        else:
            with open(absolute, "wb") as source:
                source.write(previous)
        _restore_source_pars(pars, par_snapshot)
        raise
    return {
        "path": node.path,
        "old_length": len(old_text),
        "new_length": len(str(text)),
        "file_synced": True,
        "source_path": relative,
        "language": chosen_language,
        "newline": resolved_newline,
        "bom": resolved_bom,
        "warnings": warnings,
    }


def get_dat_text(path):
    """Return {path, text, is_table, num_rows, num_cols} for a DAT.

    Raises LookupError if the node is missing, ValueError if it is not a DAT.
    """
    node = _require_dat(path)
    result = {
        "path": path,
        "text": node.text,
        "is_table": bool(getattr(node, "isTable", False)),
        "num_rows": int(getattr(node, "numRows", 0) or 0),
        "num_cols": int(getattr(node, "numCols", 0) or 0),
        "file_synced": False,
        "warnings": [],
    }
    try:
        source = _source_metadata(node)
        if source is not None:
            relative, absolute, pars = source
            with open(absolute, "rb") as handle:
                text, bom, newline = _decode_source(handle.read())
            result.update(
                {
                    "text": text,
                    "file_synced": True,
                    "source_path": relative,
                    "language": str(_par_value(pars["language"]) or ""),
                    "newline": newline,
                    "bom": bom,
                }
            )
    except ValueError as exc:
        result["warnings"].append(str(exc))
    return result


def put_dat_text(path, text, source_path=None, language=None, newline="preserve", bom="preserve"):
    """Overwrite a DAT's whole `.text`. Returns {path, old_length, new_length}.

    Raises LookupError if the node is missing, ValueError if it is not a DAT.
    """
    node = _require_dat(path)
    if source_path is not None:
        return _atomic_source_write(node, source_path, text, language, newline, bom)
    old_length = len(node.text)
    node.text = text
    return {
        "path": path,
        "old_length": old_length,
        "new_length": len(text),
        "file_synced": False,
        "warnings": [],
    }


def edit_dat_text(path, old_string, new_string, replace_all=False, source="auto"):
    """Replace text atomically in the DAT or its safe project-backed source file."""
    if not old_string:
        raise ValueError("old_string must not be empty.")
    if source not in ("auto", "dat", "file"):
        raise ValueError("source must be auto, dat, or file.")
    node = _require_dat(path)
    source_info = None if source == "dat" else _source_metadata(node, require_file=source == "file")
    if source_info is not None:
        relative, absolute, pars = source_info
        with open(absolute, "rb") as handle:
            current, current_bom, current_newline = _decode_source(handle.read())
        current_language = _LANGUAGE_BY_EXTENSION.get(os.path.splitext(relative)[1].lower())
    else:
        current = node.text
        current_bom = "none"
        current_newline = "lf"
        current_language = None
    occurrences = current.count(old_string)
    if occurrences == 0:
        raise ValueError("old_string not found in %s." % path)
    if occurrences > 1 and not replace_all:
        raise ValueError(
            "old_string matches %d times in %s; pass replace_all:true or add context."
            % (occurrences, path)
        )
    replacements = occurrences if replace_all else 1
    updated = current.replace(old_string, new_string, -1 if replace_all else 1)
    if source_info is not None:
        write = _atomic_source_write(
            node,
            relative,
            updated,
            current_language,
            current_newline,
            current_bom,
        )
    else:
        write = put_dat_text(path, updated)
    write.update(
        {
            "dat": path,
            "occurrences": occurrences,
            "replacements": replacements,
            "replace_all": bool(replace_all),
        }
    )
    return write
