"""Internal bounded plan/preview/commit foundation for graph operations.

This module deliberately has no route registration and imports no TouchDesigner
globals.  A runtime integration may provide scalar snapshots and a main-thread,
live-verified callback-journal transaction adapter.  Without that capability,
``commit`` fails with ``unverified_live_boundary`` before any mutation.

Preview tokens are stateless HMAC capabilities bound to the authenticated
principal and process instance.  Their private binding covers the complete
canonical plan and exact scalar runtime snapshot, while the public digest covers
only the non-secret shape of a plan.  Terminal recovery is independently bound
to an opaque 256-bit receipt capability; an idempotency key is never lookup
authority.
"""

import base64
import copy
import hashlib
import hmac
import json
import math
import re
import secrets
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field


SCHEMA_VERSION = 1
PREVIEW_TTL_SECONDS = 30.0
RECEIPT_TTL_SECONDS = 300.0
MAX_RECEIPTS = 128
RECEIPT_CAPABILITY_BYTES = 32
MAX_PRINCIPAL_BYTES = 256
MAX_BODY_BYTES = 128 * 1024
MAX_SNAPSHOT_BYTES = 64 * 1024
MAX_SNAPSHOT_DEPTH = 12
MAX_INTENTS = 32
MAX_CREATES = 16
MAX_PARAMETER_WRITES = 128
MAX_METADATA_WRITES = 128
MAX_PARAMETERS_PER_INTENT = 32
MAX_AFFECTED_PATHS = 64
MAX_SELECTED_PATHS = 64
MAX_COORDINATE = 1_000_000
MAX_CONNECTOR_INDEX = 255
MAX_COMMENT_LENGTH = 2_048
MAX_ANNOTATION_TITLE_LENGTH = 512
MAX_ANNOTATION_BODY_LENGTH = 8_192

INERT_OPERATOR_TYPES = frozenset(
    (
        "baseCOMP",
        "constantCHOP",
        "constantTOP",
        "nullCHOP",
        "nullDAT",
        "nullSOP",
        "nullTOP",
        "textDAT",
    )
)
INTENT_KINDS = frozenset(
    (
        "create_operator",
        "set_constant_parameters",
        "edit_metadata",
        "connect",
        "disconnect",
        "create_annotation",
    )
)
TERMINAL_STATUSES = frozenset(
    (
        "applied",
        "reverted",
        "failed_rolled_back",
        "failed_rollback",
        "outcome_unknown",
    )
)
# Identity, rather than a forgeable string, is used as the in-process adapter
# attestation.  It is intentionally useful only to trusted bridge code in this
# process; the public route must remain absent until the live matrix has passed.
_LIVE_TRANSACTION_CAPABILITY = object()

_IDEMPOTENCY_RE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
_REF_RE = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")
_PAR_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,127}$")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
_HEX_RE = re.compile(r"^[a-f0-9]{64}$")
_RECEIPT_CAPABILITY_RE = re.compile(r"^[A-Za-z0-9_-]{43,128}$")
_PATH_SEGMENT_RE = re.compile(r"^[A-Za-z0-9_]+$")
_PUBLIC_ERROR_CODES = frozenset(
    (
        "invalid_operation_plan",
        "unsupported_intent",
        "unsupported_operator_type",
        "operation_capacity",
        "preview_expired",
        "preview_instance_mismatch",
        "stale_plan",
        "operation_busy",
        "perform_mode",
        "ui_unavailable",
        "undo_unavailable",
        "undo_busy",
        "idempotency_conflict",
        "apply_failed",
        "verification_failed",
        "rollback_failed",
        "journal_registration_failed",
        "outcome_unknown",
        "unverified_live_boundary",
        "operation_authority",
        "receipt_unavailable",
        "operation_not_applied",
        "operation_drifted",
        "revert_failed",
        "revert_rollback_failed",
    )
)
_PUBLIC_ERROR_MESSAGES = {
    "apply_failed": "Structured operation application failed.",
    "verification_failed": "Structured operation verification failed.",
    "rollback_failed": "Structured operation rollback did not restore the complete prior state.",
    "journal_registration_failed": "Structured operation journal registration failed.",
    "outcome_unknown": "Structured operation outcome is unknown; inspect with its receipt capability.",
    "operation_authority": "Structured operation authority is unavailable.",
    "receipt_unavailable": "Structured operation receipt is unavailable.",
    "operation_not_applied": "Structured operation is not in an applied state.",
    "operation_drifted": "Structured operation state drifted before compensation.",
    "revert_failed": "Structured operation compensation failed safely.",
    "revert_rollback_failed": "Structured operation compensation rollback failed.",
}
_PUBLIC_ROLLBACK_ERROR_CODES = frozenset(
    ("apply_failed", "rollback_conflict", "rollback_failed", "verification_failed")
)


class OperationPlanError(ValueError):
    """Bounded typed error for a future authenticated bridge envelope."""

    def __init__(self, code, message):
        super().__init__(str(message)[:256])
        self.code = code


def _fail(code, message):
    raise OperationPlanError(code, message)


def _plain_object(value, field):
    if type(value) is not dict:
        _fail("invalid_operation_plan", "%s must be a plain object" % field)
    if any(type(key) is not str for key in value):
        _fail("invalid_operation_plan", "%s keys must be strings" % field)
    return value


def _strict_fields(value, field, required, optional=()):
    value = _plain_object(value, field)
    keys = set(value)
    required = set(required)
    allowed = required | set(optional)
    if keys - allowed:
        _fail("invalid_operation_plan", "%s contains unsupported fields" % field)
    if required - keys:
        _fail("invalid_operation_plan", "%s is missing required fields" % field)
    return value


def _canonical_json(value):
    try:
        return json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            # Public text limits and the body cap are defined in UTF-8 bytes on
            # both sides of the bridge.  Keeping canonical JSON in UTF-8 avoids
            # Python-only ``\\uXXXX`` expansion near those limits.
            ensure_ascii=False,
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeEncodeError) as exc:
        raise OperationPlanError("invalid_operation_plan", "value is not bounded JSON") from exc


def _sha256(value):
    return hashlib.sha256(_canonical_json(value)).hexdigest()


def _utf8_length(value):
    try:
        return len(value.encode("utf-8"))
    except UnicodeEncodeError as exc:
        raise OperationPlanError(
            "invalid_operation_plan", "text contains invalid Unicode"
        ) from exc


def _bounded_text(value, field, minimum, maximum, allow_controls=False):
    if (
        type(value) is not str
        or _utf8_length(value) < minimum
        or _utf8_length(value) > maximum
    ):
        _fail("invalid_operation_plan", "%s is outside its text bounds" % field)
    if not allow_controls and _CONTROL_RE.search(value):
        _fail("invalid_operation_plan", "%s contains control characters" % field)
    return value


def operation_authority_binding(secret, bridge_instance_id, principal):
    """HMAC-bind an authenticated principal without retaining its raw value."""

    principal = _bounded_text(
        principal,
        "authenticated principal",
        1,
        MAX_PRINCIPAL_BYTES,
    )
    return hmac.new(
        bytes(secret),
        _canonical_json(
            {
                "domain": "operation-principal-v1",
                "principal": principal,
                "instance": bridge_instance_id,
            }
        ),
        hashlib.sha256,
    ).hexdigest()


def _normalized_path(value, field, allow_root=False):
    value = _bounded_text(value, field, 1, 1_024)
    if not value.startswith("/") or (value != "/" and value.endswith("/")):
        _fail("invalid_operation_plan", "%s must be a normalized absolute path" % field)
    parts = value.split("/")[1:]
    if any(part in ("", ".", "..") or not _PATH_SEGMENT_RE.fullmatch(part) for part in parts):
        _fail("invalid_operation_plan", "%s must be a normalized absolute path" % field)
    if value == "/" and not allow_root:
        _fail("invalid_operation_plan", "%s cannot be the root path" % field)
    return value


def _parent_path(path):
    parent, _, _ = path.rpartition("/")
    return parent or "/"


def _coordinate(value, field):
    if type(value) is not int or abs(value) > MAX_COORDINATE:
        _fail("invalid_operation_plan", "%s must be a bounded integer" % field)
    return value


def _position(value, field="position"):
    value = _strict_fields(value, field, ("x", "y"))
    return {
        "x": _coordinate(value["x"], "%s.x" % field),
        "y": _coordinate(value["y"], "%s.y" % field),
    }


def _color(value, field="color"):
    if type(value) not in (list, tuple) or len(value) != 3:
        _fail("invalid_operation_plan", "%s must have exactly three channels" % field)
    result = []
    for channel in value:
        if type(channel) not in (int, float) or not math.isfinite(channel):
            _fail("invalid_operation_plan", "%s channels must be finite numbers" % field)
        channel = float(channel)
        if not 0.0 <= channel <= 1.0:
            _fail("invalid_operation_plan", "%s channels must be between 0 and 1" % field)
        result.append(channel)
    return result


def _boolean(value, field):
    if type(value) is not bool:
        _fail("invalid_operation_plan", "%s must be a boolean" % field)
    return value


def _target(value, field):
    value = _plain_object(value, field)
    if set(value) == {"path"}:
        return {"path": _normalized_path(value["path"], "%s.path" % field)}
    if set(value) == {"ref"}:
        ref = value["ref"]
        if type(ref) is not str or not _REF_RE.fullmatch(ref):
            _fail("invalid_operation_plan", "%s.ref is invalid" % field)
        return {"ref": ref}
    _fail("invalid_operation_plan", "%s must contain exactly path or ref" % field)


def _bounded_json_value(value, field, depth=0):
    if depth > 4:
        _fail("invalid_operation_plan", "%s exceeds JSON nesting depth" % field)
    scalar = _bounded_json_scalar(value, field)
    if scalar is not _NOT_SCALAR:
        return scalar
    if type(value) in (list, tuple):
        return _bounded_json_array(value, field, depth)
    if type(value) is dict:
        return _bounded_json_object(value, field, depth)
    _fail("invalid_operation_plan", "%s is not JSON" % field)


