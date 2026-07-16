"""Structured parameter actions that do not require ``/api/exec``."""

import re

_MAX_OP_PATH = 1024
_MAX_PARAMETER_NAME = 128
_PAR_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_MAX_MENU_ITEMS = 64
_MAX_MENU_TEXT = 256


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
