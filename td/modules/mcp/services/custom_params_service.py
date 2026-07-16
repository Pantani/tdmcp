"""Structured custom-parameter inspection and transactional lifecycle mutation.

The mutation entry point deliberately uses only allowlisted TouchDesigner Page,
Par and ParGroup APIs.  It is a first-class bridge service and never depends on
``/api/exec`` or ``TDMCP_BRIDGE_ALLOW_EXEC``.

Live contract: TouchDesigner 2025.32820.  ``EXPORT`` remains held because the
probe could not establish a reversible export source contract.  EXPRESSION and
BIND are supported.  ParGroup objects are kept opaque: this module never reads
their truth value (TouchDesigner raises ``tdError`` when that happens).
"""

import copy
import hashlib
import json
import re
import threading
import time


MAX_OPERATIONS = 64
MAX_PARAMS = 64
MAX_MENU_ITEMS = 64
MAX_NAME = 128
MAX_LABEL = 256
MAX_TEXT_VALUE = 2048
MAX_IDEMPOTENCY_KEY = 128
RECEIPT_TTL_SECONDS = 300.0
MAX_RECEIPTS = 128

_STYLE_METHODS = {
    "Float": "appendFloat",
    "Int": "appendInt",
    "Toggle": "appendToggle",
    "Menu": "appendMenu",
    "Str": "appendStr",
    "Pulse": "appendPulse",
    "Header": "appendHeader",
    "OP": "appendOP",
    "TOP": "appendTOP",
    "File": "appendFile",
    "Folder": "appendFolder",
    "XYZW": "appendXYZW",
    "RGBA": "appendRGBA",
    # Legacy styles remain accepted for backwards compatibility.
    "RGB": "appendRGB",
    "XYZ": "appendXYZ",
}
_ACTIONS = {
    "add",
    "edit_parameter",
    "delete_parameter",
    "sort_page",
    "rename_page",
    "delete_page",
}
_OPERATION_FIELDS = {
    "add": {"action", "page", "params"},
    "edit_parameter": {"action", "name", "fields"},
    "delete_parameter": {"action", "name"},
    "sort_page": {"action", "page", "order"},
    "rename_page": {"action", "page", "new_name"},
    "delete_page": {"action", "page"},
}
_EDIT_FIELDS = {
    "label",
    "default",
    "min",
    "max",
    "clamp",
    "value",
    "menu_names",
    "menu_labels",
    "mode",
    "expression",
    "bind_expression",
}
_LOCK = threading.RLock()
_RECEIPTS = {}


class CustomParameterError(Exception):
    """Bounded, typed validation/service error safe for the REST controller."""

    def __init__(self, code, message, *, status="failed"):
        super().__init__(message)
        self.code = code
        self.status = status


def _safe(getter, default=None):
    try:
        return getter()
    except Exception:  # noqa: BLE001
        return default


def _read_options(par):
    """Best-effort menu-options readout. Returns list[str] or None."""
    try:
        labels = getattr(par, "menuLabels", None)
        if labels:
            return [str(label) for label in labels]
        names = getattr(par, "menuNames", None)
        if names:
            return [str(n) for n in names]
    except Exception:  # noqa: BLE001
        pass
    return None


def _read_par(par, warnings):
    """Capture one custom Par's public read metadata."""
    entry = {
        "name": None,
        "label": None,
        "page": None,
        "style": None,
        "default": None,
        "value": None,
        "min": None,
        "max": None,
        "options": None,
    }
    name = _safe(lambda: par.name)
    if not name:
        warnings.append("Skipped a custom par with no readable name.")
        return None
    entry["name"] = name
    entry["label"] = _safe(lambda: par.label) or name
    page = _safe(lambda: par.page)
    if page is not None:
        entry["page"] = _safe(lambda: str(page.name))
    entry["style"] = _style_name(par)
    try:
        entry["default"] = par.default
    except Exception as exc:  # noqa: BLE001
        warnings.append("Could not read default of %s: %s" % (name, exc))
    try:
        entry["value"] = par.eval()
    except Exception as exc:  # noqa: BLE001
        warnings.append("Could not eval %s: %s" % (name, exc))
    entry["min"] = _safe(lambda: par.normMin)
    entry["max"] = _safe(lambda: par.normMax)
    entry["options"] = _read_options(par)
    return entry


def get_custom_params(path):
    """Return the compatible ``{params, warnings}`` readout for ``path``."""
    import td

    report = {"params": [], "warnings": []}
    try:
        node = td.op(path)
    except Exception as exc:  # noqa: BLE001
        report["fatal"] = "Could not resolve %s: %s" % (path, exc)
        return report
    if node is None:
        report["fatal"] = "Node not found: %s" % path
        return report
    custom = getattr(node, "customPars", None)
    if custom is None:
        report["warnings"].append("Node has no customPars attribute: %s" % path)
        return report
    try:
        iter(custom)
    except TypeError:
        report["warnings"].append("customPars not iterable on %s" % path)
        return report
    for par in custom:
        try:
            entry = _read_par(par, report["warnings"])
        except Exception as exc:  # noqa: BLE001
            report["warnings"].append("Failed reading a par on %s: %s" % (path, exc))
            continue
        if entry is not None:
            report["params"].append(entry)
    return report


def _bounded_text(value, field, limit, *, required=True):
    if not isinstance(value, str):
        raise CustomParameterError("invalid_definition", "%s must be a string" % field)
    text = value.strip()
    if required and not text:
        raise CustomParameterError("invalid_definition", "%s must not be empty" % field)
    if len(text) > limit:
        raise CustomParameterError("invalid_definition", "%s exceeds %d characters" % (field, limit))
    return text


def _normalize_page(value):
    page = _bounded_text(value, "page", MAX_NAME)
    return page[0].upper() + page[1:]


def _normalize_par_name(value):
    original = _bounded_text(value, "name", MAX_NAME)
    name = "".join(char for char in original if char.isalnum()) or "Par"
    if not name[0].isalpha():
        name = "P" + name
    return name[0].upper() + name[1:].lower()


def _style_name(par):
    style = _safe(lambda: str(par.style), "")
    return style.rsplit(".", 1)[-1]


def _mode_name(par):
    mode = _safe(lambda: str(par.mode), "CONSTANT")
    return mode.rsplit(".", 1)[-1].upper()