_NOT_SCALAR = object()


def _bounded_json_scalar(value, field):
    if value is None or type(value) is bool:
        return value
    if type(value) in (int, float):
        if not math.isfinite(value) or abs(value) > 1e15:
            _fail("invalid_operation_plan", "%s must be a bounded finite number" % field)
        return value
    if type(value) is str:
        return _bounded_text(value, field, 0, 2_048, allow_controls=False)
    return _NOT_SCALAR


def _bounded_json_array(value, field, depth):
    if len(value) > 32:
        _fail("invalid_operation_plan", "%s exceeds its array capacity" % field)
    return [_bounded_json_value(item, "%s[]" % field, depth + 1) for item in value]


def _bounded_json_object(value, field, depth):
    if len(value) > 32 or any(
        type(key) is not str or _utf8_length(key) > 128 for key in value
    ):
        _fail("invalid_operation_plan", "%s exceeds its object capacity" % field)
    return {
        key: _bounded_json_value(value[key], "%s.%s" % (field, key), depth + 1)
        for key in sorted(value)
    }


def _ref(value, field):
    if type(value) is not str or not _REF_RE.fullmatch(value):
        _fail("invalid_operation_plan", "%s is invalid" % field)
    return value


def _name(value, field="name"):
    if type(value) is not str or not _NAME_RE.fullmatch(value):
        _fail("invalid_operation_plan", "%s is not a safe deterministic name" % field)
    return value


def _connector_index(value, field):
    if type(value) is not int or not 0 <= value <= MAX_CONNECTOR_INDEX:
        _fail("invalid_operation_plan", "%s is outside the connector range" % field)
    return value


def _canonical_expected_context(value, owner_path):
    value = _strict_fields(
        value,
        "expected_context",
        ("owner_path", "current_path", "selected_paths"),
    )
    context_owner = _normalized_path(value["owner_path"], "expected_context.owner_path")
    if context_owner != owner_path:
        _fail("invalid_operation_plan", "expected_context owner must match operation owner")
    current = _normalized_path(value["current_path"], "expected_context.current_path")
    selected = value["selected_paths"]
    if type(selected) not in (list, tuple) or not 1 <= len(selected) <= MAX_SELECTED_PATHS:
        _fail("invalid_operation_plan", "expected_context.selected_paths is outside capacity")
    selected = [
        _normalized_path(path, "expected_context.selected_paths") for path in selected
    ]
    if len(set(selected)) != len(selected):
        _fail("invalid_operation_plan", "expected_context.selected_paths contains duplicates")
    if _parent_path(current) != owner_path or any(
        _parent_path(path) != owner_path for path in selected
    ):
        _fail("invalid_operation_plan", "expected_context paths must be immediate owner children")
    return {
        "owner_path": context_owner,
        "current_path": current,
        "selected_paths": sorted(selected),
    }


def _canonical_create(value, annotation=False):
    return _canonical_annotation_create(value) if annotation else _canonical_operator_create(value)


def _canonical_create_base(value, required, optional):
    value = _strict_fields(value, value.get("kind", "intent"), required, optional)
    result = {
        "kind": value["kind"],
        "ref": _ref(value["ref"], "ref"),
        "name": _name(value["name"]),
        "parent": _target(value["parent"], "parent"),
    }
    return value, result


def _canonical_operator_create(value):
    value, result = _canonical_create_base(
        value,
        ("kind", "ref", "type", "name", "parent", "position"),
        ("viewer",),
    )
    operator_type = _bounded_text(value["type"], "type", 1, 64)
    if operator_type not in INERT_OPERATOR_TYPES:
        _fail("unsupported_operator_type", "operator type is outside the inert allowlist")
    result["type"] = operator_type
    result["position"] = _position(value["position"])
    if "viewer" in value:
        result["viewer"] = _boolean(value["viewer"], "viewer")
    return result


def _canonical_annotation_create(value):
    value, result = _canonical_create_base(
        value,
        ("kind", "ref", "name", "parent", "bounds"),
        ("title", "body", "color"),
    )
    bounds = _strict_fields(value["bounds"], "bounds", ("x", "y", "w", "h"))
    width = _coordinate(bounds["w"], "bounds.w")
    height = _coordinate(bounds["h"], "bounds.h")
    if width <= 0 or height <= 0:
        _fail("invalid_operation_plan", "annotation width and height must be positive")
    result["bounds"] = {
        "x": _coordinate(bounds["x"], "bounds.x"),
        "y": _coordinate(bounds["y"], "bounds.y"),
        "w": width,
        "h": height,
    }
    _copy_optional_annotation_fields(value, result)
    return result


def _copy_optional_annotation_fields(value, result):
    if "title" in value:
        result["title"] = _bounded_text(
            value["title"], "title", 0, MAX_ANNOTATION_TITLE_LENGTH, True
        )
    if "body" in value:
        result["body"] = _bounded_text(
            value["body"], "body", 0, MAX_ANNOTATION_BODY_LENGTH, True
        )
    if "color" in value:
        result["color"] = _color(value["color"])


def _canonical_parameters(value):
    value = _strict_fields(value, "set_constant_parameters", ("kind", "target", "values"))
    values = _plain_object(value["values"], "values")
    if not 1 <= len(values) <= MAX_PARAMETERS_PER_INTENT:
        _fail("operation_capacity", "parameter intent exceeds its capacity")
    result = {}
    for name in sorted(values):
        if not _PAR_RE.fullmatch(name):
            _fail("invalid_operation_plan", "parameter name is invalid")
        result[name] = _bounded_json_value(values[name], "values.%s" % name)
        if len(_canonical_json(result[name])) > 4_096:
            _fail("operation_capacity", "parameter value exceeds its serialized capacity")
    return {
        "kind": value["kind"],
        "target": _target(value["target"], "target"),
        "values": result,
    }


def _canonical_metadata(value):
    allowed = ("position", "color", "comment", "viewer", "bypass", "display", "render")
    value = _strict_fields(value, "edit_metadata", ("kind", "target"), allowed)
    present = [field for field in allowed if field in value]
    if not present:
        _fail("invalid_operation_plan", "edit_metadata requires at least one editable field")
    result = {"kind": value["kind"], "target": _target(value["target"], "target")}
    for name in present:
        raw = value[name]
        if name == "position":
            result[name] = _position(raw)
        elif name == "color":
            result[name] = _color(raw)
        elif name == "comment":
            result[name] = _bounded_text(raw, name, 0, MAX_COMMENT_LENGTH, True)
        else:
            result[name] = _boolean(raw, name)
    return result


def _canonical_edge(value):
    value = _strict_fields(
        value,
        value.get("kind", "edge"),
        ("kind", "source", "source_output", "target", "target_input"),
    )
    return {
        "kind": value["kind"],
        "source": _target(value["source"], "source"),
        "source_output": _connector_index(value["source_output"], "source_output"),
        "target": _target(value["target"], "target"),
        "target_input": _connector_index(value["target_input"], "target_input"),
    }


def _canonical_intent(value):
    value = _plain_object(value, "intent")
    kind = value.get("kind")
    if kind not in INTENT_KINDS:
        _fail("unsupported_intent", "intent kind is not supported")
    if kind == "create_operator":
        return _canonical_create(value)
    if kind == "create_annotation":
        return _canonical_create(value, annotation=True)
    if kind == "set_constant_parameters":
        return _canonical_parameters(value)
    if kind == "edit_metadata":
        return _canonical_metadata(value)
    return _canonical_edge(value)


def _resolve_target(target, aliases):
    if "path" in target:
        return target["path"]
    ref = target["ref"]
    if ref not in aliases:
        _fail("invalid_operation_plan", "alias reference must refer to a prior create")
    return aliases[ref]["path"]


def _validate_owner_scope(path, owner_path, field):
    if _parent_path(path) != owner_path:
        _fail("invalid_operation_plan", "%s must be an immediate operation-owner child" % field)


def _simulate_aliases_and_scope(intents, owner_path):
    aliases = {}
    paths = set()
    for intent in intents:
        kind = intent["kind"]
        if kind in ("create_operator", "create_annotation"):
            _register_create_alias(intent, owner_path, aliases, paths)
            continue
        _validate_noncreate_scope(intent, owner_path, aliases)
    _validate_aggregate_write_capacity(intents)
    _reject_direct_created_paths(intents, aliases)
    return aliases


def _validate_aggregate_write_capacity(intents):
    creates = sum(
        intent["kind"] in ("create_operator", "create_annotation") for intent in intents
    )
    parameter_writes = sum(
        len(intent["values"])
        for intent in intents
        if intent["kind"] == "set_constant_parameters"
    )
    metadata_writes = sum(
        len(set(intent) - {"kind", "target"})
        for intent in intents
        if intent["kind"] == "edit_metadata"
    )
    if creates > MAX_CREATES:
        _fail("operation_capacity", "plan exceeds the create capacity")
    if parameter_writes > MAX_PARAMETER_WRITES:
        _fail("operation_capacity", "plan exceeds total parameter write capacity")
    if metadata_writes > MAX_METADATA_WRITES:
        _fail("operation_capacity", "plan exceeds total metadata write capacity")


def _reject_direct_created_paths(intents, aliases):
    created_paths = {fact["path"] for fact in aliases.values()}
    for intent in intents:
        if intent["kind"] in ("create_operator", "create_annotation"):
            continue
        targets = (
            [intent["target"]]
            if "source" not in intent
            else [intent["source"], intent["target"]]
        )
        if any(target.get("path") in created_paths for target in targets):
            _fail(
                "invalid_operation_plan",
                "same-plan created operators must be addressed by ref",
            )


