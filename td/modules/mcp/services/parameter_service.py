"""Structured parameter actions that do not require ``/api/exec``."""

import math
import re

_MAX_OP_PATH = 1024
_MAX_PARAMETER_NAME = 128
_PAR_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_MAX_MENU_ITEMS = 64
_MAX_MENU_TEXT = 256
_MAX_SEQUENCES = 64
_MAX_SEQUENCE_PARAMETERS = 2048
_MAX_SEQUENCE_BLOCKS = 256


def _validate_path(path):
    if not isinstance(path, str) or not path.startswith("/"):
        raise ValueError("pulse: path must be an absolute TouchDesigner operator path")
    if len(path) > _MAX_OP_PATH or "\x00" in path or "\n" in path or "\r" in path:
        raise ValueError("pulse: invalid operator path")
    return path


def _validate_parameter_name(parameter):
    if not isinstance(parameter, str) or not _PAR_NAME.fullmatch(parameter):
        raise ValueError("pulse: parameter must be a valid parameter name")
    if len(parameter) > _MAX_PARAMETER_NAME:
        raise ValueError("pulse: parameter name exceeds %d characters" % _MAX_PARAMETER_NAME)
    return parameter


def _style_name(par):
    try:
        style = par.style
    except Exception as exc:  # noqa: BLE001
        raise TypeError("pulse: could not read parameter style: %s" % exc)
    raw = getattr(style, "name", None) or str(style)
    return str(raw).rsplit(".", 1)[-1]


def _resolve_parameter(path, parameter):
    import td

    path = _validate_path(path)
    parameter = _validate_parameter_name(parameter)
    node = td.op(path)
    if node is None:
        raise LookupError("parameter: operator not found: %s" % path)
    par_collection = getattr(node, "par", None)
    par = getattr(par_collection, parameter, None) if par_collection is not None else None
    if par is None:
        raise KeyError("parameter: parameter not found: %s on %s" % (parameter, path))
    return node, par, parameter


def _bounded_menu(values):
    return [str(value)[:_MAX_MENU_TEXT] for value in list(values or [])[:_MAX_MENU_ITEMS]]


def read_parameter_menu(path, parameter):
    """Read one parameter's bounded live menu metadata without arbitrary exec."""
    node, par, parameter = _resolve_parameter(path, parameter)
    names = _bounded_menu(getattr(par, "menuNames", None))
    labels = _bounded_menu(getattr(par, "menuLabels", None))
    try:
        current = str(par.eval())[:_MAX_MENU_TEXT]
    except Exception:  # noqa: BLE001
        current = None
    return {
        "path": node.path,
        "parameter": parameter,
        "style": _style_name(par),
        "names": names,
        "labels": labels,
        "current": current,
    }


def pulse_parameter(path, parameter):
    """Validate and pulse exactly one Pulse parameter.

    Missing operators, missing parameters and incorrect parameter styles use
    distinct exception types so the controller can preserve typed error codes.
    """
    node, par, parameter = _resolve_parameter(path, parameter)

    style = _style_name(par)
    if style.lower() != "pulse":
        raise TypeError(
            "pulse: parameter %s on %s has style %s, expected Pulse"
            % (parameter, path, style)
        )
    pulse = getattr(par, "pulse", None)
    if not callable(pulse):
        raise TypeError("pulse: Pulse parameter %s has no callable pulse()" % parameter)
    try:
        pulse()
    except Exception as exc:  # noqa: BLE001
        raise ValueError("pulse: %s on %s failed: %s" % (parameter, path, exc))

    return {"path": node.path, "parameter": parameter, "style": style, "pulsed": True}


def _json_safe(value):
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    try:
        path = getattr(value, "path", None)
        if path is not None:
            return str(path)
    except Exception:  # noqa: BLE001
        pass
    return str(value)


def _mode_name(par):
    raw = getattr(par, "mode", None)
    name = getattr(raw, "name", None)
    return str(name or raw or "UNKNOWN").rsplit(".", 1)[-1].upper()


