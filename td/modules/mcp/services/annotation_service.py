"""Structured, transactional edits for existing TouchDesigner annotations.

The service is deliberately small and allowlisted.  It never executes caller
Python, opens UI, defers work, or stores TouchDesigner objects outside the
synchronous ``edit_annotation`` call.  Current-build Annotate COMP bindings are
``Titletext``, ``Bodytext``, ``Backcolorr/g/b`` and ``Backcoloralpha``.  Text
DAT editing is intentionally rejected: without a durable ownership marker an
arbitrary Text DAT may contain shader or executable project code.
"""

import math


MAX_PATH = 1024
MAX_TITLE = 512
MAX_BODY = 8192
MAX_COORDINATE = 1_000_000
MAX_SIZE = 1_000_000
MIN_SIZE = 10

_FIELD_ORDER = ("title", "body", "color", "x", "y", "w", "h")
_ALLOWED_FIELDS = set(_FIELD_ORDER)
_GEOMETRY_ATTRS = {
    "x": "nodeX",
    "y": "nodeY",
    "w": "nodeWidth",
    "h": "nodeHeight",
}
_TITLE_ALIASES = ("Titletext", "Title", "Text", "Header", "Note", "Annotation")
_BODY_ALIASES = ("Bodytext", "Body")
_COLOR_ALIASES = ("Backcolorr", "Backcolorg", "Backcolorb", "Backcoloralpha")


class AnnotationEditError(Exception):
    """Internal typed failure converted into a bounded service report."""

    def __init__(self, code, message, *, field=None):
        super().__init__(message)
        self.code = code
        self.field = field


def _error(code, message, *, field=None):
    return AnnotationEditError(code, message, field=field)


def _validate_path(value):
    if not isinstance(value, str) or not value.startswith("/"):
        raise _error("invalid_annotation_edit", "annotation path must be absolute")
    if not value or len(value) > MAX_PATH or any(char in value for char in "\x00\r\n"):
        raise _error(
            "invalid_annotation_edit", "annotation path is invalid or too long"
        )
    return value.rstrip("/") or "/"


def _validate_text(value, field, limit):
    if not isinstance(value, str) or "\x00" in value or len(value) > limit:
        raise _error(
            "invalid_annotation_edit",
            "%s must be a bounded string" % field,
            field=field,
        )
    return value


def _validate_integer(value, field, low, high):
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not low <= value <= high
    ):
        raise _error(
            "invalid_annotation_edit",
            "%s must be an integer from %d to %d" % (field, low, high),
            field=field,
        )
    return value


def _validate_color(value):
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        raise _error(
            "invalid_annotation_edit",
            "color must contain exactly four RGBA channels",
            field="color",
        )
    channels = []
    for channel in value:
        if isinstance(channel, bool) or not isinstance(channel, (int, float)):
            raise _error(
                "invalid_annotation_edit",
                "color channels must be finite numbers from 0 to 1",
                field="color",
            )
        number = float(channel)
        if not math.isfinite(number) or not 0.0 <= number <= 1.0:
            raise _error(
                "invalid_annotation_edit",
                "color channels must be finite numbers from 0 to 1",
                field="color",
            )
        channels.append(number)
    return tuple(channels)


_FIELD_VALIDATORS = {
    "title": lambda value: _validate_text(value, "title", MAX_TITLE),
    "body": lambda value: _validate_text(value, "body", MAX_BODY),
    "color": _validate_color,
    "x": lambda value: _validate_integer(value, "x", -MAX_COORDINATE, MAX_COORDINATE),
    "y": lambda value: _validate_integer(value, "y", -MAX_COORDINATE, MAX_COORDINATE),
    "w": lambda value: _validate_integer(value, "w", MIN_SIZE, MAX_SIZE),
    "h": lambda value: _validate_integer(value, "h", MIN_SIZE, MAX_SIZE),
}