def _register_create_alias(intent, owner_path, aliases, paths):
    parent = _resolve_target(intent["parent"], aliases)
    if "path" in intent["parent"] and parent != owner_path:
        _fail("invalid_operation_plan", "existing create parent must equal operation owner")
    if "ref" in intent["parent"] and aliases[intent["parent"]["ref"]]["type"] != "baseCOMP":
        _fail("invalid_operation_plan", "alias create parent must be a created baseCOMP")
    final_path = "%s/%s" % (parent.rstrip("/"), intent["name"])
    if intent["ref"] in aliases or final_path in paths:
        _fail("invalid_operation_plan", "create alias or deterministic path is duplicated")
    aliases[intent["ref"]] = {
        "path": final_path,
        "type": intent.get("type", "annotateCOMP"),
    }
    paths.add(final_path)


def _validate_noncreate_scope(intent, owner_path, aliases):
    targets = (
        [intent["target"]]
        if "source" not in intent
        else [intent["source"], intent["target"]]
    )
    resolved = [_resolve_target(target, aliases) for target in targets]
    for index, target in enumerate(targets):
        if "path" in target:
            _validate_owner_scope(resolved[index], owner_path, "target")
    if intent["kind"] in ("connect", "disconnect") and _parent_path(
        resolved[0]
    ) != _parent_path(resolved[1]):
        _fail("invalid_operation_plan", "edge endpoints must have the exact same parent")


def canonicalize_operation_plan(payload):
    """Strictly validate and deterministically canonicalize OperationPlanV1."""

    if len(_canonical_json(payload)) > MAX_BODY_BYTES:
        _fail("operation_capacity", "operation payload exceeds 128 KiB")
    payload = _strict_fields(
        payload,
        "operation plan",
        ("schema_version", "label", "owner_path", "intents"),
        ("expected_context",),
    )
    if type(payload["schema_version"]) is not int or payload["schema_version"] != SCHEMA_VERSION:
        _fail("invalid_operation_plan", "schema_version must be 1")
    owner_path = _normalized_path(payload["owner_path"], "owner_path")
    intents = payload["intents"]
    if type(intents) not in (list, tuple) or not 1 <= len(intents) <= MAX_INTENTS:
        _fail("operation_capacity", "intents must contain 1 to 32 entries")
    canonical = {
        "schema_version": SCHEMA_VERSION,
        "label": _bounded_text(payload["label"], "label", 1, 96),
        "owner_path": owner_path,
        "intents": [_canonical_intent(intent) for intent in intents],
    }
    if "expected_context" in payload:
        canonical["expected_context"] = _canonical_expected_context(
            payload["expected_context"], owner_path
        )
    _simulate_aliases_and_scope(canonical["intents"], owner_path)
    return canonical


def _shape_plan(plan):
    """Return a public digest source with project content replaced by type markers."""

    shaped = copy.deepcopy(plan)
    for intent in shaped["intents"]:
        if intent["kind"] == "set_constant_parameters":
            intent["values"] = {name: type(value).__name__ for name, value in intent["values"].items()}
        for field_name in ("comment", "title", "body"):
            if field_name in intent:
                intent[field_name] = "<redacted>"
    return shaped


def _summarize_plan(plan):
    aliases = _simulate_aliases_and_scope(plan["intents"], plan["owner_path"])
    effects = []
    affected = []
    counts = {
        "intents": len(plan["intents"]),
        "creates": 0,
        "parameter_writes": 0,
        "metadata_writes": 0,
        "connects": 0,
        "disconnects": 0,
    }
    for index, intent in enumerate(plan["intents"]):
        paths, fields, count_name, count_delta = _summarize_intent(intent, aliases)
        counts[count_name] += count_delta
        kind = intent["kind"]
        affected.extend(paths)
        effects.append(
            {
                "index": index,
                "kind": kind,
                "target_paths": sorted(set(paths)),
                "field_names": fields,
                "summary": "%s affects %d bounded path(s)" % (kind, len(set(paths))),
            }
        )
    affected = sorted(set(affected))
    if len(affected) > MAX_AFFECTED_PATHS:
        _fail("operation_capacity", "plan exceeds affected path capacity")
    return aliases, effects, affected, counts


def _summarize_intent(intent, aliases):
    kind = intent["kind"]
    if kind in ("create_operator", "create_annotation"):
        paths = [aliases[intent["ref"]]["path"]]
        candidates = (
            ["type", "name", "position", "viewer"]
            if kind == "create_operator"
            else ["name", "bounds", "title", "body", "color"]
        )
        fields = [
            field
            for field in candidates
            if field in intent or field in ("type", "name", "position")
        ]
        return paths, fields, "creates", 1
    if kind == "set_constant_parameters":
        fields = sorted(intent["values"])
        return [_resolve_target(intent["target"], aliases)], fields, "parameter_writes", len(fields)
    if kind == "edit_metadata":
        fields = sorted(set(intent) - {"kind", "target"})
        return [_resolve_target(intent["target"], aliases)], fields, "metadata_writes", len(fields)
    paths = [
        _resolve_target(intent["source"], aliases),
        _resolve_target(intent["target"], aliases),
    ]
    count_name = "connects" if kind == "connect" else "disconnects"
    return paths, ["source_output", "target_input"], count_name, 1


def _safe_scalar(value, field, depth=0):
    if depth > MAX_SNAPSHOT_DEPTH:
        _fail("operation_capacity", "%s exceeds snapshot nesting depth" % field)
    scalar = _safe_scalar_primitive(value, field)
    if scalar is not _NOT_SCALAR:
        return scalar
    if type(value) in (list, tuple):
        return _safe_scalar_array(value, field, depth)
    if type(value) is dict:
        return _safe_scalar_object(value, field, depth)
    _fail("invalid_operation_plan", "%s contains a runtime proxy or non-scalar value" % field)


def _safe_scalar_primitive(value, field):
    if value is None or type(value) in (bool, int, str):
        if type(value) is str and _utf8_length(value) > 4_096:
            _fail("operation_capacity", "%s contains an oversized string" % field)
        return value
    if type(value) is float:
        if not math.isfinite(value):
            _fail("invalid_operation_plan", "%s contains a non-finite number" % field)
        return value
    return _NOT_SCALAR


def _safe_scalar_array(value, field, depth):
    if len(value) > 256:
        _fail("operation_capacity", "%s exceeds snapshot array capacity" % field)
    return [_safe_scalar(item, field, depth + 1) for item in value]


def _safe_scalar_object(value, field, depth):
    if len(value) > 256 or any(
        type(key) is not str or _utf8_length(key) > 256 for key in value
    ):
        _fail("operation_capacity", "%s exceeds snapshot object capacity" % field)
    return {key: _safe_scalar(value[key], field, depth + 1) for key in sorted(value)}


def _derive_state_contract(plan, aliases, affected_paths):
    """Derive the exact scalar snapshot fields required by every intent.

    This contract contains names and connector indexes only.  Runtime values
    remain in the private snapshot/HMAC and never enter previews or receipts.
    Same-plan creates are still required to report an empty state because they
    must be absent before the first write.
    """

    contract = {
        path: {"parameters": set(), "metadata": set(), "inputs": set(), "outputs": set()}
        for path in affected_paths
    }
    for intent in plan["intents"]:
        kind = intent["kind"]
        if kind == "set_constant_parameters":
            path = _resolve_target(intent["target"], aliases)
            contract[path]["parameters"].update(intent["values"])
        elif kind == "edit_metadata":
            path = _resolve_target(intent["target"], aliases)
            contract[path]["metadata"].update(set(intent) - {"kind", "target"})
        elif kind in ("connect", "disconnect"):
            source = _resolve_target(intent["source"], aliases)
            target = _resolve_target(intent["target"], aliases)
            contract[source]["outputs"].add(intent["source_output"])
            contract[target]["inputs"].add(intent["target_input"])
    return contract


def _validate_snapshot(snapshot, plan, affected_paths, requested_types, aliases):
    snapshot = _strict_fields(
        snapshot,
        "runtime snapshot",
        (
            "schema_version",
            "td_build",
            "project_identity",
            "owner",
            "context",
            "runtime_types",
            "entities",
        ),
    )
    owner_identity = _validate_snapshot_header(snapshot, plan)
    _validate_runtime_types(snapshot["runtime_types"], requested_types)
    state_contract = _derive_state_contract(plan, aliases, affected_paths)
    entities = _validate_snapshot_entities(
        snapshot["entities"],
        affected_paths,
        {fact["path"] for fact in aliases.values()},
        state_contract,
        owner_identity,
    )
    _validate_connector_intents(plan, aliases, entities, state_contract)
    _validate_snapshot_context(snapshot["context"], plan.get("expected_context"))
    safe = _safe_scalar(snapshot, "runtime snapshot")
    if len(_canonical_json(safe)) > MAX_SNAPSHOT_BYTES:
        _fail("operation_capacity", "runtime snapshot exceeds 64 KiB")
    return safe


def _validate_snapshot_header(snapshot, plan):
    if type(snapshot["schema_version"]) is not int or snapshot["schema_version"] != SCHEMA_VERSION:
        _fail("invalid_operation_plan", "runtime snapshot schema is unsupported")
    _bounded_text(snapshot["td_build"], "runtime td_build", 1, 128)
    _bounded_text(snapshot["project_identity"], "runtime project identity", 1, 256)
    owner = _strict_fields(snapshot["owner"], "runtime owner", ("path", "identity", "type"))
    owner_identity = _validate_native_identity(owner["identity"], "runtime owner identity")
    owner_type = _bounded_text(owner["type"], "runtime owner type", 1, 128)
    if (
        owner["path"] != plan["owner_path"]
        or not owner_type.endswith("COMP")
    ):
        _fail("stale_plan", "runtime owner does not match the bounded plan")
    return owner_identity


def _validate_native_identity(value, field):
    if type(value) is int and value != 0:
        return value
    if type(value) is str:
        return _bounded_text(value, field, 1, 256)
    _fail("invalid_operation_plan", "%s is not a bounded native identity" % field)