def _resolve_node(path):
    import td

    path = _validate_path(path)
    node = td.op(path)
    if node is None:
        raise LookupError("parameter sequence: operator not found: %s" % path)
    return node


def _sequence_map(node):
    found = {}
    for par in list(node.pars() or []):
        sequence = getattr(par, "sequence", None)
        if sequence is None or getattr(sequence, "owner", None) is not node:
            continue
        name = str(getattr(sequence, "name", "") or "")
        if name and name not in found:
            found[name] = sequence
    return found


def _sequence_parameter_entry(par):
    try:
        value = _json_safe(par.eval())
    except Exception as exc:  # noqa: BLE001
        value = None
        warning = "Could not evaluate %s: %s" % (getattr(par, "name", ""), exc)
    else:
        warning = None
    entry = {
        "name": str(getattr(par, "name", "")),
        "value": value,
        "mode": _mode_name(par),
    }
    return entry, warning


def read_parameter_sequences(path):
    """Return bounded, deterministic sequence metadata for one operator."""
    node = _resolve_node(path)
    sequence_map = _sequence_map(node)
    names = sorted(sequence_map)[:_MAX_SEQUENCES]
    members = {name: [] for name in names}
    warnings = []
    total = 0
    truncated = len(sequence_map) > len(names)
    for par in sorted(list(node.pars() or []), key=lambda item: str(getattr(item, "name", ""))):
        sequence = getattr(par, "sequence", None)
        name = str(getattr(sequence, "name", "") or "") if sequence is not None else ""
        if name not in members:
            continue
        if total >= _MAX_SEQUENCE_PARAMETERS:
            truncated = True
            break
        entry, warning = _sequence_parameter_entry(par)
        members[name].append(entry)
        if warning:
            warnings.append(warning)
        total += 1
    return {
        "path": node.path,
        "sequences": [
            {
                "name": name,
                "num_blocks": int(getattr(sequence_map[name], "numBlocks", 0) or 0),
                "parameters": members[name],
            }
            for name in names
        ],
        "truncated": truncated,
        "warnings": warnings[:64],
    }


def _snapshot_par(par):
    return {
        "raw_value": getattr(par, "val", None),
        "mode": getattr(par, "mode", None),
        "expr": getattr(par, "expr", ""),
        "bind_expr": getattr(par, "bindExpr", ""),
    }


def _restore_par(par, snapshot):
    par.val = snapshot["raw_value"]
    if hasattr(par, "expr"):
        par.expr = snapshot["expr"]
    if hasattr(par, "bindExpr"):
        par.bindExpr = snapshot["bind_expr"]
    if snapshot["mode"] is not None:
        par.mode = snapshot["mode"]


def _sequence_members(node, sequence_names):
    members = {}
    for par in list(node.pars() or []):
        sequence = getattr(par, "sequence", None)
        name = str(getattr(sequence, "name", "") or "") if sequence is not None else ""
        if name in sequence_names:
            members[str(getattr(par, "name", ""))] = _snapshot_par(par)
    return members


def _validate_sequence_counts(sequence_map, requested):
    if not isinstance(requested, dict):
        raise ValueError("sequences must be a JSON object.")
    unknown = sorted(set(requested) - set(sequence_map))
    if unknown:
        raise ValueError("Unknown parameter sequence(s): %s" % ", ".join(unknown))
    normalized = {}
    for name, count in requested.items():
        if isinstance(count, bool) or not isinstance(count, int):
            raise ValueError("Sequence %s block count must be an integer." % name)
        if count < 1 or count > _MAX_SEQUENCE_BLOCKS:
            raise ValueError(
                "Sequence %s block count must be between 1 and %d."
                % (name, _MAX_SEQUENCE_BLOCKS)
            )
        normalized[name] = count
    return normalized