def _validate_changes(changes):
    if not isinstance(changes, dict) or not changes:
        raise _error(
            "invalid_annotation_edit", "at least one annotation field is required"
        )
    unknown = sorted(set(changes) - _ALLOWED_FIELDS)
    if unknown:
        raise _error(
            "invalid_annotation_edit",
            "unsupported annotation fields: %s" % ", ".join(unknown),
        )
    return {
        field: _FIELD_VALIDATORS[field](changes[field])
        for field in _FIELD_ORDER
        if field in changes
    }


def _portable(value):
    if isinstance(value, tuple):
        return [_portable(item) for item in value]
    if isinstance(value, list):
        return [_portable(item) for item in value]
    return value


def _reported_value(field, value):
    if field in ("title", "body"):
        return {"redacted": True, "length": len(value)}
    return _portable(value)


def _safe_report_path(value):
    if not isinstance(value, str):
        return ""
    return value[:MAX_PATH]


def _field_reports(changes):
    return {
        field: {
            "status": "failed",
            "requested": _reported_value(field, changes[field]),
            "rollback": "not_needed",
        }
        for field in _FIELD_ORDER
        if field in changes
    }


def _report(path, node_type, fields, *, applied, rolled_back, error=None):
    report = {
        "action": "edit",
        "original_path": _safe_report_path(path),
        "final_path": _safe_report_path(path) if node_type != "unknown" else None,
        "node_type": node_type,
        "applied": applied,
        "rolled_back": rolled_back,
        "fields": fields,
    }
    if error is not None:
        report["error"] = {"code": error.code, "message": str(error)}
    return report


def _normalized_op_type(value):
    text = str(value or "")
    return "".join(char.lower() for char in text if char.isalnum())


def _node_type(node):
    raw = getattr(node, "OPType", None)
    if raw is None:
        raw = getattr(node, "type", None)
    normalized = _normalized_op_type(raw)
    if normalized == "annotatecomp":
        return "annotateCOMP"
    raise _error(
        "unsupported_annotation_type",
        "target is not an Annotate COMP; unowned Text DAT editing is disabled",
    )


def _par(node, name):
    collection = getattr(node, "par", None)
    if collection is None:
        return None
    try:
        value = getattr(collection, name)
    except (AttributeError, TypeError):
        return None
    return value


def _first_par(node, aliases, field):
    for name in aliases:
        value = _par(node, name)
        if value is not None:
            return value, name
    raise _error(
        "unsupported_annotation_field",
        "%s has no supported parameter binding" % field,
        field=field,
    )


def _constant_mode(par, field):
    try:
        mode = str(par.mode).rsplit(".", 1)[-1].upper()
    except Exception as exc:  # noqa: BLE001
        raise _error(
            "annotation_read_failed",
            "%s parameter mode is unreadable (%s)" % (field, type(exc).__name__),
            field=field,
        )
    if mode != "CONSTANT":
        raise _error(
            "annotation_field_not_constant",
            "%s parameter must be in CONSTANT mode" % field,
            field=field,
        )


def _parameter_binding(node, aliases, field):
    par, name = _first_par(node, aliases, field)
    _constant_mode(par, field)
    return {"kind": "pars", "field": field, "targets": (par,), "names": (name,)}


def _color_binding(node):
    targets = []
    for name in _COLOR_ALIASES:
        par = _par(node, name)
        if par is None:
            raise _error(
                "unsupported_annotation_field",
                "color has no supported RGBA parameter binding",
                field="color",
            )
        _constant_mode(par, "color")
        targets.append(par)
    return {
        "kind": "pars",
        "field": "color",
        "targets": tuple(targets),
        "names": _COLOR_ALIASES,
    }


def _attribute_binding(node, field, attribute):
    try:
        getattr(node, attribute)
    except Exception as exc:  # noqa: BLE001
        raise _error(
            "unsupported_annotation_field",
            "%s geometry is unavailable (%s)" % (field, type(exc).__name__),
            field=field,
        )
    return {
        "kind": "attribute",
        "field": field,
        "target": node,
        "attribute": attribute,
        "names": (attribute,),
    }