def _validate_runtime_types(value, requested_types):
    runtime_types = _plain_object(value, "runtime_types")
    if set(runtime_types) != set(requested_types):
        _fail("unsupported_operator_type", "runtime type resolution is incomplete")
    for type_name, fact in runtime_types.items():
        fact = _strict_fields(fact, "runtime type", ("resolved_name", "creatable"))
        if fact["resolved_name"] != type_name or fact["creatable"] is not True:
            _fail("unsupported_operator_type", "allowlisted operator is not creatable")


def _validate_snapshot_entities(
    entities, affected_paths, expected_absent_paths, state_contract, owner_identity
):
    if type(entities) not in (list, tuple) or len(entities) > MAX_AFFECTED_PATHS:
        _fail("operation_capacity", "runtime entity snapshot exceeds capacity")
    facts = [_validate_snapshot_entity(entity) for entity in entities]
    entity_paths = [fact["path"] for fact in facts]
    if sorted(entity_paths) != sorted(affected_paths) or len(set(entity_paths)) != len(entity_paths):
        _fail("invalid_operation_plan", "runtime snapshot must cover each affected path exactly once")
    identities = [fact["identity"] for fact in facts if fact["identity"] is not None]
    if len(set(identities)) != len(identities):
        _fail("stale_plan", "runtime snapshot contains duplicated native identities")
    if owner_identity in identities:
        _fail("stale_plan", "runtime owner identity collides with a child entity")
    for fact in facts:
        expected_absent = fact["path"] in expected_absent_paths
        if expected_absent == fact["exists"]:
            _fail(
                "stale_plan",
                "runtime entity existence does not match the deterministic plan",
            )
        _validate_snapshot_entity_state(
            fact["state"], state_contract[fact["path"]], expected_absent, fact["path"]
        )
    return {fact["path"]: fact for fact in facts}


def _validate_snapshot_entity(entity):
    entity = _strict_fields(
        entity,
        "runtime entity",
        ("path", "exists", "identity", "type", "state"),
    )
    if type(entity["exists"]) is not bool:
        _fail("invalid_operation_plan", "runtime entity existence must be boolean")
    path = _normalized_path(entity["path"], "runtime entity path")
    _validate_snapshot_entity_presence(entity)
    return {
        "path": path,
        "exists": entity["exists"],
        "identity": entity["identity"],
        "type": entity["type"],
        "state": entity["state"],
    }


def _validate_snapshot_entity_presence(entity):
    if entity["exists"]:
        _validate_existing_snapshot_entity(entity)
    else:
        _validate_absent_snapshot_entity(entity)


def _validate_existing_snapshot_entity(entity):
    _validate_native_identity(entity["identity"], "runtime entity identity")
    _bounded_text(entity["type"], "runtime entity type", 1, 128)


def _validate_absent_snapshot_entity(entity):
    if entity["identity"] is not None or entity["type"] is not None:
        _fail("invalid_operation_plan", "absent runtime entity cannot have identity or type")


def _validate_snapshot_entity_state(state, required, expected_absent, entity_path):
    if type(state) is not dict:
        _fail(
            "invalid_operation_plan",
            "runtime entity state contains a runtime proxy or is not a scalar object",
        )
    if expected_absent:
        if state:
            _fail("invalid_operation_plan", "absent runtime entity state must be empty")
        return
    state = _strict_fields(
        state,
        "runtime entity state",
        ("parameters", "metadata", "connectors"),
    )
    _validate_parameter_state(state["parameters"], required["parameters"])
    _validate_metadata_state(state["metadata"], required["metadata"])
    _validate_connector_state(state["connectors"], required, entity_path)


def _validate_parameter_state(parameters, required_names):
    parameters = _plain_object(parameters, "runtime parameters")
    if set(parameters) != set(required_names):
        _fail(
            "invalid_operation_plan",
            "runtime parameter state must exactly cover requested parameter names",
        )
    for name in sorted(parameters):
        fact = _strict_fields(
            parameters[name],
            "runtime parameter fact",
            ("style", "mode", "value", "writable"),
        )
        _bounded_text(fact["style"], "runtime parameter style", 1, 64)
        _bounded_text(fact["mode"], "runtime parameter mode", 1, 64)
        value = _bounded_json_value(fact["value"], "runtime parameter value")
        if len(_canonical_json(value)) > 4_096:
            _fail("operation_capacity", "runtime parameter value exceeds 4 KiB")
        if fact["writable"] is not True:
            _fail("stale_plan", "requested runtime parameter is not writable")


def _validate_metadata_state(metadata, required_fields):
    metadata = _plain_object(metadata, "runtime metadata")
    if set(metadata) != set(required_fields):
        _fail(
            "invalid_operation_plan",
            "runtime metadata state must exactly cover requested fields",
        )
    for field_name in sorted(metadata):
        fact = _strict_fields(
            metadata[field_name],
            "runtime metadata fact",
            ("value", "writable"),
        )
        _validate_metadata_value(field_name, fact["value"])
        if fact["writable"] is not True:
            _fail("stale_plan", "requested runtime metadata field is not writable")


def _validate_metadata_value(field_name, value):
    if field_name == "position":
        _position(value, "runtime metadata position")
    elif field_name == "color":
        _color(value, "runtime metadata color")
    elif field_name == "comment":
        _bounded_text(value, "runtime metadata comment", 0, MAX_COMMENT_LENGTH, True)
    elif field_name in ("viewer", "bypass", "display", "render"):
        _boolean(value, "runtime metadata %s" % field_name)
    else:
        _fail("invalid_operation_plan", "runtime metadata field is unsupported")


def _validate_connector_state(connectors, required, entity_path):
    connectors = _strict_fields(connectors, "runtime connectors", ("inputs", "outputs"))
    _validate_connector_map(
        connectors["inputs"], required["inputs"], "inputs", entity_path
    )
    _validate_connector_map(
        connectors["outputs"], required["outputs"], "outputs", entity_path
    )


def _validate_connector_map(value, required_indexes, direction, entity_path):
    value = _plain_object(value, "runtime connector %s" % direction)
    expected_keys = {str(index) for index in required_indexes}
    if set(value) != expected_keys:
        _fail(
            "invalid_operation_plan",
            "runtime connector state must exactly cover requested indexes",
        )
    for index_text in sorted(value, key=int):
        if str(int(index_text)) != index_text or not 0 <= int(index_text) <= MAX_CONNECTOR_INDEX:
            _fail("invalid_operation_plan", "runtime connector index is invalid")
        if direction == "inputs":
            fact = _strict_fields(value[index_text], "runtime input connector", ("occupants",))
            _validate_connector_peers(
                fact["occupants"], "source_path", "source_output", entity_path
            )
        else:
            fact = _strict_fields(value[index_text], "runtime output connector", ("targets",))
            _validate_connector_peers(
                fact["targets"], "target_path", "target_input", entity_path
            )


def _validate_connector_peers(peers, path_field, index_field, entity_path):
    if type(peers) not in (list, tuple) or len(peers) > MAX_AFFECTED_PATHS:
        _fail("operation_capacity", "runtime connector occupancy exceeds capacity")
    normalized = []
    for peer in peers:
        peer = _strict_fields(peer, "runtime connector peer", (path_field, index_field))
        path = _normalized_path(peer[path_field], "runtime connector peer path")
        if _parent_path(path) != _parent_path(entity_path):
            _fail("stale_plan", "runtime connector peer is outside the exact network")
        index = _connector_index(peer[index_field], "runtime connector peer index")
        normalized.append((path, index))
    if len(set(normalized)) != len(normalized) or normalized != sorted(normalized):
        _fail(
            "invalid_operation_plan",
            "runtime connector peers must be unique and deterministically ordered",
        )


def _validate_connector_intents(plan, aliases, entities, state_contract):
    input_occupants, output_targets = _initial_connector_state(
        entities, state_contract
    )
    for intent in plan["intents"]:
        if intent["kind"] in ("connect", "disconnect"):
            _simulate_connector_intent(
                intent, aliases, input_occupants, output_targets
            )


def _initial_connector_state(entities, state_contract):
    input_occupants = {}
    output_targets = {}
    for path, required in state_contract.items():
        _add_initial_connector_state(
            path,
            required,
            entities[path],
            input_occupants,
            output_targets,
        )
    return input_occupants, output_targets


def _add_initial_connector_state(
    path, required, entity, input_occupants, output_targets
):
    if not entity["exists"]:
        _add_empty_connector_state(path, required, input_occupants, output_targets)
        return
    connectors = entity["state"]["connectors"]
    for index in required["inputs"]:
        input_occupants[(path, index)] = {
            (peer["source_path"], peer["source_output"])
            for peer in connectors["inputs"][str(index)]["occupants"]
        }
    for index in required["outputs"]:
        output_targets[(path, index)] = {
            (peer["target_path"], peer["target_input"])
            for peer in connectors["outputs"][str(index)]["targets"]
        }


def _add_empty_connector_state(path, required, input_occupants, output_targets):
    for index in required["inputs"]:
        input_occupants[(path, index)] = set()
    for index in required["outputs"]:
        output_targets[(path, index)] = set()


def _simulate_connector_intent(intent, aliases, input_occupants, output_targets):
    source = _resolve_target(intent["source"], aliases)
    target = _resolve_target(intent["target"], aliases)
    source_key = (source, intent["source_output"])
    target_key = (target, intent["target_input"])
    output_edge = (target, intent["target_input"])
    input_edge = (source, intent["source_output"])
    in_output = output_edge in output_targets[source_key]
    in_input = input_edge in input_occupants[target_key]
    if in_output != in_input:
        _fail("stale_plan", "runtime connector edge presence is inconsistent")
    if intent["kind"] == "disconnect":
        _simulate_disconnect(
            input_occupants, output_targets, source_key, target_key, input_edge, output_edge
        )
        return
    if in_output:
        return
    if input_occupants[target_key]:
        _fail("stale_plan", "connect target input is already occupied")
    output_targets[source_key].add(output_edge)
    input_occupants[target_key].add(input_edge)


