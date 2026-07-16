"""Atomic structured edits for TouchDesigner operator metadata.

The service uses only first-class TD operator properties and ``COMP.copy``.  A
same-parent edit snapshots every requested field and rolls all applied fields
back on failure.  A cross-parent move copies first, applies/readbacks metadata on
the copy, and destroys the source last; failures destroy the copy and preserve
the source whenever TD's readback confirms that state.
"""

import math
import re

_MAX_PATH = 1024
_MAX_NAME = 128
_MAX_COMMENT = 2048
_MAX_COORDINATE = 1_000_000
_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_FLAGS = ("display", "render", "viewer", "bypass", "lock", "cloneImmune", "allowCooking")
_FIELD_ATTRS = {
    "name": "name",
    "node_x": "nodeX",
    "node_y": "nodeY",
    "color": "color",
    "comment": "comment",
    **{flag: flag for flag in _FLAGS},
}
_APPLY_ORDER = (
    "name",
    "node_x",
    "node_y",
    "color",
    "comment",
    "display",
    "render",
    "viewer",
    "bypass",
    "lock",
    "cloneImmune",
    "allowCooking",
)
_ALLOWED = set(_FIELD_ATTRS) | {"parent_path"}


def _validate_op_path(value, field="path"):
    if not isinstance(value, str) or not value.startswith("/"):
        raise ValueError("metadata: %s must be an absolute operator path" % field)
    if len(value) > _MAX_PATH or "\x00" in value or "\n" in value or "\r" in value:
        raise ValueError("metadata: invalid %s" % field)
    return value.rstrip("/") or "/"


def _validate_name(value):
    if not isinstance(value, str) or not _NAME.fullmatch(value) or len(value) > _MAX_NAME:
        raise ValueError(
            "metadata: name must match [A-Za-z_][A-Za-z0-9_]* and be at most %d characters"
            % _MAX_NAME
        )
    return value


def _validate_coordinate(value, field):
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("metadata: %s must be an integer" % field)
    if abs(value) > _MAX_COORDINATE:
        raise ValueError("metadata: %s is outside the supported range" % field)
    return value


def _validate_color(value):
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        raise ValueError("metadata: color must contain exactly three channels")
    out = []
    for channel in value:
        if isinstance(channel, bool) or not isinstance(channel, (int, float)):
            raise ValueError("metadata: color channels must be finite numbers from 0 to 1")
        channel = float(channel)
        if not math.isfinite(channel) or not 0.0 <= channel <= 1.0:
            raise ValueError("metadata: color channels must be finite numbers from 0 to 1")
        out.append(channel)
    return tuple(out)


def _validate_comment(value):
    if not isinstance(value, str) or len(value) > _MAX_COMMENT or "\x00" in value:
        raise ValueError(
            "metadata: comment must be a string of at most %d characters" % _MAX_COMMENT
        )
    return value


def _validate_flag(value, field):
    if type(value) is not bool:  # noqa: E721 - reject integer truthiness
        raise ValueError("metadata: %s must be a boolean" % field)
    return value


def _validate_change(field, value):
    if field == "name":
        return _validate_name(value)
    if field == "parent_path":
        return _validate_op_path(value, field)
    if field in ("node_x", "node_y"):
        return _validate_coordinate(value, field)
    if field == "color":
        return _validate_color(value)
    if field == "comment":
        return _validate_comment(value)
    return _validate_flag(value, field)


def _validated_changes(changes):
    if not isinstance(changes, dict) or not changes:
        raise ValueError("metadata: at least one metadata field is required")
    unknown = sorted(set(changes) - _ALLOWED)
    if unknown:
        raise ValueError("metadata: unsupported fields: %s" % ", ".join(unknown))
    return {field: _validate_change(field, value) for field, value in changes.items()}


def _parent(node):
    value = getattr(node, "parent", None)
    return value() if callable(value) else value


def _path(node):
    try:
        return str(node.path)
    except Exception:  # noqa: BLE001
        return None


def _jsonable(value):
    if isinstance(value, tuple):
        return list(value)
    return value


def _read_field(node, field):
    attr = _FIELD_ATTRS[field]
    value = getattr(node, attr)
    if field == "color":
        value = tuple(float(channel) for channel in value)
    return value


def _write_field(node, field, value):
    setattr(node, _FIELD_ATTRS[field], value)


def _same_value(expected, actual):
    if isinstance(expected, tuple) and isinstance(actual, tuple) and len(expected) == len(actual):
        return all(abs(float(left) - float(right)) <= 1e-6 for left, right in zip(expected, actual))
    return expected == actual