def _resolve_binding(node, node_type, field):
    if field in _GEOMETRY_ATTRS:
        return _attribute_binding(node, field, _GEOMETRY_ATTRS[field])
    if field == "title":
        return _parameter_binding(node, _TITLE_ALIASES, field)
    if field == "body":
        return _parameter_binding(node, _BODY_ALIASES, field)
    return _color_binding(node)


def _binding_label(binding):
    names = list(binding["names"])
    return names[0] if len(names) == 1 else names


def _read_geometry(binding):
    value = getattr(binding["target"], binding["attribute"])
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError("geometry is not numeric")
    value = float(value)
    if not math.isfinite(value):
        raise ValueError("geometry is not finite")
    return int(value) if value.is_integer() else value


def _read_attribute_binding(binding):
    if binding["field"] in _GEOMETRY_ATTRS:
        return _read_geometry(binding)
    return str(getattr(binding["target"], binding["attribute"]))


def _read_parameter_binding(binding):
    values = [par.eval() for par in binding["targets"]]
    if binding["field"] == "color":
        channels = tuple(float(value) for value in values)
        if not all(math.isfinite(channel) for channel in channels):
            raise ValueError("color readback is not finite")
        return channels
    return "" if values[0] is None else str(values[0])


def _read_binding(binding):
    try:
        if binding["kind"] == "attribute":
            return _read_attribute_binding(binding)
        return _read_parameter_binding(binding)
    except AnnotationEditError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise _error(
            "annotation_read_failed",
            "%s read failed (%s)" % (binding["field"], type(exc).__name__),
            field=binding["field"],
        )


def _write_binding(binding, value):
    field = binding["field"]
    try:
        if binding["kind"] == "attribute":
            setattr(binding["target"], binding["attribute"], value)
            return
        if field == "color":
            for par, channel in zip(binding["targets"], value):
                par.val = channel
            return
        binding["targets"][0].val = value
    except Exception as exc:  # noqa: BLE001
        raise _error(
            "annotation_write_failed",
            "%s write failed (%s)" % (field, type(exc).__name__),
            field=field,
        )


def _same_value(field, expected, actual):
    if field == "color":
        if not isinstance(expected, (list, tuple)) or not isinstance(
            actual, (list, tuple)
        ):
            return False
        if len(expected) != len(actual):
            return False
        return all(
            abs(float(left) - float(right)) <= 1e-6
            for left, right in zip(expected, actual)
        )
    return expected == actual


def _resolve_snapshot(node, node_type, changes, fields):
    bindings = {}
    snapshot = {}
    for field in _FIELD_ORDER:
        if field not in changes:
            continue
        binding = _resolve_binding(node, node_type, field)
        fields[field]["binding"] = _binding_label(binding)
        bindings[field] = binding
        snapshot[field] = _read_binding(binding)
    return bindings, snapshot


def _set_preflight_failure(fields, error):
    if error.field in fields:
        fields[error.field]["status"] = (
            "unsupported" if error.code == "unsupported_annotation_field" else "failed"
        )
        fields[error.field]["error"] = {"code": error.code, "message": str(error)}


def _rollback_field(field, bindings, snapshot, post_write):
    if field not in post_write:
        raise _error(
            "annotation_rollback_failed",
            "%s post-write state is unknown" % field,
            field=field,
        )
    current = _read_binding(bindings[field])
    if not _same_value(field, post_write[field], current):
        raise _error(
            "annotation_rollback_failed",
            "%s changed concurrently; rollback refused" % field,
            field=field,
        )
    _write_binding(bindings[field], snapshot[field])
    actual = _read_binding(bindings[field])
    if not _same_value(field, snapshot[field], actual):
        raise _error(
            "annotation_rollback_failed",
            "%s rollback readback mismatch" % field,
            field=field,
        )
    return actual