def _portable(value):
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (list, tuple)):
        return [_portable(item) for item in value]
    path = getattr(value, "path", None)
    return str(path) if path is not None else str(value)


def _group_parts(par):
    """Return a component list without ever coercing a ParGroup to bool."""
    group = getattr(par, "parGroup", None)
    if group is None:
        return [par]
    parts = list(group)
    return parts if parts else [par]


def _group_token(par):
    group = getattr(par, "parGroup", None)
    page_name = str(getattr(getattr(par, "page", None), "name", ""))
    if group is None:
        return ("par", page_name, str(getattr(par, "name", "")))
    # ParGroup wrappers, like Connector wrappers, are not identity-stable on
    # live TD builds. Component names within a page are the durable identity.
    return (
        "group",
        page_name,
        tuple(str(getattr(part, "name", "")) for part in _group_parts(par)),
    )


def _custom_pages(comp):
    pages = getattr(comp, "customPages", None)
    if pages is None:
        raise CustomParameterError("not_a_comp", "%s is not a COMP with custom pages" % comp.path)
    return list(pages)


def _custom_pars(comp):
    pars = getattr(comp, "customPars", None)
    if pars is None:
        raise CustomParameterError("not_a_comp", "%s is not a COMP with custom parameters" % comp.path)
    return list(pars)


def _find_page(comp, name):
    for page in _custom_pages(comp):
        if str(page.name) == name:
            return page
    return None


def _find_par(comp, name):
    for par in _custom_pars(comp):
        if str(getattr(par, "name", "")) == name:
            return par
    return None


def _require_custom_par(comp, name):
    par = _find_par(comp, name)
    if par is None:
        raise CustomParameterError("parameter_not_found", "Custom parameter not found: %s" % name)
    if getattr(par, "isCustom", False) is not True:
        raise CustomParameterError("built_in_protected", "Built-in parameter is protected: %s" % name)
    return par


def _require_custom_page(comp, name):
    page = _find_page(comp, name)
    if page is None:
        raise CustomParameterError("page_not_found", "Custom page not found: %s" % name)
    return page


def _validate_scalar(value, field):
    if isinstance(value, (bool, int, float, str)) or value is None:
        if isinstance(value, str) and len(value) > MAX_TEXT_VALUE:
            raise CustomParameterError("invalid_definition", "%s exceeds %d characters" % (field, MAX_TEXT_VALUE))
        return copy.deepcopy(value)
    if isinstance(value, (list, tuple)) and 1 <= len(value) <= 4:
        if not all(isinstance(item, (int, float)) and not isinstance(item, bool) for item in value):
            raise CustomParameterError("invalid_definition", "%s array must contain only numbers" % field)
        return list(value)
    raise CustomParameterError("invalid_definition", "%s has an unsupported value" % field)


def _validate_menu(values, field, *, required=False):
    if values is None and not required:
        return None
    if not isinstance(values, list) or not values or len(values) > MAX_MENU_ITEMS:
        raise CustomParameterError("invalid_definition", "%s must contain 1..%d items" % (field, MAX_MENU_ITEMS))
    return [_bounded_text(item, field, MAX_LABEL, required=field == "menu_names") for item in values]


def _validated_bounds(raw):
    minimum = raw.get("min")
    maximum = raw.get("max")
    for value, field in ((minimum, "min"), (maximum, "max")):
        if value is not None and (not isinstance(value, (int, float)) or isinstance(value, bool)):
            raise CustomParameterError("invalid_definition", "%s must be numeric" % field)
    if minimum is not None and maximum is not None and minimum > maximum:
        raise CustomParameterError("invalid_definition", "min must be less than or equal to max")
    return minimum, maximum


def _validate_definition_shape(raw):
    if not isinstance(raw, dict):
        raise CustomParameterError("invalid_definition", "Each parameter definition must be an object")
    allowed = {"name", "type", "label", "default", "min", "max", "clamp", "menu_names", "menu_labels", "size"}
    unknown = set(raw) - allowed
    if unknown:
        raise CustomParameterError("invalid_definition", "Unknown parameter fields: %s" % ", ".join(sorted(unknown)))


def _validated_style_size(raw):
    style = raw.get("type")
    if style not in _STYLE_METHODS:
        raise CustomParameterError("unsupported_parameter_style", "Unsupported parameter style: %s" % style)
    size = raw.get("size", 1)
    if not isinstance(size, int) or isinstance(size, bool) or not 1 <= size <= 4:
        raise CustomParameterError("invalid_definition", "size must be an integer from 1 to 4")
    if style not in {"Float", "Int"} and "size" in raw:
        raise CustomParameterError("invalid_definition", "size is supported only for Float and Int")
    return style, size


def _validated_definition_menus(raw, style):
    menu_names = _validate_menu(raw.get("menu_names"), "menu_names", required=style == "Menu")
    menu_labels = _validate_menu(raw.get("menu_labels"), "menu_labels")
    if menu_labels is not None and (menu_names is None or len(menu_labels) != len(menu_names)):
        raise CustomParameterError("invalid_definition", "menu_labels must match menu_names length")
    return menu_names, menu_labels


def _toggle_value(value):
    if isinstance(value, str):
        return value.strip().lower() not in {"", "0", "false", "no", "off"}
    return bool(value)


def _rgb_value(value):
    if not isinstance(value, str):
        return value
    text = value.strip().lstrip("#")
    if re.fullmatch(r"[0-9A-Fa-f]{6}", text) is None:
        raise CustomParameterError("invalid_definition", "RGB string defaults must use #RRGGBB")
    return [int(text[index : index + 2], 16) / 255.0 for index in (0, 2, 4)]


def _normalized_default(raw, style, menu_names):
    if "default" not in raw or style in {"Pulse", "Header"}:
        return None, False
    value = _validate_scalar(raw.get("default"), "default")
    if style == "Toggle":
        value = _toggle_value(value)
    elif style == "RGB":
        value = _rgb_value(value)
    elif style in {"Str", "Menu", "OP", "TOP", "File", "Folder"}:
        value = str(value)
    if style == "Menu" and value not in menu_names:
        raise CustomParameterError("invalid_definition", "Menu default must be one of menu_names")
    return value, True