def _field_report(changes):
    return {
        field: {"requested": _jsonable(value), "actual": None, "status": "pending"}
        for field, value in changes.items()
    }


def _existing_child(parent, name, ignore=None):
    try:
        for child in list(parent.children or []):
            if child is not ignore and getattr(child, "name", None) == name:
                return child
    except Exception:  # noqa: BLE001
        return None
    return None


def _prevalidate_node_fields(node, changes):
    for field in changes:
        if field == "parent_path":
            continue
        try:
            _read_field(node, field)
        except Exception as exc:  # noqa: BLE001
            raise ValueError("metadata: field %s is not readable/writable on this operator: %s" % (field, exc))


def _destroy_and_verify(td, node):
    node_path = _path(node)
    try:
        node.destroy()
    except Exception:  # noqa: BLE001
        return False
    if not node_path:
        return True
    try:
        return td.op(node_path) is None
    except Exception:  # noqa: BLE001
        return False


def _apply_same_parent_fields(node, changes, fields):
    applied = []
    for field in _APPLY_ORDER:
        if field not in changes:
            continue
        applied.append(field)
        try:
            _write_field(node, field, changes[field])
            actual = _read_field(node, field)
            fields[field]["actual"] = _jsonable(actual)
            if not _same_value(changes[field], actual):
                raise RuntimeError("readback did not match requested value")
            fields[field]["status"] = "applied"
        except Exception as exc:  # noqa: BLE001
            fields[field]["status"] = "failed"
            fields[field]["error"] = str(exc)
            return applied, "metadata: applying %s failed: %s" % (field, exc)
    return applied, None


def _rollback_fields(node, applied, snapshot, fields):
    rollback_ok = True
    for field in reversed(applied):
        try:
            _write_field(node, field, snapshot[field])
            actual = _read_field(node, field)
            if not _same_value(snapshot[field], actual):
                raise RuntimeError("rollback readback mismatch")
            fields[field]["actual"] = _jsonable(actual)
            fields[field]["status"] = "rolled_back"
        except Exception as exc:  # noqa: BLE001
            rollback_ok = False
            fields[field]["status"] = "rollback_failed"
            fields[field]["error"] = str(exc)
    return rollback_ok


def _mark_pending_not_applied(fields):
    for report in fields.values():
        if report["status"] == "pending":
            report["status"] = "not_applied"


def _edit_report(original_path, final_path, applied, rolled_back, fields, error=None):
    report = {
        "original_path": original_path,
        "final_path": final_path,
        "applied": applied,
        "rolled_back": rolled_back,
        "fields": fields,
    }
    if error is not None:
        report["error"] = error
    return report


def _same_parent_edit(node, original_path, changes):
    fields = _field_report(changes)
    snapshot = {field: _read_field(node, field) for field in changes if field != "parent_path"}
    if "parent_path" in changes:
        fields["parent_path"].update(actual=changes["parent_path"], status="unchanged")
    applied, failure = _apply_same_parent_fields(node, changes, fields)
    if failure is None:
        return _edit_report(original_path, _path(node), True, False, fields)
    rollback_ok = _rollback_fields(node, applied, snapshot, fields)
    _mark_pending_not_applied(fields)
    return _edit_report(original_path, _path(node), False, rollback_ok, fields, failure)


def _mark_applied_rollback(fields, rollback_ok):
    for report in fields.values():
        if report["status"] == "applied":
            report["status"] = "rolled_back" if rollback_ok else "rollback_failed"


def _copy_for_move(source, destination, changes, fields):
    final_name = changes.get("name", getattr(source, "name", None))
    destination_path = _path(destination)
    copy_node = destination.copy(source, name=final_name)
    if copy_node is None:
        raise RuntimeError("destination.copy returned no operator")
    expected_path = destination_path.rstrip("/") + "/" + final_name
    if _path(copy_node) != expected_path:
        raise RuntimeError("copy path readback did not match %s" % expected_path)
    fields["parent_path"].update(actual=destination_path, status="applied")
    if "name" in changes:
        fields["name"].update(actual=getattr(copy_node, "name", None), status="applied")
    return copy_node


def _apply_move_fields(copy_node, changes, fields):
    for field in _APPLY_ORDER:
        if field not in changes or field == "name":
            continue
        _write_field(copy_node, field, changes[field])
        actual = _read_field(copy_node, field)
        fields[field]["actual"] = _jsonable(actual)
        if not _same_value(changes[field], actual):
            raise RuntimeError("%s readback did not match requested value" % field)
        fields[field]["status"] = "applied"