def _simulate_disconnect(
    input_occupants, output_targets, source_key, target_key, input_edge, output_edge
):
    if output_edge not in output_targets[source_key]:
        _fail("stale_plan", "disconnect edge is absent from the runtime snapshot")
    output_targets[source_key].remove(output_edge)
    input_occupants[target_key].remove(input_edge)


def _validate_snapshot_context(context, expected):
    if expected is None:
        return
    if context is None:
        _fail("ui_unavailable", "a context-bound plan requires an active Network Editor")
    if _safe_scalar(context, "runtime context") != expected:
        _fail("stale_plan", "active editor context changed")


@dataclass(frozen=True)
class PreparedOperation:
    canonical_plan: dict
    plan_digest: str
    private_fingerprint: str
    snapshot: dict
    aliases: dict
    effects: tuple
    affected_paths: tuple
    counts: dict


@dataclass(frozen=True)
class RollbackError:
    index: int
    code: str
    message: str

    def public(self):
        code = self.code if type(self.code) is str else ""
        if code not in _PUBLIC_ROLLBACK_ERROR_CODES:
            code = "rollback_failed"
        return {
            "index": int(self.index),
            "code": code,
            "message": "Rollback step did not restore its expected state.",
        }


@dataclass(frozen=True)
class RollbackReport:
    attempted: bool = False
    succeeded: bool = True
    errors: tuple = field(default_factory=tuple)

    def public(self):
        return {
            "attempted": bool(self.attempted),
            "succeeded": bool(self.succeeded),
            "errors": [error.public() for error in self.errors[:32]],
        }


@dataclass(frozen=True)
class JournalReport:
    registered: bool = False
    operation_id: str = None
    label: str = None
    native_stack_delta: int = 0
    observed_state: str = "unknown"

    def public(self):
        return {
            "registered": bool(self.registered),
            "operation_id": str(self.operation_id)[:128]
            if self.operation_id is not None
            else None,
            "label": str(self.label)[:128] if self.label is not None else None,
            "native_stack_delta": self.native_stack_delta if self.native_stack_delta in (0, 1) else 0,
            "observed_state": self.observed_state
            if self.observed_state in ("applied", "undone", "redone", "drifted", "unknown")
            else "unknown",
        }


@dataclass(frozen=True)
class TransactionOutcome:
    """Scalar-only result returned by a future live-verified transaction adapter."""

    status: str
    operation_id: str
    results: tuple
    verification_status: str
    verification_snapshot: str
    rollback: RollbackReport = field(default_factory=RollbackReport)
    journal: JournalReport = field(default_factory=JournalReport)
    warnings: tuple = field(default_factory=tuple)
    error_code: str = None
    error_message: str = None
    private_journal: object = None


@dataclass(frozen=True)
class RevertTransactionOutcome:
    """Trusted scalar-only result of one compensating TD transaction."""

    status: str
    source_operation_id: str
    revert_operation_id: str
    verification_status: str
    verification_snapshot: str
    rollback: RollbackReport = field(default_factory=RollbackReport)
    journal: JournalReport = field(default_factory=JournalReport)
    warnings: tuple = field(default_factory=tuple)
    error_code: str = None
    private_journal: object = None


class ScalarSnapshotAdapter:
    """Runtime boundary: implementations must return JSON scalars, never TD proxies."""

    def capture(self, canonical_plan, affected_paths, requested_operator_types):
        raise NotImplementedError


class LiveTransactionAdapter:
    """Unavailable until the callback-journal live matrix has passed."""

    capability = None

    def execute(self, prepared, operation_id, label):
        raise NotImplementedError

    def validate_journal_v2(self, journal):
        raise NotImplementedError

    def observe_journal(self, journal):
        raise NotImplementedError

    def execute_revert(self, journal, revert_operation_id, label):
        raise NotImplementedError


class OperationMutationGate:
    """One non-queued process-local gate shared by commit and compensation."""

    def __init__(self):
        self._lock = threading.Lock()
        self._active = False

    def acquire(self):
        with self._lock:
            if self._active:
                return False
            self._active = True
            return True

    def release(self):
        with self._lock:
            if not self._active:
                _fail("outcome_unknown", "operation mutation gate is not active")
            self._active = False