def _validate_definition(raw):
    _validate_definition_shape(raw)
    requested_name = _bounded_text(raw.get("name"), "name", MAX_NAME)
    style, size = _validated_style_size(raw)
    menu_names, menu_labels = _validated_definition_menus(raw, style)
    minimum, maximum = _validated_bounds(raw)
    default, has_default = _normalized_default(raw, style, menu_names)
    return {
        "requested_name": requested_name,
        "name": _normalize_par_name(requested_name),
        "type": style,
        "label": _bounded_text(raw.get("label", requested_name), "label", MAX_LABEL),
        "default": default,
        "has_default": has_default,
        "min": minimum,
        "max": maximum,
        "clamp": bool(raw.get("clamp", False)),
        "menu_names": menu_names,
        "menu_labels": menu_labels,
        "size": size,
    }


def _validate_edit_label(fields):
    if "label" in fields:
        fields["label"] = _bounded_text(fields["label"], "label", MAX_LABEL)


def _validate_edit_scalars(fields):
    for key in ("default", "value"):
        if key in fields:
            fields[key] = _validate_scalar(fields[key], key)


def _validate_edit_ranges(fields):
    for key in ("min", "max"):
        if key in fields and (not isinstance(fields[key], (int, float)) or isinstance(fields[key], bool)):
            raise CustomParameterError("invalid_definition", "%s must be numeric" % key)
    if "clamp" in fields and not isinstance(fields["clamp"], bool):
        raise CustomParameterError("invalid_definition", "clamp must be boolean")
    _validated_bounds(fields)


def _validate_edit_values(fields):
    _validate_edit_label(fields)
    _validate_edit_scalars(fields)
    _validate_edit_ranges(fields)


def _validate_edit_menus(fields):
    if "menu_names" in fields:
        fields["menu_names"] = _validate_menu(fields["menu_names"], "menu_names", required=True)
    if "menu_labels" in fields:
        fields["menu_labels"] = _validate_menu(fields["menu_labels"], "menu_labels", required=True)
    if "menu_names" in fields and "menu_labels" in fields and len(fields["menu_names"]) != len(fields["menu_labels"]):
        raise CustomParameterError("invalid_definition", "menu_labels must match menu_names length")
    if "menu_names" in fields and "menu_labels" not in fields:
        fields["menu_labels"] = list(fields["menu_names"])


def _validate_edit_mode(fields):
    mode = fields.get("mode")
    if mode is not None:
        mode = _bounded_text(mode, "mode", 16).upper()
        if mode not in {"CONSTANT", "EXPRESSION", "BIND", "EXPORT"}:
            raise CustomParameterError("unsupported_parameter_mode", "Unsupported parameter mode: %s" % mode)
        fields["mode"] = mode
    if mode == "EXPRESSION" and "expression" not in fields:
        raise CustomParameterError("invalid_definition", "EXPRESSION mode requires expression")
    if mode == "BIND" and "bind_expression" not in fields:
        raise CustomParameterError("invalid_definition", "BIND mode requires bind_expression")
    if "expression" in fields:
        fields["expression"] = _bounded_text(fields["expression"], "expression", MAX_TEXT_VALUE)
    if "bind_expression" in fields:
        fields["bind_expression"] = _bounded_text(fields["bind_expression"], "bind_expression", MAX_TEXT_VALUE)


def _validate_edit_fields(raw):
    if not isinstance(raw, dict) or not raw:
        raise CustomParameterError("invalid_definition", "edit_parameter fields must be a non-empty object")
    unknown = set(raw) - _EDIT_FIELDS
    if unknown:
        raise CustomParameterError("invalid_definition", "Unknown edit fields: %s" % ", ".join(sorted(unknown)))
    fields = copy.deepcopy(raw)
    _validate_edit_values(fields)
    _validate_edit_menus(fields)
    _validate_edit_mode(fields)
    return fields


def _normalize_add_operation(raw):
    params = raw.get("params")
    if not isinstance(params, list) or not params or len(params) > MAX_PARAMS:
        raise CustomParameterError("invalid_definition", "params must contain 1..%d definitions" % MAX_PARAMS)
    definitions = [_validate_definition(definition) for definition in params]
    names = [definition["name"] for definition in definitions]
    if len(names) != len(set(names)):
        raise CustomParameterError("duplicate_definition", "Duplicate normalized parameter names in add operation")
    return {"action": "add", "page": _normalize_page(raw.get("page", "Custom")), "params": definitions}


def _normalize_sort_operation(raw):
    order = raw.get("order")
    if not isinstance(order, list) or not order or len(order) > MAX_PARAMS:
        raise CustomParameterError("invalid_definition", "sort_page order must contain 1..%d names" % MAX_PARAMS)
    names = [_bounded_text(name, "order", MAX_NAME) for name in order]
    if len(names) != len(set(names)):
        raise CustomParameterError("invalid_definition", "sort_page order contains duplicate names")
    return {"action": "sort_page", "page": _normalize_page(raw.get("page")), "order": names}


def _normalize_operation(raw, index):
    if not isinstance(raw, dict):
        raise CustomParameterError("invalid_definition", "Operation %d must be an object" % index)
    action = raw.get("action")
    if action not in _ACTIONS:
        raise CustomParameterError("invalid_definition", "Unsupported lifecycle action: %s" % action)
    unknown = set(raw) - _OPERATION_FIELDS[action]
    if unknown:
        raise CustomParameterError("invalid_definition", "Unknown %s fields: %s" % (action, ", ".join(sorted(unknown))))
    if action == "add":
        return _normalize_add_operation(raw)
    if action == "edit_parameter":
        return {"action": action, "name": _bounded_text(raw.get("name"), "name", MAX_NAME), "fields": _validate_edit_fields(raw.get("fields"))}
    if action == "delete_parameter":
        return {"action": action, "name": _bounded_text(raw.get("name"), "name", MAX_NAME)}
    if action == "sort_page":
        return _normalize_sort_operation(raw)
    if action == "rename_page":
        return {"action": action, "page": _normalize_page(raw.get("page")), "new_name": _normalize_page(raw.get("new_name"))}
    return {"action": action, "page": _normalize_page(raw.get("page"))}


def _normalize_operations(payload):
    if not isinstance(payload, dict):
        raise CustomParameterError("invalid_definition", "Request body must be an object")
    unknown = set(payload) - {"page", "params", "operations", "idempotency_key"}
    if unknown:
        raise CustomParameterError("invalid_definition", "Unknown request fields: %s" % ", ".join(sorted(unknown)))
    operations = payload.get("operations")
    legacy_params = payload.get("params")
    if operations is not None and legacy_params is not None:
        raise CustomParameterError("invalid_definition", "Use either operations or legacy params, not both")
    if operations is None:
        operations = [{"action": "add", "page": payload.get("page", "Custom"), "params": legacy_params}]
    if not isinstance(operations, list) or not operations or len(operations) > MAX_OPERATIONS:
        raise CustomParameterError("invalid_definition", "operations must contain 1..%d items" % MAX_OPERATIONS)
    return [_normalize_operation(raw, index) for index, raw in enumerate(operations)]