def _op_exists(td, path):
    try:
        return td.op(path) is not None
    except Exception:  # noqa: BLE001
        return False


def _move_prepare_failure(td, copy_node, original_path, fields, exc):
    rollback_ok = copy_node is None or _destroy_and_verify(td, copy_node)
    _mark_applied_rollback(fields, rollback_ok)
    _mark_pending_not_applied(fields)
    return _edit_report(
        original_path,
        original_path,
        False,
        rollback_ok,
        fields,
        "metadata: move preparation failed: %s" % exc,
    )


def _move_destroy_failure(td, copy_node, original_path, fields, exc):
    copy_removed = _destroy_and_verify(td, copy_node)
    source_preserved = _op_exists(td, original_path)
    rollback_ok = copy_removed and source_preserved
    _mark_applied_rollback(fields, rollback_ok)
    return _edit_report(
        original_path,
        original_path if source_preserved else None,
        False,
        rollback_ok,
        fields,
        "metadata: source destroy failed after copy: %s" % exc,
    )


def _move_destroy_readback_failure(td, copy_node, original_path, fields):
    copy_removed = _destroy_and_verify(td, copy_node)
    _mark_applied_rollback(fields, copy_removed)
    return {
        "original_path": original_path,
        "final_path": original_path,
        "applied": False,
        "rolled_back": copy_removed,
        "fields": fields,
        "error": "metadata: source still resolved after destroy",
    }


def _move_edit(td, source, destination, original_path, changes):
    fields = _field_report(changes)
    copy_node = None
    try:
        copy_node = _copy_for_move(source, destination, changes, fields)
        _apply_move_fields(copy_node, changes, fields)
    except Exception as exc:  # noqa: BLE001
        return _move_prepare_failure(td, copy_node, original_path, fields, exc)

    try:
        source.destroy()
    except Exception as exc:  # noqa: BLE001
        return _move_destroy_failure(td, copy_node, original_path, fields, exc)
    if _op_exists(td, original_path):
        return _move_destroy_readback_failure(td, copy_node, original_path, fields)
    return _edit_report(original_path, _path(copy_node), True, False, fields)


def _source_context(td, path, changes):
    source = td.op(path)
    if source is None:
        raise LookupError("metadata: operator not found: %s" % path)
    original_path = _path(source) or path
    source_parent = _parent(source)
    if source_parent is None:
        raise ValueError("metadata: operator has no editable parent")
    _prevalidate_node_fields(source, changes)
    return source, original_path, source_parent, _path(source_parent)


def _move_destination(td, source, original_path, requested_parent_path, final_name):
    destination = td.op(requested_parent_path)
    if destination is None:
        raise LookupError("metadata: destination parent not found: %s" % requested_parent_path)
    if requested_parent_path == original_path or requested_parent_path.startswith(
        original_path.rstrip("/") + "/"
    ):
        raise ValueError("metadata: cannot move an operator into itself or its descendant")
    if not callable(getattr(destination, "copy", None)):
        raise ValueError("metadata: destination does not support COMP.copy")
    if not callable(getattr(source, "destroy", None)):
        raise ValueError("metadata: source cannot be destroyed after copy")
    if _existing_child(destination, final_name) is not None:
        raise ValueError("metadata: destination already has a child named %s" % final_name)
    return destination


def _validate_local_rename(source_parent, source, changes):
    requested_name = changes.get("name")
    if requested_name is None or requested_name == getattr(source, "name", None):
        return
    if _existing_child(source_parent, requested_name, ignore=source) is not None:
        raise ValueError("metadata: parent already has a child named %s" % requested_name)


def edit_metadata(path, changes):
    """Apply a bounded metadata patch with readback and transaction-like rollback."""
    import td

    path = _validate_op_path(path)
    changes = _validated_changes(changes)
    source, original_path, source_parent, source_parent_path = _source_context(td, path, changes)
    requested_parent_path = changes.get("parent_path", source_parent_path)
    final_name = changes.get("name", getattr(source, "name", None))
    if requested_parent_path != source_parent_path:
        destination = _move_destination(td, source, original_path, requested_parent_path, final_name)
        return _move_edit(td, source, destination, original_path, changes)
    _validate_local_rename(source_parent, source, changes)
    return _same_parent_edit(source, original_path, changes)


# Explicit long name for controller readability; both names share the same safe implementation.
edit_node_metadata = edit_metadata