def _rollback(bindings, snapshot, touched, post_write, fields):
    rollback_ok = True
    for field in reversed(touched):
        report = fields[field]
        report["status"] = "failed"
        try:
            actual = _rollback_field(field, bindings, snapshot, post_write)
            report["actual"] = _reported_value(field, actual)
            report["rollback"] = "restored"
        except AnnotationEditError as exc:
            rollback_ok = False
            report["rollback"] = "failed"
            report["error"] = {"code": exc.code, "message": str(exc)}
    return rollback_ok


def _apply_field(field, changes, bindings, snapshot, fields, touched, post_write):
    if _same_value(field, changes[field], snapshot[field]):
        fields[field].update(
            status="unchanged", actual=_reported_value(field, snapshot[field])
        )
        return
    current = _read_binding(bindings[field])
    if not _same_value(field, snapshot[field], current):
        raise _error(
            "annotation_write_failed",
            "%s changed before write; edit refused" % field,
            field=field,
        )
    touched.append(field)
    _write_binding(bindings[field], changes[field])
    actual = _read_binding(bindings[field])
    post_write[field] = actual
    if not _same_value(field, changes[field], actual):
        raise _error(
            "annotation_readback_mismatch",
            "%s readback did not match the requested value" % field,
            field=field,
        )
    fields[field].update(status="applied", actual=_reported_value(field, actual))


def _capture_post_write(field, bindings, touched, post_write):
    if field not in touched or field in post_write:
        return
    try:
        post_write[field] = _read_binding(bindings[field])
    except AnnotationEditError:
        pass


def _apply(_node, path, node_type, changes, bindings, snapshot, fields):
    touched = []
    post_write = {}
    failure = None
    for field in _FIELD_ORDER:
        if field not in changes:
            continue
        try:
            _apply_field(
                field, changes, bindings, snapshot, fields, touched, post_write
            )
        except AnnotationEditError as exc:
            failure = exc
            _capture_post_write(field, bindings, touched, post_write)
            fields[field]["error"] = {"code": exc.code, "message": str(exc)}
            break

    if failure is None:
        return _report(path, node_type, fields, applied=True, rolled_back=False)

    rollback_ok = _rollback(bindings, snapshot, touched, post_write, fields)
    if not rollback_ok:
        failure = _error(
            "annotation_rollback_failed",
            "annotation edit failed and complete rollback was not confirmed",
        )
    return _report(
        path,
        node_type,
        fields,
        applied=False,
        rolled_back=bool(touched) and rollback_ok,
        error=failure,
    )


def edit_annotation(path, changes):
    """Edit one annotation synchronously with exact readback and rollback."""
    report_path = _safe_report_path(path)
    try:
        path = _validate_path(path)
        changes = _validate_changes(changes)
    except AnnotationEditError as exc:
        return _report(
            report_path, "unknown", {}, applied=False, rolled_back=False, error=exc
        )

    fields = _field_reports(changes)
    try:
        import td

        node = td.op(path)
    except Exception as exc:  # noqa: BLE001
        error = _error(
            "annotation_read_failed",
            "annotation lookup failed (%s)" % type(exc).__name__,
        )
        return _report(
            path, "unknown", fields, applied=False, rolled_back=False, error=error
        )
    if node is None:
        error = _error("annotation_not_found", "annotation was not found")
        return _report(
            path, "unknown", fields, applied=False, rolled_back=False, error=error
        )

    try:
        node_type = _node_type(node)
        bindings, snapshot = _resolve_snapshot(node, node_type, changes, fields)
    except AnnotationEditError as exc:
        node_type = locals().get("node_type", "unknown")
        _set_preflight_failure(fields, exc)
        return _report(
            path, node_type, fields, applied=False, rolled_back=False, error=exc
        )
    except Exception as exc:  # noqa: BLE001
        error = _error(
            "annotation_read_failed",
            "annotation preflight failed (%s)" % type(exc).__name__,
        )
        return _report(
            path,
            locals().get("node_type", "unknown"),
            fields,
            applied=False,
            rolled_back=False,
            error=error,
        )

    return _apply(node, path, node_type, changes, bindings, snapshot, fields)