def _validate_constant_parameter(node, name, value, allowed_sequences):
    par = getattr(getattr(node, "par", None), name, None)
    if par is None:
        raise ValueError("Unknown parameter after sequence resize: %s" % name)
    sequence = getattr(par, "sequence", None)
    sequence_name = str(getattr(sequence, "name", "") or "") if sequence else ""
    if (
        sequence is None
        or getattr(sequence, "owner", None) is not node
        or sequence_name not in allowed_sequences
    ):
        raise ValueError(
            "Parameter %s is not a member of a requested parameter sequence." % name
        )
    if isinstance(value, dict):
        raise ValueError(
            "Sequence lifecycle accepts constant values only; expression/bind objects are not allowed (%s)."
            % name
        )
    if bool(getattr(par, "readOnly", False)):
        raise ValueError("Parameter is read-only: %s" % name)
    if hasattr(par, "enable") and not bool(par.enable):
        raise ValueError("Parameter is disabled: %s" % name)
    style = str(getattr(par, "style", "")).rsplit(".", 1)[-1]
    if style == "Menu":
        names = [str(item) for item in list(getattr(par, "menuNames", None) or [])]
        labels = [str(item) for item in list(getattr(par, "menuLabels", None) or [])]
        if names and str(value) not in names and str(value) not in labels:
            raise ValueError(
                "Invalid menu value for %s: %r (valid: %s)"
                % (name, value, ", ".join(names))
            )
    return par


def _rollback_sequences(node, sequence_counts, parameter_snapshots):
    errors = []
    try:
        current = _sequence_map(node)
        for name, count in sequence_counts.items():
            if name in current:
                current[name].numBlocks = count
    except Exception as exc:  # noqa: BLE001
        errors.append("sequence counts: %s" % exc)
    for name, snapshot in parameter_snapshots.items():
        try:
            par = getattr(getattr(node, "par", None), name, None)
            if par is not None:
                _restore_par(par, snapshot)
        except Exception as exc:  # noqa: BLE001
            errors.append("%s: %s" % (name, exc))
    return errors


def update_parameter_sequences(path, sequences=None, parameters=None):
    """Atomically resize sequences and apply indexed constant parameter values."""
    node = _resolve_node(path)
    requested_sequences = sequences or {}
    requested_parameters = parameters or {}
    if not isinstance(requested_parameters, dict):
        raise ValueError("parameters must be a JSON object.")
    if not requested_sequences and not requested_parameters:
        raise ValueError("Provide at least one sequence resize or parameter value.")
    sequence_map = _sequence_map(node)
    normalized = _validate_sequence_counts(sequence_map, requested_sequences)
    original_counts = {
        name: int(getattr(sequence_map[name], "numBlocks", 0) or 0) for name in normalized
    }
    snapshots = _sequence_members(node, set(normalized))
    for name in requested_parameters:
        par = getattr(getattr(node, "par", None), name, None)
        if par is not None and name not in snapshots:
            snapshots[name] = _snapshot_par(par)
    resized = []
    try:
        for name, count in normalized.items():
            before = original_counts[name]
            sequence_map[name].numBlocks = count
            resized.append({"name": name, "was": before, "num_blocks": count})
        validated = [
            (name, _validate_constant_parameter(node, name, value, set(normalized)), value)
            for name, value in requested_parameters.items()
        ]
        applied = []
        for name, par, value in validated:
            par.val = value
            applied.append({"name": name, "value": _json_safe(par.eval())})
        readback = read_parameter_sequences(path)
        touched = set(normalized)
        return {
            "path": node.path,
            "resized": resized,
            "applied": applied,
            "sequences": [item for item in readback["sequences"] if item["name"] in touched],
            "rolled_back": False,
            "warnings": readback["warnings"],
        }
    except Exception as exc:
        rollback_errors = _rollback_sequences(node, original_counts, snapshots)
        if rollback_errors:
            raise RuntimeError(
                "%s; rollback incomplete: %s" % (exc, "; ".join(rollback_errors[:16]))
            )
        raise ValueError("%s (transaction rolled back)." % exc)