class OperationRecordStore:
    """Bounded authority records owning receipts and private journals together.

    ``dedupe_id`` is a service-generated HMAC and is never accepted as lookup
    authority.  A terminal lookup needs the operation id, the independently
    generated 256-bit capability, the same principal binding and the same bridge
    instance.  The store retains scalars only; raw authenticated principals and
    TouchDesigner objects never cross this boundary.  A record's public receipt,
    private reversible journal, lineage and expiry are committed atomically.
    """

    def __init__(self, clock=None, ttl_seconds=RECEIPT_TTL_SECONDS, capacity=MAX_RECEIPTS):
        self._clock = clock or time.monotonic
        self._ttl = float(ttl_seconds)
        self._capacity = int(capacity)
        if (
            not math.isfinite(self._ttl)
            or self._ttl <= PREVIEW_TTL_SECONDS
            or not 1 <= self._capacity <= MAX_RECEIPTS
        ):
            _fail("invalid_operation_plan", "receipt store bounds are invalid")
        self._records = OrderedDict()
        self._by_operation_id = {}
        self._lock = threading.RLock()

    @staticmethod
    def _validate_reservation(
        dedupe_id,
        fingerprint,
        operation_id,
        receipt_capability,
        authority_binding,
        bridge_instance_id,
    ):
        if any(
            type(value) is not str or not _HEX_RE.fullmatch(value)
            for value in (dedupe_id, fingerprint, authority_binding)
        ):
            _fail("invalid_operation_plan", "receipt reservation binding is invalid")
        if type(operation_id) is not str or not _IDEMPOTENCY_RE.fullmatch(operation_id):
            _fail("invalid_operation_plan", "operation identity is invalid")
        if (
            type(receipt_capability) is not str
            or not _RECEIPT_CAPABILITY_RE.fullmatch(receipt_capability)
        ):
            _fail("invalid_operation_plan", "receipt capability is invalid")
        if (
            type(bridge_instance_id) is not str
            or not _IDEMPOTENCY_RE.fullmatch(bridge_instance_id)
        ):
            _fail("invalid_operation_plan", "bridge instance id is invalid")

    def _remove_locked(self, dedupe_id):
        record = self._records.pop(dedupe_id, None)
        if record is not None:
            self._by_operation_id.pop(record["operation_id"], None)
            pinned = self._records.get(record.get("pinned_source_dedupe"))
            if pinned is not None:
                pinned["active_children"] = max(0, pinned["active_children"] - 1)

    def _prune_locked(self):
        now = float(self._clock())
        for dedupe_id, record in list(self._records.items()):
            if (
                record["receipt"] is not None
                and record["expires_at"] <= now
                and record["active_children"] == 0
            ):
                self._remove_locked(dedupe_id)

    def _make_room_locked(self):
        if len(self._records) < self._capacity:
            return
        if all(record["receipt"] is None for record in self._records.values()):
            _fail("operation_busy", "receipt capacity is occupied by active operations")
        # A terminal receipt may still be protecting a live preview token from
        # duplicate dispatch.  Never evict it merely to admit newer work.
        _fail("operation_capacity", "receipt retention capacity is exhausted")

    @staticmethod
    def _public_replay(record):
        receipt = copy.deepcopy(record["receipt"])
        # A failed terminal outcome must remain visibly failed on retry.  Only a
        # previously applied operation becomes the success-like replay status.
        if receipt["status"] in ("applied", "reverted"):
            receipt["status"] = "replayed"
        return receipt

    @staticmethod
    def _same_authority(record, authority_binding, bridge_instance_id):
        return hmac.compare_digest(
            record["authority_binding"], authority_binding
        ) and hmac.compare_digest(record["bridge_instance_id"], bridge_instance_id)

    def _existing_replay_locked(
        self,
        record,
        fingerprint,
        authority_binding,
        bridge_instance_id,
    ):
        if not hmac.compare_digest(record["fingerprint"], fingerprint):
            _fail("idempotency_conflict", "idempotency key is bound to another plan")
        if not self._same_authority(record, authority_binding, bridge_instance_id):
            _fail("operation_authority", "operation authority is unavailable")
        if record["receipt"] is not None:
            return self._public_replay(record)
        _fail("operation_busy", "the idempotent operation is already active")

    def _reserve_locked(
        self,
        dedupe_id,
        fingerprint,
        operation_id,
        receipt_capability,
        authority_binding,
        bridge_instance_id,
        generation=0,
        direction="forward",
        lineage=None,
    ):
        self._make_room_locked()
        if operation_id in self._by_operation_id:
            _fail("operation_capacity", "operation identity collision")
        pinned_source_dedupe = None
        if direction == "compensating_revert":
            source_operation_id = lineage["source_operation_id"]
            pinned_source_dedupe = self._by_operation_id.get(source_operation_id)
            source = (
                self._records.get(pinned_source_dedupe)
                if pinned_source_dedupe is not None
                else None
            )
            if (
                source is None
                or source["receipt"] is None
                or source["superseded_by"] is not None
            ):
                _fail("receipt_unavailable", "compensation source is unavailable")
            source["active_children"] += 1
        self._records[dedupe_id] = {
            "fingerprint": fingerprint,
            "operation_id": operation_id,
            "receipt_capability": receipt_capability,
            "authority_binding": authority_binding,
            "bridge_instance_id": bridge_instance_id,
            "receipt": None,
            "private_journal": None,
            "generation": int(generation),
            "direction": direction,
            "lineage": copy.deepcopy(
                lineage
                or {
                    "root_operation_id": operation_id,
                    "source_operation_id": None,
                }
            ),
            "superseded_by": None,
            "active_children": 0,
            "pinned_source_dedupe": pinned_source_dedupe,
            # Active reservations never expire or participate in eviction.
            # Losing one after dispatch could permit a duplicate mutation.
            "expires_at": None,
        }
        self._by_operation_id[operation_id] = dedupe_id

    @staticmethod
    def _valid_lineage_operation_id(value, allow_none=False):
        if value is None:
            return allow_none
        return type(value) is str and _IDEMPOTENCY_RE.fullmatch(value) is not None

    @classmethod
    def _validated_lineage(cls, generation, direction, lineage):
        normalized = lineage or {
            "root_operation_id": None,
            "source_operation_id": None,
        }
        valid_shape = type(normalized) is dict and set(normalized) == {
            "root_operation_id",
            "source_operation_id",
        }
        valid_generation = type(generation) is int and 0 <= generation <= MAX_RECEIPTS
        valid_direction = direction in ("forward", "compensating_revert")
        if not valid_shape or not valid_generation or not valid_direction:
            _fail("invalid_operation_plan", "operation lineage is invalid")
        if not cls._valid_lineage_operation_id(normalized["root_operation_id"]):
            _fail("invalid_operation_plan", "operation lineage is invalid")
        if not cls._valid_lineage_operation_id(
            normalized["source_operation_id"],
            allow_none=True,
        ):
            _fail("invalid_operation_plan", "operation lineage is invalid")
        return normalized

    def begin(
        self,
        dedupe_id,
        fingerprint,
        operation_id,
        receipt_capability,
        authority_binding,
        bridge_instance_id,
        generation=0,
        direction="forward",
        lineage=None,
    ):
        self._validate_reservation(
            dedupe_id,
            fingerprint,
            operation_id,
            receipt_capability,
            authority_binding,
            bridge_instance_id,
        )
        default_lineage = {
            "root_operation_id": operation_id,
            "source_operation_id": None,
        }
        lineage = self._validated_lineage(
            generation,
            direction,
            lineage or default_lineage,
        )
        with self._lock:
            self._prune_locked()
            record = self._records.get(dedupe_id)
            if record is not None:
                return self._existing_replay_locked(
                    record,
                    fingerprint,
                    authority_binding,
                    bridge_instance_id,
                )
            self._reserve_locked(
                dedupe_id,
                fingerprint,
                operation_id,
                receipt_capability,
                authority_binding,
                bridge_instance_id,
                generation,
                direction,
                lineage,
            )
            return None

    @staticmethod
    def _bounded_record_value(value, field):
        if value is None:
            return None
        safe = _safe_scalar(value, field)
        if len(_canonical_json(safe)) > MAX_SNAPSHOT_BYTES:
            _fail("operation_capacity", "%s exceeds 64 KiB" % field)
        return safe

    def _source_to_supersede_locked(self, record, operation_id):
        if operation_id is None:
            return None
        source_dedupe = self._by_operation_id.get(operation_id)
        source = self._records.get(source_dedupe) if source_dedupe is not None else None
        if source is None or record["lineage"].get("source_operation_id") != operation_id:
            _fail("operation_authority", "compensation lineage changed")
        return source

    def _completion_record_locked(self, dedupe_id, fingerprint):
        record = self._records.get(dedupe_id)
        if record is None or not hmac.compare_digest(record["fingerprint"], fingerprint):
            _fail("idempotency_conflict", "idempotency reservation changed")
        return record

    @staticmethod
    def _validate_completion_authority(record, receipt):
        receipt_operation_id = receipt.get(
            "operation_id",
            receipt.get("revert_operation_id"),
        )
        if receipt_operation_id != record["operation_id"] or receipt.get(
            "receipt_capability"
        ) != record["receipt_capability"]:
            _fail("operation_authority", "terminal receipt authority changed")

    def _store_completion_locked(self, dedupe_id, record, receipt, journal, source):
        record["receipt"] = copy.deepcopy(receipt)
        record["private_journal"] = copy.deepcopy(journal)
        record["expires_at"] = float(self._clock()) + self._ttl
        if source is not None:
            source["superseded_by"] = record["operation_id"]
        pinned = self._records.get(record["pinned_source_dedupe"])
        if pinned is not None:
            pinned["active_children"] = max(0, pinned["active_children"] - 1)
        record["pinned_source_dedupe"] = None
        self._records.move_to_end(dedupe_id)

    def complete(
        self,
        dedupe_id,
        fingerprint,
        receipt,
        private_journal=None,
        supersedes_operation_id=None,
    ):
        safe = self._bounded_record_value(receipt, "terminal receipt")
        if safe.get("status") not in TERMINAL_STATUSES:
            _fail("invalid_operation_plan", "receipt is not terminal")
        safe_journal = self._bounded_record_value(
            private_journal,
            "private operation journal",
        )
        with self._lock:
            record = self._completion_record_locked(dedupe_id, fingerprint)
            self._validate_completion_authority(record, safe)
            source = self._source_to_supersede_locked(record, supersedes_operation_id)
            self._store_completion_locked(
                dedupe_id,
                record,
                safe,
                safe_journal,
                source,
            )
        return copy.deepcopy(safe)

    def abandon(self, dedupe_id, fingerprint):
        with self._lock:
            record = self._records.get(dedupe_id)
            if record is not None and record["receipt"] is None and hmac.compare_digest(
                record["fingerprint"], fingerprint
            ):
                self._remove_locked(dedupe_id)

    def replay(self, dedupe_id, fingerprint, authority_binding, bridge_instance_id):
        """Replay a commit response; this is deduplication, not receipt lookup."""

        with self._lock:
            self._prune_locked()
            record = self._records.get(dedupe_id)
            if record is None:
                return None
            if not hmac.compare_digest(record["fingerprint"], fingerprint):
                _fail("idempotency_conflict", "idempotency key is bound to another plan")
            if not self._same_authority(record, authority_binding, bridge_instance_id):
                _fail("operation_authority", "operation authority is unavailable")
            if record["receipt"] is None:
                _fail("operation_busy", "the idempotent operation is already active")
            return self._public_replay(record)

    def lookup(self, operation_id, receipt_capability, authority_binding, bridge_instance_id):
        """Return a terminal receipt only when all independent authorities match."""

        with self._lock:
            self._prune_locked()
            dedupe_id = self._by_operation_id.get(operation_id)
            record = self._records.get(dedupe_id) if dedupe_id is not None else None
            if record is None or record["receipt"] is None:
                return None
            if not self._same_authority(record, authority_binding, bridge_instance_id):
                return None
            if not hmac.compare_digest(record["receipt_capability"], receipt_capability):
                return None
            return copy.deepcopy(record["receipt"])

    def lookup_private(
        self,
        operation_id,
        receipt_capability,
        authority_binding,
        bridge_instance_id,
    ):
        """Return a scalar private record only after full receipt authority."""

        with self._lock:
            self._prune_locked()
            dedupe_id = self._by_operation_id.get(operation_id)
            record = self._records.get(dedupe_id) if dedupe_id is not None else None
            if record is None or record["receipt"] is None:
                return None
            if not self._same_authority(record, authority_binding, bridge_instance_id):
                return None
            if not hmac.compare_digest(record["receipt_capability"], receipt_capability):
                return None
            return {
                "receipt": copy.deepcopy(record["receipt"]),
                "private_journal": copy.deepcopy(record["private_journal"]),
                "generation": record["generation"],
                "direction": record["direction"],
                "lineage": copy.deepcopy(record["lineage"]),
                "superseded_by": record["superseded_by"],
                "expires_at": record["expires_at"],
            }


# Compatibility for existing direct clients/tests while the private-record name
# is promoted through the unregistered compensation slice.
TerminalReceiptStore = OperationRecordStore