def _request_fingerprint(path, operations):
    encoded = json.dumps({"path": path, "operations": operations}, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _validate_key(value):
    if value is None:
        return None
    key = _bounded_text(value, "idempotency_key", MAX_IDEMPOTENCY_KEY)
    if len(key) < 16 or re.fullmatch(r"[A-Za-z0-9_-]+", key) is None:
        raise CustomParameterError("invalid_definition", "idempotency_key must be a 16..128 character URL-safe token")
    return key


def _prune_receipts(now):
    expired = [key for key, value in _RECEIPTS.items() if now - value["created_at"] >= RECEIPT_TTL_SECONDS]
    for key in expired:
        _RECEIPTS.pop(key, None)
    while len(_RECEIPTS) > MAX_RECEIPTS:
        oldest = min(_RECEIPTS, key=lambda key: _RECEIPTS[key]["created_at"])
        _RECEIPTS.pop(oldest, None)


def _public_receipt(report):
    replay = copy.deepcopy(report)
    replay["status"] = "replayed"
    replay["replayed"] = True
    return replay


def _snapshot_component(par):
    attributes = {}
    for name in ("label", "default", "min", "max", "clampMin", "clampMax", "normMin", "normMax", "val", "menuNames", "menuLabels", "expr", "bindExpr"):
        try:
            attributes[name] = _portable(getattr(par, name))
        except Exception:  # noqa: BLE001
            continue
    return {"name": str(par.name), "style": _style_name(par), "mode": _mode_name(par), "attributes": attributes}


def _group_root(style, components, group):
    group_name = _safe(lambda: str(group.name)) if group is not None else None
    if group_name:
        return group_name
    first = components[0]["name"]
    suffix = {"XYZW": "x", "XYZ": "x", "RGBA": "r", "RGB": "r"}.get(style)
    if suffix and first.endswith(suffix):
        return first[: -len(suffix)]
    if len(components) > 1:
        return re.sub(r"[0-9]+$", "", first) or first
    return first


def _snapshot_group(par, page_name):
    if getattr(par, "isCustom", False) is not True:
        raise CustomParameterError("built_in_protected", "Page %s contains a non-custom parameter" % page_name)
    group = getattr(par, "parGroup", None)
    components = [_snapshot_component(part) for part in _group_parts(par)]
    style = components[0]["style"]
    if style not in _STYLE_METHODS:
        raise CustomParameterError("unsupported_parameter_style", "Cannot snapshot custom style for exact rollback: %s" % style)
    mode_names = {component["mode"] for component in components}
    if "EXPORT" in mode_names:
        raise CustomParameterError("unsupported_parameter_mode", "EXPORT parameters are HELD until reversible source semantics are proved", status="held")
    if mode_names - {"CONSTANT", "EXPRESSION", "BIND"}:
        raise CustomParameterError("unsupported_parameter_mode", "Cannot snapshot custom parameter mode for exact rollback")
    return {"root": _group_root(style, components, group), "style": style, "components": components}


def _snapshot_page(pars, page):
    page_name = str(page.name)
    seen = set()
    groups = []
    for par in pars:
        if str(getattr(getattr(par, "page", None), "name", "")) != page_name:
            continue
        token = _group_token(par)
        if token in seen:
            continue
        seen.add(token)
        groups.append(_snapshot_group(par, page_name))
    return {"name": page_name, "groups": groups}


def _snapshot_state(comp):
    pars = _custom_pars(comp)
    return [_snapshot_page(pars, page) for page in _custom_pages(comp)]


def _page_groups(comp, page_name):
    groups = []
    seen = set()
    for par in _custom_pars(comp):
        if str(getattr(getattr(par, "page", None), "name", "")) != page_name:
            continue
        token = _group_token(par)
        if token in seen:
            continue
        seen.add(token)
        group = getattr(par, "parGroup", None)
        if group is None:
            raise CustomParameterError("readback_mismatch", "Custom parameter has no ParGroup: %s" % par.name)
        groups.append((group, _group_parts(par)))
    return groups


def _append_group(page, definition):
    method = getattr(page, _STYLE_METHODS[definition["type"]], None)
    if method is None:
        raise CustomParameterError("unsupported_parameter_style", "TouchDesigner build lacks %s" % _STYLE_METHODS[definition["type"]])
    kwargs = {"label": definition["label"], "replace": False}
    if definition["type"] in {"Float", "Int"}:
        kwargs["size"] = definition["size"]
    group = method(definition["name"], **kwargs)
    parts = list(group)
    if not parts:
        raise CustomParameterError("readback_mismatch", "TouchDesigner returned an empty ParGroup")
    _apply_definition(parts, definition)
    return group, parts


def _values_for_parts(value, count):
    if isinstance(value, list):
        return value[:count]
    return [value] * count


def _apply_definition_range(parts, definition, field, norm_attribute, hard_attribute, clamp_attribute):
    value = definition[field]
    if value is None:
        return
    for par in parts:
        setattr(par, norm_attribute, value)
        if definition["clamp"]:
            setattr(par, hard_attribute, value)
            setattr(par, clamp_attribute, True)


def _apply_definition(parts, definition):
    _apply_definition_range(parts, definition, "min", "normMin", "min", "clampMin")
    _apply_definition_range(parts, definition, "max", "normMax", "max", "clampMax")
    if definition["type"] == "Menu":
        parts[0].menuNames = definition["menu_names"]
        parts[0].menuLabels = definition["menu_labels"] or definition["menu_names"]
    if definition["has_default"]:
        values = _values_for_parts(definition["default"], len(parts))
        for index, value in enumerate(values):
            parts[index].default = value
            _set_par_value(parts[index], value)


def _definition_identity_matches(parts, definition):
    expected_size = {"XYZW": 4, "RGBA": 4, "RGB": 3, "XYZ": 3}.get(definition["type"], definition["size"])
    return (
        _style_name(parts[0]) == definition["type"]
        and len(parts) == expected_size
        and str(getattr(parts[0], "label", "")) == definition["label"]
    )


def _definition_default_matches(parts, definition):
    if not definition["has_default"]:
        return True
    expected = _values_for_parts(definition["default"], len(parts))
    actual = [_portable(getattr(part, "default", None)) for part in parts[: len(expected)]]
    return actual == expected


def _definition_ranges_match(parts, definition):
    minimum_matches = definition["min"] is None or all(getattr(part, "normMin", None) == definition["min"] for part in parts)
    maximum_matches = definition["max"] is None or all(getattr(part, "normMax", None) == definition["max"] for part in parts)
    clamp_matches = not definition["clamp"] or all(getattr(part, "clampMin", False) and getattr(part, "clampMax", False) for part in parts)
    return minimum_matches and maximum_matches and clamp_matches


def _definition_menu_matches(parts, definition):
    if definition["type"] != "Menu":
        return True
    names = list(getattr(parts[0], "menuNames", []))
    labels = list(getattr(parts[0], "menuLabels", []))
    return names == definition["menu_names"] and labels == (definition["menu_labels"] or definition["menu_names"])


def _definition_matches(par, definition):
    parts = _group_parts(par)
    return all(
        (
            _definition_identity_matches(parts, definition),
            _definition_default_matches(parts, definition),
            _definition_ranges_match(parts, definition),
            _definition_menu_matches(parts, definition),
        )
    )


def _edit_label(parts, value):
    parts[0].label = value


def _edit_component_attribute(parts, value, attribute):
    for index, item in enumerate(_values_for_parts(value, len(parts))):
        setattr(parts[index], attribute, item)


def _set_par_value(par, value):
    """Write a constant through the owning ParCollection when available.

    Live Web Server DAT callbacks can acknowledge ``par.val = value`` without
    persisting the constant. The documented owner collection assignment has an
    immediate readback and remains compatible with offline doubles.
    """
    owner = getattr(par, "owner", None)
    collection = getattr(owner, "par", None) if owner is not None else None
    name = str(getattr(par, "name", ""))
    if collection is not None and name:
        setattr(collection, name, value)
        return
    par.val = value


def _edit_value(parts, value):
    for index, item in enumerate(_values_for_parts(value, len(parts))):
        _set_par_value(parts[index], item)


def _edit_range(parts, value, attribute):
    for part in parts:
        setattr(part, attribute, value)


def _edit_clamp(parts, value):
    for part in parts:
        part.clampMin = value
        part.clampMax = value


def _edit_menu_names(parts, value):
    parts[0].menuNames = value


def _edit_menu_labels(parts, value):
    parts[0].menuLabels = value


_EDIT_APPLIERS = {
    "label": _edit_label,
    "default": lambda parts, value: _edit_component_attribute(parts, value, "default"),
    "value": _edit_value,
    "min": lambda parts, value: _edit_range(parts, value, "normMin"),
    "max": lambda parts, value: _edit_range(parts, value, "normMax"),
    "clamp": _edit_clamp,
    "menu_names": _edit_menu_names,
    "menu_labels": _edit_menu_labels,
}


def _apply_constant_mode(td, parts, _fields, field_results):
    for part in parts:
        if _mode_name(part) != "CONSTANT":
            _set_par_mode(td, part, "CONSTANT")
    field_results["mode"] = "applied"


def _apply_expression_mode(_td, parts, fields, field_results):
    for part in parts:
        part.expr = fields["expression"]
    field_results.update({"expression": "applied", "mode": "applied"})


def _apply_bind_mode(td, parts, fields, field_results):
    for part in parts:
        part.bindExpr = fields["bind_expression"]
        _set_par_mode(td, part, "BIND")
    field_results.update({"bind_expression": "applied", "mode": "applied"})


_EDIT_MODE_APPLIERS = {
    "CONSTANT": _apply_constant_mode,
    "EXPRESSION": _apply_expression_mode,
    "BIND": _apply_bind_mode,
}


def _apply_edit_mode(td, parts, fields, field_results):
    apply_mode = _EDIT_MODE_APPLIERS.get(fields.get("mode"))
    if apply_mode is not None:
        apply_mode(td, parts, fields, field_results)


def _sync_hard_bounds(parts, field, value):
    if field != "clamp" or value is not True:
        return
    for part in parts:
        part.min = part.normMin
        part.max = part.normMax


def _apply_edit_field(parts, fields, field_results, field):
    if field not in fields:
        return
    value = fields[field]
    _EDIT_APPLIERS[field](parts, value)
    field_results[field] = "applied"
    _sync_hard_bounds(parts, field, value)


def _apply_edit(td, par, fields):
    parts = _group_parts(par)
    field_results = {}
    # Changing to CONSTANT can reset the live value to the default on real TD
    # builds. Apply the mode first so an explicit value remains authoritative.
    mode_applied_first = fields.get("mode") == "CONSTANT"
    if mode_applied_first:
        _apply_edit_mode(td, parts, fields, field_results)
    # Apply in a stable order independent of JSON key order. Ranges and their
    # hard clamp bounds must precede the constant value or TD will clamp that
    # value against stale limits.
    for field in (
        "label",
        "default",
        "min",
        "max",
        "clamp",
        "menu_names",
        "menu_labels",
        "value",
    ):
        _apply_edit_field(parts, fields, field_results, field)
    if not mode_applied_first:
        _apply_edit_mode(td, parts, fields, field_results)
    return parts, field_results


def _preflight_edit_style(style, fields):
    if set(fields) & {"min", "max", "clamp"} and style not in {"Float", "Int"}:
        raise CustomParameterError("invalid_definition", "Ranges and clamp require a Float or Int parameter")
    if set(fields) & {"menu_names", "menu_labels"} and style != "Menu":
        raise CustomParameterError("invalid_definition", "Menu fields require a Menu parameter")
    if style in {"Header", "Pulse"} and set(fields) - {"label"}:
        raise CustomParameterError("invalid_definition", "%s parameters only support label edits" % style)


def _normalized_edit_value(style, value):
    if style == "Toggle":
        return _toggle_value(value)
    if style == "RGB":
        return _rgb_value(value)
    if style in {"Str", "Menu", "OP", "TOP", "File", "Folder"}:
        return str(value)
    if style == "Int":
        return [int(item) for item in value] if isinstance(value, list) else int(value)
    return value


def _normalize_edit_values_for_style(style, fields):
    for field in ("default", "value"):
        if field in fields:
            fields[field] = _normalized_edit_value(style, fields[field])


def _preflight_edit_range(parts, fields):
    minimum = fields.get("min", getattr(parts[0], "normMin", None))
    maximum = fields.get("max", getattr(parts[0], "normMax", None))
    if minimum is not None and maximum is not None and minimum > maximum:
        raise CustomParameterError("invalid_definition", "Resulting min must be less than or equal to max")


def _preflight_edit_menu(style, parts, fields):
    if style != "Menu":
        return
    names = fields.get("menu_names", list(getattr(parts[0], "menuNames", [])))
    labels = fields.get("menu_labels", list(getattr(parts[0], "menuLabels", [])))
    if labels and len(labels) != len(names):
        raise CustomParameterError("invalid_definition", "Resulting menu labels must match menu names")
    for field in ("default", "value"):
        if field in fields and fields[field] not in names:
            raise CustomParameterError("invalid_definition", "Menu %s must be one of menu_names" % field)


def _preflight_edit(par, fields):
    style = _style_name(par)
    parts = _group_parts(par)
    _preflight_edit_style(style, fields)
    _normalize_edit_values_for_style(style, fields)
    _preflight_edit_range(parts, fields)
    _preflight_edit_menu(style, parts, fields)


def _component_values_match(parts, value, attribute):
    expected = _values_for_parts(value, len(parts))
    actual = [_portable(getattr(part, attribute, None)) for part in parts[: len(expected)]]
    return actual == expected


def _match_label(parts, value):
    return str(getattr(parts[0], "label", "")) == value


def _match_range(parts, value, attribute):
    return all(getattr(part, attribute, None) == value for part in parts)


def _match_clamp(parts, value):
    return all(getattr(part, "clampMin", None) == value and getattr(part, "clampMax", None) == value for part in parts)


def _match_menu(parts, value, attribute):
    return list(getattr(parts[0], attribute, [])) == value


_EDIT_MATCHERS = {
    "label": _match_label,
    "default": lambda parts, value: _component_values_match(parts, value, "default"),
    "value": lambda parts, value: _component_values_match(parts, value, "val"),
    "min": lambda parts, value: _match_range(parts, value, "normMin"),
    "max": lambda parts, value: _match_range(parts, value, "normMax"),
    "clamp": _match_clamp,
    "menu_names": lambda parts, value: _match_menu(parts, value, "menuNames"),
    "menu_labels": lambda parts, value: _match_menu(parts, value, "menuLabels"),
}


def _edit_field_matches(parts, field, value):
    matcher = _EDIT_MATCHERS.get(field)
    return True if matcher is None else matcher(parts, value)


def _verify_edit_fields(parts, fields):
    for field, value in fields.items():
        if not _edit_field_matches(parts, field, value):
            raise CustomParameterError("readback_mismatch", "Edit readback mismatch for field: %s" % field)


def _verify_edit_mode(parts, fields):
    mode = fields.get("mode")
    if mode is not None and any(_mode_name(part) != mode for part in parts):
        raise CustomParameterError("readback_mismatch", "Edit mode readback mismatch")


def _verify_edit_mode_payload(parts, fields):
    mode = fields.get("mode")
    if mode == "EXPRESSION" and any(str(getattr(part, "expr", "")) != fields["expression"] for part in parts):
        raise CustomParameterError("readback_mismatch", "Expression readback mismatch")
    if mode == "BIND" and any(str(getattr(part, "bindExpr", "")) != fields["bind_expression"] for part in parts):
        raise CustomParameterError("readback_mismatch", "Bind expression readback mismatch")


def _verify_clamp_bounds(parts, fields):
    if fields.get("clamp") is True and any(
        part.min != part.normMin or part.max != part.normMax for part in parts
    ):
        raise CustomParameterError("readback_mismatch", "Clamp bound readback mismatch")


def _verify_edit(parts, fields):
    _verify_edit_fields(parts, fields)
    _verify_edit_mode(parts, fields)
    _verify_edit_mode_payload(parts, fields)
    _verify_clamp_bounds(parts, fields)


def _destroy_group(comp, par):
    names = [str(part.name) for part in _group_parts(par)]
    for name in reversed(names):
        current = _find_par(comp, name)
        if current is not None:
            current.destroy()
    if any(_find_par(comp, name) is not None for name in names):
        raise CustomParameterError("readback_mismatch", "Parameter group still exists after delete")
    return names


def _apply_add_definition(comp, page, definition):
    existing = _find_par(comp, definition["name"])
    if existing is not None:
        if getattr(existing, "isCustom", False) is not True:
            raise CustomParameterError("built_in_protected", "Built-in parameter collision: %s" % definition["name"])
        if not _definition_matches(existing, definition):
            raise CustomParameterError("definition_conflict", "Existing parameter has a different definition: %s" % definition["name"])
        parts, status = _group_parts(existing), "unchanged"
    else:
        _, parts = _append_group(page, definition)
        if not _definition_matches(parts[0], definition):
            raise CustomParameterError("readback_mismatch", "Definition readback mismatch: %s" % definition["name"])
        status = "applied"
    return {
        "requested_name": definition["requested_name"],
        "name": definition["name"],
        "style": definition["type"],
        "components": [str(part.name) for part in parts],
        "status": status,
    }


def _apply_add_operation(_td, comp, operation, index):
    page = _find_page(comp, operation["page"])
    if page is None:
        page = comp.appendCustomPage(operation["page"])
    results = [_apply_add_definition(comp, page, definition) for definition in operation["params"]]
    status = "applied" if any(item["status"] == "applied" for item in results) else "unchanged"
    return {"index": index, "action": "add", "page": operation["page"], "status": status, "parameters": results}


def _apply_edit_operation(td, comp, operation, index):
    par = _require_custom_par(comp, operation["name"])
    _preflight_edit(par, operation["fields"])
    parts, fields = _apply_edit(td, par, operation["fields"])
    _verify_edit(parts, operation["fields"])
    return {"index": index, "action": "edit_parameter", "name": operation["name"], "status": "applied", "components": [str(part.name) for part in parts], "fields": fields}


def _apply_delete_parameter_operation(_td, comp, operation, index):
    names = _destroy_group(comp, _require_custom_par(comp, operation["name"]))
    return {"index": index, "action": "delete_parameter", "name": operation["name"], "status": "applied", "components": names}


def _selected_sort_groups(comp, operation):
    selected = []
    selected_order = []
    selected_tokens = set()
    for name in operation["order"]:
        par = _require_custom_par(comp, name)
        if str(par.page.name) != operation["page"]:
            raise CustomParameterError("invalid_definition", "Sort parameter is not on page %s: %s" % (operation["page"], name))
        group = getattr(par, "parGroup", None)
        if group is None:
            raise CustomParameterError("readback_mismatch", "Parameter has no ParGroup: %s" % name)
        token = _group_token(par)
        if token in selected_tokens:
            raise CustomParameterError("invalid_definition", "sort_page names address the same ParGroup more than once")
        selected_tokens.add(token)
        selected_order.append(token)
        selected.append(group)
    return selected, selected_tokens, selected_order


def _apply_sort_operation(_td, comp, operation, index):
    page = _require_custom_page(comp, operation["page"])
    selected, selected_tokens, selected_order = _selected_sort_groups(comp, operation)
    available_tokens = {
        _group_token(parts[0]) for _, parts in _page_groups(comp, operation["page"])
    }
    if selected_tokens != available_tokens:
        raise CustomParameterError("invalid_definition", "sort_page order must include every ParGroup exactly once")
    page.sort(*selected)
    actual_tokens = [
        _group_token(parts[0]) for _, parts in _page_groups(comp, operation["page"])
    ]
    if actual_tokens != selected_order:
        raise CustomParameterError("readback_mismatch", "ParGroup sort readback mismatch")
    return {"index": index, "action": "sort_page", "page": operation["page"], "status": "applied", "groups": len(selected)}


def _apply_rename_page_operation(_td, comp, operation, index):
    page = _require_custom_page(comp, operation["page"])
    existing = _find_page(comp, operation["new_name"])
    if existing is not None and existing is not page:
        raise CustomParameterError("definition_conflict", "Custom page already exists: %s" % operation["new_name"])
    page.name = operation["new_name"]
    if str(page.name) != operation["new_name"]:
        raise CustomParameterError("readback_mismatch", "Page rename did not persist")
    return {"index": index, "action": "rename_page", "page": operation["page"], "final_page": operation["new_name"], "status": "applied"}


def _apply_delete_page_operation(_td, comp, operation, index):
    page = _require_custom_page(comp, operation["page"])
    page.destroy()
    if _find_page(comp, operation["page"]) is not None:
        raise CustomParameterError("readback_mismatch", "Custom page still exists after delete")
    return {"index": index, "action": "delete_page", "page": operation["page"], "status": "applied"}


_OPERATION_APPLIERS = {
    "add": _apply_add_operation,
    "edit_parameter": _apply_edit_operation,
    "delete_parameter": _apply_delete_parameter_operation,
    "sort_page": _apply_sort_operation,
    "rename_page": _apply_rename_page_operation,
    "delete_page": _apply_delete_page_operation,
}


def _apply_operation(td, comp, operation, index):
    return _OPERATION_APPLIERS[operation["action"]](td, comp, operation, index)


def _set_par_mode(td, par, mode_name):
    """Resolve ParMode from a live parameter; imported TD modules lack td.ParMode."""
    mode = getattr(type(par.mode), mode_name, None)
    if mode is None:
        # Kept for lightweight offline doubles; live TouchDesigner uses the
        # enum class derived above.
        mode = getattr(getattr(td, "ParMode", None), mode_name, None)
    if mode is None:
        raise CustomParameterError(
            "unsupported_parameter_mode",
            "Could not resolve parameter mode: %s" % mode_name,
        )
    par.mode = mode


def _restore_component_attributes(par, attributes):
    for name in ("label", "default", "min", "max", "clampMin", "clampMax", "normMin", "normMax"):
        if name in attributes:
            setattr(par, name, copy.deepcopy(attributes[name]))


def _restore_component_value(par, attributes):
    if "val" in attributes:
        _set_par_value(par, copy.deepcopy(attributes["val"]))


def _restore_component_menu(par, style, attributes):
    if style != "Menu":
        return
    for name in ("menuNames", "menuLabels"):
        if name in attributes:
            setattr(par, name, copy.deepcopy(attributes[name]))


def _restore_component_expressions(par, attributes):
    if "expr" in attributes:
        par.expr = attributes["expr"]
    if "bindExpr" in attributes:
        par.bindExpr = attributes["bindExpr"]


def _restore_constant_mode(td, par, _attributes):
    _set_par_mode(td, par, "CONSTANT")


def _restore_expression_mode(_td, par, attributes):
    par.expr = attributes.get("expr", "")


def _restore_bind_mode(td, par, attributes):
    par.bindExpr = attributes.get("bindExpr", "")
    _set_par_mode(td, par, "BIND")


_RESTORE_MODE_APPLIERS = {
    "CONSTANT": _restore_constant_mode,
    "EXPRESSION": _restore_expression_mode,
    "BIND": _restore_bind_mode,
}


def _restore_component_mode(td, par, mode, attributes):
    restore_mode = _RESTORE_MODE_APPLIERS.get(mode)
    if restore_mode is not None:
        restore_mode(td, par, attributes)


def _restore_component(td, par, snapshot):
    attributes = snapshot["attributes"]
    _restore_component_attributes(par, attributes)
    _restore_component_value(par, attributes)
    _restore_component_menu(par, snapshot["style"], attributes)
    _restore_component_expressions(par, attributes)
    _restore_component_mode(td, par, snapshot["mode"], attributes)


def _restore_group(td, page, group_snapshot):
    style = group_snapshot["style"]
    method = getattr(page, _STYLE_METHODS[style])
    kwargs = {"label": group_snapshot["components"][0]["attributes"].get("label", group_snapshot["root"]), "replace": False}
    if style in {"Float", "Int"}:
        kwargs["size"] = len(group_snapshot["components"])
    group = method(group_snapshot["root"], **kwargs)
    parts = list(group)
    expected_names = [component["name"] for component in group_snapshot["components"]]
    if [str(part.name) for part in parts] != expected_names:
        raise CustomParameterError("rollback_failed", "Recreated ParGroup component names differ")
    for part, component in zip(parts, group_snapshot["components"]):
        _restore_component(td, part, component)
    return group


def _restore_page(td, comp, page_snapshot):
    page = comp.appendCustomPage(page_snapshot["name"])
    groups = [_restore_group(td, page, group_snapshot) for group_snapshot in page_snapshot["groups"]]
    if groups:
        page.sort(*groups)


def _restore_state(td, comp, snapshot):
    for page in reversed(_custom_pages(comp)):
        page.destroy()
    for page_snapshot in snapshot:
        _restore_page(td, comp, page_snapshot)
    if _snapshot_state(comp) != snapshot:
        raise CustomParameterError("rollback_failed", "Exact custom-parameter snapshot comparison failed")


def _error_report(path, code, message, status, fingerprint):
    return {
        "status": status,
        "comp_path": path,
        "results": [],
        "rollback": {"attempted": False, "succeeded": True},
        "warnings": [],
        "error": {"code": code, "message": message[:512]},
        "request_fingerprint": fingerprint,
        "undo_label": "MCP custom_parameter_lifecycle %s" % path,
    }


def _prepare_request(path, payload):
    clean_path = _bounded_text(path, "path", 1024)
    if not clean_path.startswith("/"):
        raise CustomParameterError("invalid_definition", "path must be absolute")
    operations = _normalize_operations(payload)
    fingerprint = _request_fingerprint(clean_path, operations)
    key = _validate_key(payload.get("idempotency_key") if isinstance(payload, dict) else None)
    return clean_path, operations, fingerprint, key


def _state_digest(comp):
    snapshot = _snapshot_state(comp)
    encoded = json.dumps(snapshot, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _receipt_replay(key, fingerprint, path, comp):
    explicit = _RECEIPTS.get("key:" + key) if key is not None else None
    if explicit is not None and explicit["fingerprint"] != fingerprint:
        return _error_report(path, "idempotency_conflict", "Idempotency key was already used for a different request", "failed", fingerprint)
    receipt = explicit or _RECEIPTS.get("fingerprint:" + fingerprint)
    if receipt is None:
        return None
    if _safe(lambda: _state_digest(comp)) == receipt["after_digest"]:
        return _public_receipt(receipt["report"])
    if explicit is not None:
        return _error_report(path, "idempotency_conflict", "TouchDesigner state diverged after the idempotent request", "failed", fingerprint)
    return None


def _store_receipts(key, fingerprint, report, comp, now):
    receipt = {
        "created_at": now,
        "fingerprint": fingerprint,
        "after_digest": _state_digest(comp),
        "report": copy.deepcopy(report),
    }
    _RECEIPTS["fingerprint:" + fingerprint] = receipt
    if key is not None:
        _RECEIPTS["key:" + key] = receipt
    _prune_receipts(now)


def _resolve_comp(td, path):
    try:
        comp = td.op(path)
    except Exception as exc:  # noqa: BLE001
        raise CustomParameterError("operator_not_found", "Could not resolve operator (%s)" % type(exc).__name__) from exc
    if comp is None:
        raise CustomParameterError("operator_not_found", "Operator not found: %s" % path)
    if not hasattr(comp, "appendCustomPage"):
        raise CustomParameterError("not_a_comp", "Operator cannot hold custom parameters")
    return comp


def _ensure_supported_modes(operations):
    for operation in operations:
        if operation.get("fields", {}).get("mode") == "EXPORT":
            raise CustomParameterError(
                "unsupported_parameter_mode",
                "EXPORT is HELD until reversible export-source semantics are proved",
                status="held",
            )


def _success_report(path, fingerprint, results):
    status = "applied" if any(result["status"] == "applied" for result in results) else "unchanged"
    return {
        "status": status,
        "comp_path": path,
        "results": results,
        "rollback": {"attempted": False, "succeeded": True},
        "warnings": [],
        "request_fingerprint": fingerprint,
        "undo_label": "MCP custom_parameter_lifecycle %s" % path,
    }


def _failed_transaction(td, comp, before, exc, path, fingerprint):
    code = exc.code if isinstance(exc, CustomParameterError) else "mutation_failed"
    fail_status = exc.status if isinstance(exc, CustomParameterError) else "failed"
    message = str(exc) if isinstance(exc, CustomParameterError) else "TouchDesigner mutation failed (%s)" % type(exc).__name__
    if before is None or _safe(lambda: _snapshot_state(comp)) == before:
        return _error_report(path, code, message, fail_status, fingerprint)
    try:
        _restore_state(td, comp, before)
        report = _error_report(path, code, message, "rolled_back", fingerprint)
        report["rollback"] = {"attempted": True, "succeeded": True}
        return report
    except Exception as rollback_exc:  # noqa: BLE001
        report = _error_report(path, "rollback_failed", "Mutation failed and exact rollback could not be confirmed", "partial_failure", fingerprint)
        report["rollback"] = {"attempted": True, "succeeded": False}
        report["remediation"] = "Inspect custom pages on %s before retrying." % path
        report["warnings"] = [type(rollback_exc).__name__[:64]]
        return report


def _run_transaction(td, comp, operations, path, fingerprint):
    before = None
    try:
        before = _snapshot_state(comp)
        _ensure_supported_modes(operations)
        results = [_apply_operation(td, comp, operation, index) for index, operation in enumerate(operations)]
        return _success_report(path, fingerprint, results)
    except Exception as exc:  # noqa: BLE001
        return _failed_transaction(td, comp, before, exc, path, fingerprint)


def apply_custom_parameter_lifecycle(path, payload):
    """Apply one bounded all-or-exact-rollback custom parameter transaction.

    ``payload`` accepts the historical ``{page, params}`` form or an
    ``operations`` union.  Errors are returned in-band with stable codes so the
    controller can preserve structured detail.  No report echoes parameter
    values, defaults, expressions or bind expressions.
    """
    import td

    try:
        clean_path, operations, fingerprint, key = _prepare_request(path, payload)
    except CustomParameterError as exc:
        return _error_report(str(path), exc.code, str(exc), exc.status, "")

    with _LOCK:
        now = time.monotonic()
        _prune_receipts(now)
        try:
            comp = _resolve_comp(td, clean_path)
        except CustomParameterError as exc:
            return _error_report(clean_path, exc.code, str(exc), exc.status, fingerprint)
        replay = _receipt_replay(key, fingerprint, clean_path, comp)
        if replay is not None:
            return replay
        report = _run_transaction(td, comp, operations, clean_path, fingerprint)
        if report["status"] in {"applied", "unchanged"}:
            _store_receipts(key, fingerprint, report, comp, now)
        return report