class OperationPlanService:
    """Stateless preview plus fail-closed, adapter-gated commit orchestration."""

    def __init__(
        self,
        snapshot_adapter,
        transaction_adapter=None,
        secret=None,
        bridge_instance_id=None,
        clock=None,
        receipt_store=None,
        mutation_gate=None,
    ):
        if not isinstance(snapshot_adapter, ScalarSnapshotAdapter):
            _fail("invalid_operation_plan", "a scalar snapshot adapter is required")
        self._snapshot_adapter = snapshot_adapter
        self._transaction_adapter = transaction_adapter
        self._secret = bytes(secret) if secret is not None else secrets.token_bytes(32)
        if len(self._secret) < 32:
            _fail("invalid_operation_plan", "preview HMAC key must be at least 32 bytes")
        self.bridge_instance_id = bridge_instance_id or secrets.token_urlsafe(18)
        if not _IDEMPOTENCY_RE.fullmatch(self.bridge_instance_id):
            _fail("invalid_operation_plan", "bridge instance id is invalid")
        self._clock = clock or time.time
        self._receipts = receipt_store or OperationRecordStore()
        self._mutation_gate = mutation_gate or OperationMutationGate()

    def _prepare(self, payload):
        plan = canonicalize_operation_plan(payload)
        aliases, effects, affected, counts = _summarize_plan(plan)
        requested_types = sorted(
            {
                intent["type"]
                for intent in plan["intents"]
                if intent["kind"] == "create_operator"
            }
        )
        raw_snapshot = self._snapshot_adapter.capture(
            copy.deepcopy(plan), tuple(affected), tuple(requested_types)
        )
        snapshot = _validate_snapshot(raw_snapshot, plan, affected, requested_types, aliases)
        private_fingerprint = hmac.new(
            self._secret,
            _canonical_json({"plan": plan, "snapshot": snapshot}),
            hashlib.sha256,
        ).hexdigest()
        return PreparedOperation(
            canonical_plan=plan,
            plan_digest=_sha256(_shape_plan(plan)),
            private_fingerprint=private_fingerprint,
            snapshot=snapshot,
            aliases=aliases,
            effects=tuple(effects),
            affected_paths=tuple(affected),
            counts=counts,
        )

    def _has_live_transaction_adapter(self):
        adapter = self._transaction_adapter
        return (
            isinstance(adapter, LiveTransactionAdapter)
            and getattr(adapter, "capability", None) is _LIVE_TRANSACTION_CAPABILITY
        )

    def _authority_binding(self, principal):
        return operation_authority_binding(
            self._secret,
            self.bridge_instance_id,
            principal,
        )

    def _commit_bindings(self, plan, key, authority_binding):
        fingerprint = hmac.new(
            self._secret,
            _canonical_json(
                {
                    "domain": "operation-commit-v1",
                    "key": key,
                    "plan": plan,
                    "authority": authority_binding,
                    "instance": self.bridge_instance_id,
                }
            ),
            hashlib.sha256,
        ).hexdigest()
        dedupe_id = hmac.new(
            self._secret,
            _canonical_json(
                {
                    "domain": "operation-dedupe-v1",
                    "key": key,
                    "authority": authority_binding,
                    "instance": self.bridge_instance_id,
                }
            ),
            hashlib.sha256,
        ).hexdigest()
        return dedupe_id, fingerprint

    def _sign_token(self, prepared, expires_at, authority_binding):
        payload = {
            "v": SCHEMA_VERSION,
            "instance": self.bridge_instance_id,
            "expires_at": float(expires_at),
            "binding": prepared.private_fingerprint,
        }
        encoded = base64.urlsafe_b64encode(_canonical_json(payload)).rstrip(b"=")
        signature = hmac.new(
            self._secret,
            encoded + b"." + authority_binding.encode("ascii"),
            hashlib.sha256,
        ).digest()
        return "%s.%s" % (
            encoded.decode("ascii"),
            base64.urlsafe_b64encode(signature).rstrip(b"=").decode("ascii"),
        )

    def _decode_token(self, token, authority_binding, enforce_expiry=True):
        encoded, signature, payload = self._parse_token(token)
        payload = _strict_fields(
            payload,
            "preview token",
            ("v", "instance", "expires_at", "binding"),
        )
        self._authenticate_token(encoded, signature, payload, authority_binding)
        self._validate_token_claims(payload, enforce_expiry)
        return payload

    @staticmethod
    def _parse_token(token):
        if type(token) is not str or len(token) > 1_024 or token.count(".") != 1:
            _fail("stale_plan", "preview token is invalid")
        encoded_text, signature_text = token.split(".")
        try:
            encoded = encoded_text.encode("ascii")
            signature = base64.urlsafe_b64decode(signature_text + "=" * (-len(signature_text) % 4))
            payload_bytes = base64.urlsafe_b64decode(encoded_text + "=" * (-len(encoded_text) % 4))
            payload = json.loads(payload_bytes.decode("utf-8"))
        except Exception as exc:  # noqa: BLE001 - malformed base64 is one bounded error.
            raise OperationPlanError("stale_plan", "preview token is invalid") from exc
        return encoded, signature, payload

    def _authenticate_token(self, encoded, signature, payload, authority_binding):
        if payload["instance"] != self.bridge_instance_id:
            _fail("preview_instance_mismatch", "preview belongs to another bridge instance")
        expected = hmac.new(
            self._secret,
            encoded + b"." + authority_binding.encode("ascii"),
            hashlib.sha256,
        ).digest()
        if not hmac.compare_digest(expected, signature):
            _fail("operation_authority", "preview authority is unavailable")

    def _validate_token_claims(self, payload, enforce_expiry):
        if (
            type(payload["v"]) is not int
            or payload["v"] != SCHEMA_VERSION
            or type(payload["binding"]) is not str
            or not _HEX_RE.fullmatch(payload["binding"])
        ):
            _fail("stale_plan", "preview token is invalid")
        if (
            type(payload["expires_at"]) not in (int, float)
            or not math.isfinite(payload["expires_at"])
        ):
            _fail("stale_plan", "preview token is invalid")
        if enforce_expiry and float(self._clock()) > float(payload["expires_at"]):
            _fail("preview_expired", "preview token expired")

    def preview(self, payload, principal):
        authority_binding = self._authority_binding(principal)
        prepared = self._prepare(payload)
        expires_at = float(self._clock()) + PREVIEW_TTL_SECONDS
        live_adapter = self._has_live_transaction_adapter()
        return {
            "status": "preview",
            "schema_version": SCHEMA_VERSION,
            "bridge_instance_id": self.bridge_instance_id,
            "preview_token": self._sign_token(
                prepared,
                expires_at,
                authority_binding,
            ),
            "expires_at": _iso_utc(expires_at),
            "plan_digest": prepared.plan_digest,
            "owner_path": prepared.canonical_plan["owner_path"],
            "label": prepared.canonical_plan["label"],
            "effects": [copy.deepcopy(effect) for effect in prepared.effects],
            "affected_paths": list(prepared.affected_paths),
            "counts": copy.deepcopy(prepared.counts),
            "risk": "bounded_graph_mutation",
            "rollback_coverage": "complete_for_allowlist"
            if live_adapter
            else "unverified_for_allowlist",
            "journal_eligible": live_adapter,
            "warnings": []
            if live_adapter
            else [
                "Native callback-journal execution remains UNVERIFIED pending an authorized disposable bridge."
            ],
        }

    def _validate_commit(self, payload):
        if len(_canonical_json(payload)) > MAX_BODY_BYTES:
            _fail("operation_capacity", "operation commit exceeds 128 KiB")
        payload = _strict_fields(
            payload,
            "operation commit",
            (
                "schema_version",
                "label",
                "owner_path",
                "intents",
                "preview_token",
                "idempotency_key",
            ),
            ("expected_context",),
        )
        key = payload["idempotency_key"]
        if type(key) is not str or not _IDEMPOTENCY_RE.fullmatch(key):
            _fail("invalid_operation_plan", "idempotency_key is invalid")
        token = payload["preview_token"]
        plan = {name: copy.deepcopy(value) for name, value in payload.items() if name not in ("preview_token", "idempotency_key")}
        return canonicalize_operation_plan(plan), token, key

    def prepare_commit(self, payload, principal):
        """Re-prepare and CAS-check without writing or reserving idempotency."""

        plan, token, key = self._validate_commit(payload)
        authority_binding = self._authority_binding(principal)
        token_data = self._decode_token(token, authority_binding)
        prepared = self._prepare(plan)
        if not hmac.compare_digest(token_data["binding"], prepared.private_fingerprint):
            _fail("stale_plan", "operation state changed after preview")
        _, fingerprint = self._commit_bindings(plan, key, authority_binding)
        return prepared, key, fingerprint

    def commit(self, payload, principal):
        plan, token, key = self._validate_commit(payload)
        authority_binding = self._authority_binding(principal)
        token_data = self._decode_token(
            token,
            authority_binding,
            enforce_expiry=False,
        )
        dedupe_id, fingerprint = self._commit_bindings(plan, key, authority_binding)
        replay = self._receipts.replay(
            dedupe_id,
            fingerprint,
            authority_binding,
            self.bridge_instance_id,
        )
        if replay is not None:
            return replay
        if float(self._clock()) > float(token_data["expires_at"]):
            _fail("preview_expired", "preview token expired")
        prepared = self._prepare(plan)
        if not hmac.compare_digest(token_data["binding"], prepared.private_fingerprint):
            _fail("stale_plan", "operation state changed after preview")
        adapter = self._transaction_adapter
        if not self._has_live_transaction_adapter():
            _fail(
                "unverified_live_boundary",
                "native callback-journal commit is unavailable pending live verification",
            )
        operation_id = secrets.token_urlsafe(18)
        receipt_capability = secrets.token_urlsafe(RECEIPT_CAPABILITY_BYTES)
        raced_replay = self._receipts.begin(
            dedupe_id,
            fingerprint,
            operation_id,
            receipt_capability,
            authority_binding,
            self.bridge_instance_id,
        )
        if raced_replay is not None:
            return raced_replay
        if not self._mutation_gate.acquire():
            self._receipts.abandon(dedupe_id, fingerprint)
            _fail("operation_busy", "another structured mutation is active")
        label = ("MCP operation %s · %s" % (prepared.canonical_plan["label"], operation_id[:8]))[:128]
        try:
            try:
                outcome = adapter.execute(prepared, operation_id, label)
                receipt = self._receipt_from_outcome(
                    prepared,
                    outcome,
                    expected_operation_id=operation_id,
                    expected_label=label,
                    receipt_capability=receipt_capability,
                )
                private_journal = outcome.private_journal
            except Exception:  # noqa: BLE001 - never leak native exception content.
                receipt = self._unknown_receipt(
                    prepared,
                    operation_id,
                    receipt_capability,
                )
                private_journal = None
            try:
                return self._receipts.complete(
                    dedupe_id,
                    fingerprint,
                    receipt,
                    private_journal=private_journal,
                )
            except OperationPlanError:
                # Adapter-shaped output must never strand a completed mutation
                # without a terminal record owned by the same reservation.
                return self._receipts.complete(
                    dedupe_id,
                    fingerprint,
                    self._unknown_receipt(
                        prepared,
                        operation_id,
                        receipt_capability,
                    ),
                )
        finally:
            self._mutation_gate.release()

    def _receipt_from_outcome(
        self,
        prepared,
        outcome,
        expected_operation_id,
        expected_label,
        receipt_capability,
    ):
        if not isinstance(outcome, TransactionOutcome) or outcome.status not in TERMINAL_STATUSES:
            return self._unknown_receipt(
                prepared,
                expected_operation_id,
                receipt_capability,
            )
        if outcome.status == "outcome_unknown":
            return self._unknown_receipt(
                prepared,
                expected_operation_id,
                receipt_capability,
            )
        if outcome.operation_id != expected_operation_id:
            _fail("outcome_unknown", "transaction operation identity is invalid")
        self._validate_outcome_semantics(outcome, expected_operation_id, expected_label)
        results = self._public_results(prepared, outcome)
        receipt = {
            "status": outcome.status,
            "operation_id": expected_operation_id,
            "receipt_capability": receipt_capability,
            "bridge_instance_id": self.bridge_instance_id,
            "plan_digest": prepared.plan_digest,
            "owner_path": prepared.canonical_plan["owner_path"],
            "affected_paths": list(prepared.affected_paths),
            "results": results,
            "verification": {
                "status": outcome.verification_status if outcome.verification_status in ("PASS", "FAIL") else "FAIL",
                "snapshot": outcome.verification_snapshot if outcome.verification_snapshot in ("before", "after", "unknown") else "unknown",
            },
            "rollback": outcome.rollback.public(),
            "journal": outcome.journal.public(),
            "warnings": ["Transaction adapter reported a bounded warning."]
            if outcome.warnings
            else [],
        }
        if outcome.status != "applied":
            receipt["error"] = self._public_outcome_error(outcome)
        return receipt

    @staticmethod
    def _public_results(prepared, outcome):
        if type(outcome.results) not in (list, tuple) or len(outcome.results) != len(
            prepared.canonical_plan["intents"]
        ):
            _fail("outcome_unknown", "transaction result coverage is incomplete")
        statuses = {
            "applied": {"applied", "unchanged"},
            "failed_rolled_back": {"rolled_back", "unchanged"},
            "failed_rollback": {"rolled_back", "rollback_failed", "unchanged"},
        }[outcome.status]
        seen_indexes = set()
        return [
            OperationPlanService._public_result(
                prepared,
                result,
                statuses,
                seen_indexes,
            )
            for result in outcome.results
        ]

    @staticmethod
    def _public_result(prepared, raw_result, statuses, seen_indexes):
        result = _strict_fields(
            raw_result,
            "transaction result",
            ("index", "kind", "status", "final_paths"),
        )
        index = result["index"]
        intents = prepared.canonical_plan["intents"]
        invalid_identity = (
            type(index) is not int
            or not 0 <= index < len(intents)
            or index in seen_indexes
        )
        if invalid_identity or result["kind"] != intents[index]["kind"]:
            _fail("invalid_operation_plan", "transaction result is invalid")
        if result["status"] not in statuses:
            _fail("invalid_operation_plan", "transaction result status is invalid")
        seen_indexes.add(index)
        allowed_paths = prepared.effects[index]["target_paths"]
        if (
            type(result["final_paths"]) not in (list, tuple)
            or not result["final_paths"]
            or len(result["final_paths"]) > len(allowed_paths)
        ):
            _fail("operation_capacity", "transaction result path coverage is invalid")
        final_paths = [_normalized_path(path, "final_path") for path in result["final_paths"]]
        if len(set(final_paths)) != len(final_paths):
            _fail("invalid_operation_plan", "transaction result paths are duplicated")
        if not set(final_paths).issubset(set(allowed_paths)):
            _fail("outcome_unknown", "transaction result escaped its affected paths")
        return {
            "index": index,
            "kind": result["kind"],
            "status": result["status"],
            "final_paths": final_paths,
        }

    @staticmethod
    def _public_outcome_error(outcome):
        fallback_code = (
            "rollback_failed" if outcome.status == "failed_rollback" else "apply_failed"
        )
        error_code = (
            outcome.error_code
            if type(outcome.error_code) is str and outcome.error_code in _PUBLIC_ERROR_CODES
            else fallback_code
        )
        return {
            "code": error_code,
            "message": _PUBLIC_ERROR_MESSAGES.get(
                error_code,
                "Structured operation did not establish a safe final state.",
            ),
        }

    @staticmethod
    def _validate_outcome_semantics(outcome, expected_operation_id, expected_label):
        OperationPlanService._validate_outcome_report_shapes(outcome)
        validators = {
            "applied": OperationPlanService._is_applied_outcome,
            "failed_rolled_back": OperationPlanService._is_rolled_back_outcome,
            "failed_rollback": OperationPlanService._is_rollback_failure_outcome,
        }
        valid = validators[outcome.status](outcome, expected_operation_id, expected_label)
        if not valid:
            _fail("outcome_unknown", "transaction outcome safety claims are inconsistent")

    @staticmethod
    def _validate_outcome_report_shapes(outcome):
        if not isinstance(outcome.rollback, RollbackReport) or not isinstance(
            outcome.journal, JournalReport
        ):
            _fail("outcome_unknown", "transaction safety reports are invalid")
        if type(outcome.results) not in (list, tuple):
            _fail("outcome_unknown", "transaction result coverage is invalid")
        if type(outcome.warnings) not in (list, tuple) or len(outcome.warnings) > 16:
            _fail("outcome_unknown", "transaction warning coverage is invalid")
        OperationPlanService._validate_rollback_error_shapes(outcome)

    @staticmethod
    def _validate_rollback_error_shapes(outcome):
        if len(outcome.rollback.errors) > 32 or any(
            not isinstance(error, RollbackError)
            or type(error.index) is not int
            or not 0 <= error.index < MAX_INTENTS
            for error in outcome.rollback.errors
        ):
            _fail("outcome_unknown", "rollback error coverage is invalid")
        error_indexes = [error.index for error in outcome.rollback.errors]
        if len(set(error_indexes)) != len(error_indexes):
            _fail("outcome_unknown", "rollback error indexes are duplicated")
        if outcome.status == "failed_rollback":
            failed_indexes = {
                result.get("index")
                for result in outcome.results
                if type(result) is dict and result.get("status") == "rollback_failed"
            }
            if not error_indexes or set(error_indexes) != failed_indexes:
                _fail("outcome_unknown", "rollback errors do not match failed results")

    @staticmethod
    def _is_applied_outcome(outcome, expected_operation_id, expected_label):
        journal = outcome.journal
        rollback = outcome.rollback
        return (
            outcome.verification_status == "PASS"
            and outcome.verification_snapshot == "after"
            and rollback.attempted is False
            and rollback.succeeded is True
            and not rollback.errors
            and journal.registered is True
            and journal.operation_id == expected_operation_id
            and journal.label == expected_label
            and journal.native_stack_delta == 1
            and journal.observed_state == "applied"
            and outcome.error_code is None
            and outcome.error_message is None
            and type(outcome.private_journal) is dict
            and outcome.private_journal.get("schema_version") == 2
        )

    @staticmethod
    def _is_rolled_back_outcome(outcome, _expected_operation_id, _expected_label):
        return (
            outcome.verification_status == "PASS"
            and outcome.verification_snapshot == "before"
            and outcome.rollback.attempted is True
            and outcome.rollback.succeeded is True
            and not outcome.rollback.errors
            and OperationPlanService._journal_is_clear(outcome.journal)
            and outcome.private_journal is None
        )

    @staticmethod
    def _is_rollback_failure_outcome(outcome, _expected_operation_id, _expected_label):
        return (
            outcome.verification_status == "FAIL"
            and outcome.verification_snapshot in ("before", "unknown")
            and outcome.rollback.attempted is True
            and outcome.rollback.succeeded is False
            and OperationPlanService._journal_is_clear(outcome.journal)
            and outcome.private_journal is None
        )

    @staticmethod
    def _journal_is_clear(journal):
        return (
            journal.registered is False
            and journal.operation_id is None
            and journal.label is None
            and journal.native_stack_delta == 0
            and journal.observed_state == "unknown"
        )

    def _unknown_receipt(self, prepared, operation_id, receipt_capability):
        return {
            "status": "outcome_unknown",
            "operation_id": operation_id,
            "receipt_capability": receipt_capability,
            "bridge_instance_id": self.bridge_instance_id,
            "plan_digest": prepared.plan_digest,
            "owner_path": prepared.canonical_plan["owner_path"],
            "affected_paths": list(prepared.affected_paths),
            "results": [],
            "verification": {"status": "FAIL", "snapshot": "unknown"},
            "rollback": RollbackReport(attempted=False, succeeded=False).public(),
            "journal": JournalReport().public(),
            "warnings": ["Native transaction outcome could not be established."],
            "error": {
                "code": "outcome_unknown",
                "message": "Structured operation outcome is unknown; inspect with its receipt capability.",
            },
        }

    def get_terminal_receipt(self, operation_id, receipt_capability, principal):
        if type(operation_id) is not str or not _IDEMPOTENCY_RE.fullmatch(operation_id):
            _fail("invalid_operation_plan", "operation identity is invalid")
        if (
            type(receipt_capability) is not str
            or not _RECEIPT_CAPABILITY_RE.fullmatch(receipt_capability)
        ):
            _fail("receipt_unavailable", "structured operation receipt is unavailable")
        authority_binding = self._authority_binding(principal)
        receipt = self._receipts.lookup(
            operation_id,
            receipt_capability,
            authority_binding,
            self.bridge_instance_id,
        )
        if receipt is None:
            _fail("receipt_unavailable", "structured operation receipt is unavailable")
        return receipt

    def get_private_operation_record(self, operation_id, receipt_capability, principal):
        """Trusted in-process lookup; callers must never serialize its journal."""

        if type(operation_id) is not str or not _IDEMPOTENCY_RE.fullmatch(operation_id):
            _fail("invalid_operation_plan", "operation identity is invalid")
        if (
            type(receipt_capability) is not str
            or not _RECEIPT_CAPABILITY_RE.fullmatch(receipt_capability)
        ):
            _fail("receipt_unavailable", "structured operation receipt is unavailable")
        record = self._receipts.lookup_private(
            operation_id,
            receipt_capability,
            self._authority_binding(principal),
            self.bridge_instance_id,
        )
        if record is None:
            _fail("receipt_unavailable", "structured operation receipt is unavailable")
        return record


def _iso_utc(timestamp):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(float(timestamp)))


__all__ = (
    "INERT_OPERATOR_TYPES",
    "OperationPlanError",
    "OperationPlanService",
    "OperationMutationGate",
    "OperationRecordStore",
    "PreparedOperation",
    "RollbackError",
    "RollbackReport",
    "JournalReport",
    "ScalarSnapshotAdapter",
    "LiveTransactionAdapter",
    "TerminalReceiptStore",
    "TransactionOutcome",
    "RevertTransactionOutcome",
    "canonicalize_operation_plan",
    "operation_authority_binding",
)
