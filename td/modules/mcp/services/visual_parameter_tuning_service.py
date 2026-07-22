"""Bounded structured scalar tuning for ``enhance_build`` visual critique.

The module accepts data only: no code, expression, callable, parameter mode or
operator type is caller-controlled.  TouchDesigner objects are resolved and used
only inside the synchronous request callback; retained inspection/restore records
contain bounded JSON scalars.  Commit and restore are compare-and-swap protected,
idempotent, read back exactly, and remain available with bridge exec disabled.
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


MAX_BODY_BYTES = 64 * 1024
MAX_PATH = 240
MAX_PARAMETER = 64
MAX_TARGETS = 6
MAX_CHANGES = 3
RECORD_TTL_SECONDS = 120.0
RECORD_CAP = 32

_PARAMETER_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")
_HEX_RE = re.compile(r"^[a-f0-9]{64}$")
_KEY_RE = re.compile(r"^[A-Za-z0-9._:-]{16,128}$")
_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{43,128}$")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")

_INSPECTIONS = OrderedDict()
_RESTORES = OrderedDict()
_IDEMPOTENCY = OrderedDict()
_LOCK = threading.RLock()


class VisualParameterTuningError(ValueError):
    """Typed, bounded public failure for the visual tuning routes."""

    def __init__(self, code, message):
        self.code = code
        super().__init__(str(message)[:256])


def _fail(code, message):
    raise VisualParameterTuningError(code, message)


def _strict_fields(value, field, required, optional=()):
    if type(value) is not dict:
        _fail("visual_invalid_input", "%s must be a JSON object" % field)
    keys = set(value)
    required = set(required)
    allowed = required | set(optional)
    if keys - allowed:
        _fail("visual_invalid_input", "%s contains unsupported fields" % field)
    if required - keys:
        _fail("visual_invalid_input", "%s is missing required fields" % field)
    return value


def _bounded_text(value, field, minimum, maximum, pattern=None):
    if type(value) is not str:
        _fail("visual_invalid_input", "%s must be a string" % field)
    try:
        size = len(value.encode("utf-8"))
    except UnicodeEncodeError:
        _fail("visual_invalid_input", "%s contains invalid Unicode" % field)
    if size < minimum or size > maximum or _CONTROL_RE.search(value):
        _fail("visual_invalid_input", "%s is outside its text bounds" % field)
    if pattern is not None and not pattern.fullmatch(value):
        _fail("visual_invalid_input", "%s has an invalid format" % field)
    return value


def _path(value, field):
    value = _bounded_text(value, field, 1, MAX_PATH)
    if not value.startswith("/") or (value != "/" and value.endswith("/")):
        _fail("visual_invalid_input", "%s must be a normalized absolute path" % field)
    parts = value.split("/")[1:]
    if any(part in ("", ".", "..") for part in parts):
        _fail("visual_invalid_input", "%s must be a normalized absolute path" % field)
    return value


def _under_scope(path, scope):
    return path == scope or path.startswith(scope + "/") if scope != "/" else path.startswith("/")


def _number(value, field):
    if type(value) not in (int, float) or not math.isfinite(value):
        _fail("visual_invalid_input", "%s must be a finite number" % field)
    value = float(value)
    if abs(value) > 1_000_000:
        _fail("visual_invalid_input", "%s is outside the supported range" % field)
    return value


def _canonical_json(value):
    try:
        return json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeEncodeError) as exc:
        raise VisualParameterTuningError(
            "visual_invalid_input", "value is not bounded JSON"
        ) from exc


def _sha256(value):
    return hashlib.sha256(_canonical_json(value)).hexdigest()


def _style_name(par):
    style = getattr(par, "style", None)
    raw = getattr(style, "name", None) or str(style)
    return str(raw).rsplit(".", 1)[-1]


def _mode_name(par):
    mode = getattr(par, "mode", None)
    raw = getattr(mode, "name", None) or str(mode)
    return str(raw).rsplit(".", 1)[-1].upper()


def _read_only(par):
    for name in ("readOnly", "isReadOnly"):
        value = getattr(par, name, False)
        try:
            value = value() if callable(value) else value
        except Exception:  # noqa: BLE001
            return True
        if value is True:
            return True
    return False


def _is_top(node):
    marker = getattr(node, "isTOP", None)
    try:
        marker = marker() if callable(marker) else marker
    except Exception:  # noqa: BLE001
        marker = False
    if marker is True:
        return True
    family = getattr(node, "family", None)
    family_name = getattr(family, "name", None) or str(family or "")
    type_name = str(getattr(node, "type", ""))
    return family_name.upper() == "TOP" or type_name.upper().endswith("TOP")


def _resolve_node(td, path, field):
    node = td.op(path)
    if node is None:
        _fail("visual_operator_not_found", "%s does not resolve" % field)
    return node


def _resolve_parameter(node, name):
    collection = getattr(node, "par", None)
    par = getattr(collection, name, None) if collection is not None else None
    if par is None:
        _fail("visual_parameter_not_found", "target parameter does not resolve")
    style = _style_name(par)
    if style not in ("Float", "Int"):
        _fail("visual_parameter_ineligible", "target parameter must be scalar Float or Int")
    if _mode_name(par) != "CONSTANT":
        _fail("visual_parameter_ineligible", "target parameter must be in CONSTANT mode")
    if _read_only(par):
        _fail("visual_parameter_ineligible", "target parameter is read-only")
    return par, style


def _native_bound(par, name):
    clamp_name = "clampMin" if name == "min" else "clampMax"
    try:
        clamp_enabled = getattr(par, clamp_name)
    except Exception:  # noqa: BLE001 - older builds retain conservative bounds.
        clamp_enabled = None
    if clamp_enabled is False:
        return None
    try:
        value = getattr(par, name)
    except Exception:  # noqa: BLE001
        return None
    if type(value) in (int, float) and math.isfinite(value):
        return float(value)
    return None


def _read_value(par, style):
    try:
        value = par.eval()
    except Exception as exc:  # noqa: BLE001
        raise VisualParameterTuningError(
            "visual_parameter_ineligible", "target parameter cannot be evaluated"
        ) from exc
    if type(value) not in (int, float) or not math.isfinite(value):
        _fail("visual_parameter_ineligible", "target parameter is not a finite scalar")
    if style == "Int" and not float(value).is_integer():
        _fail("visual_parameter_ineligible", "Int parameter readback is not integral")
    return int(value) if style == "Int" else float(value)


def _target_request(value, index, scope):
    value = _strict_fields(
        value,
        "targets[%d]" % index,
        ("node_path", "parameter", "minimum", "maximum"),
    )
    node_path = _path(value["node_path"], "targets[%d].node_path" % index)
    if not _under_scope(node_path, scope):
        _fail("visual_scope_escape", "target escapes scope_path")
    parameter = _bounded_text(
        value["parameter"],
        "targets[%d].parameter" % index,
        1,
        MAX_PARAMETER,
        _PARAMETER_RE,
    )
    minimum = _number(value["minimum"], "targets[%d].minimum" % index)
    maximum = _number(value["maximum"], "targets[%d].maximum" % index)
    if minimum >= maximum:
        _fail("visual_invalid_input", "target minimum must be below maximum")
    return {
        "node_path": node_path,
        "parameter": parameter,
        "minimum": minimum,
        "maximum": maximum,
    }


def _inspection_request(body):
    body = _strict_fields(
        body,
        "inspect",
        ("scope_path", "output_top_path", "targets"),
    )
    scope = _path(body["scope_path"], "scope_path")
    output = _path(body["output_top_path"], "output_top_path")
    if not _under_scope(output, scope):
        _fail("visual_scope_escape", "output_top_path escapes scope_path")
    raw_targets = body["targets"]
    if type(raw_targets) not in (list, tuple) or not 1 <= len(raw_targets) <= MAX_TARGETS:
        _fail("visual_invalid_input", "targets must contain between one and six items")
    targets = [_target_request(item, index, scope) for index, item in enumerate(raw_targets)]
    pairs = [(item["node_path"], item["parameter"]) for item in targets]
    if len(set(pairs)) != len(pairs):
        _fail("visual_invalid_input", "targets must be unique")
    return {"scope_path": scope, "output_top_path": output, "targets": targets}


def _effective_target(td, request, index):
    node = _resolve_node(td, request["node_path"], "target operator")
    par, style = _resolve_parameter(node, request["parameter"])
    minimum = request["minimum"]
    maximum = request["maximum"]
    native_min = _native_bound(par, "min")
    native_max = _native_bound(par, "max")
    if native_min is not None:
        minimum = max(minimum, native_min)
    if native_max is not None:
        maximum = min(maximum, native_max)
    if minimum >= maximum:
        _fail("visual_parameter_ineligible", "target has no writable bound intersection")
    value = _read_value(par, style)
    if value < minimum or value > maximum:
        _fail("visual_parameter_ineligible", "current target value is outside effective bounds")
    return {
        "id": "t%d" % (index + 1),
        "path": str(node.path),
        "parameter": request["parameter"],
        "type": style,
        "mode": "CONSTANT",
        "value": value,
        "minimum": minimum,
        "maximum": maximum,
    }


def _live_inspection(request):
    import td

    output = _resolve_node(td, request["output_top_path"], "output_top_path")
    if not _is_top(output):
        _fail("visual_output_not_top", "output_top_path must resolve to a TOP")
    targets = [
        _effective_target(td, target, index)
        for index, target in enumerate(request["targets"])
    ]
    fingerprint_payload = {
        "scope_path": request["scope_path"],
        "output_top_path": str(output.path),
        "output_type": str(getattr(output, "type", "TOP")),
        "targets": targets,
    }
    return {
        "scope_path": request["scope_path"],
        "output_top_path": str(output.path),
        "fingerprint": _sha256(fingerprint_payload),
        "targets": targets,
    }


def _prune_locked(now=None):
    now = time.monotonic() if now is None else now
    for store in (_INSPECTIONS, _RESTORES, _IDEMPOTENCY):
        stale = [key for key, item in store.items() if item["expires_at"] <= now]
        for key in stale:
            store.pop(key, None)


def _put_locked(store, key, value):
    store[key] = value
    store.move_to_end(key)
    while len(store) > RECORD_CAP:
        store.popitem(last=False)


def inspect_visual_parameters(body):
    request = _inspection_request(body)
    report = _live_inspection(request)
    with _LOCK:
        now = time.monotonic()
        _prune_locked(now)
        _put_locked(
            _INSPECTIONS,
            report["fingerprint"],
            {
                "request": copy.deepcopy(request),
                "report": copy.deepcopy(report),
                "expires_at": now + RECORD_TTL_SECONDS,
            },
        )
    return report


def _hex(value, field):
    return _bounded_text(value, field, 64, 64, _HEX_RE)


def _idempotency_key(value):
    return _bounded_text(value, "idempotency_key", 16, 128, _KEY_RE)


def _validated_change(raw, index, targets, seen):
    raw = _strict_fields(raw, "changes[%d]" % index, ("target_id", "value"))
    target_id = _bounded_text(raw["target_id"], "target_id", 2, 2)
    if target_id in seen or target_id not in targets:
        _fail("visual_invalid_input", "change target id is duplicate or unknown")
    seen.add(target_id)
    target = targets[target_id]
    proposed = _number(raw["value"], "change value")
    if proposed < target["minimum"] or proposed > target["maximum"]:
        _fail("visual_invalid_input", "change value is outside effective bounds")
    if target["type"] == "Int" and not proposed.is_integer():
        _fail("visual_invalid_input", "Int target requires an integer value")
    proposed = int(proposed) if target["type"] == "Int" else proposed
    if proposed == target["value"]:
        _fail("visual_invalid_input", "change value must differ from the snapshot")
    return {"target_id": target_id, "value": proposed}


def _changes(value, snapshot):
    if type(value) not in (list, tuple) or not 1 <= len(value) <= MAX_CHANGES:
        _fail("visual_invalid_input", "changes must contain between one and three items")
    targets = {item["id"]: item for item in snapshot["report"]["targets"]}
    seen = set()
    result = [
        _validated_change(raw, index, targets, seen)
        for index, raw in enumerate(value)
    ]
    return sorted(result, key=lambda item: int(item["target_id"][1:]))


def _snapshot(expected_fingerprint):
    with _LOCK:
        _prune_locked()
        snapshot = _INSPECTIONS.get(expected_fingerprint)
        return copy.deepcopy(snapshot) if snapshot is not None else None


def _interaction_descriptor(value):
    value = _strict_fields(
        value,
        "visual interaction target",
        ("expected_fingerprint", "proposal_digest", "changes"),
    )
    expected = _hex(value["expected_fingerprint"], "expected_fingerprint")
    proposal = _hex(value["proposal_digest"], "proposal_digest")
    snapshot = _snapshot(expected)
    if snapshot is None:
        _fail("visual_snapshot_expired", "visual inspection snapshot is unavailable")
    changes = _changes(value["changes"], snapshot)
    targets = {item["id"]: item for item in snapshot["report"]["targets"]}
    lines = [
        "Output: %s" % snapshot["report"]["output_top_path"],
        "Rubric: TD visual basic v1",
    ]
    for change in changes:
        target = targets[change["target_id"]]
        lines.append(
            "%s.%s: %s -> %s"
            % (target["path"], target["parameter"], target["value"], change["value"])
        )
    lines.append("Apply is CAS-checked and read back; Keep changes nothing.")
    prompt = "\n".join(lines)
    if len(prompt) > 512:
        _fail("visual_prompt_too_large", "exact visual approval prompt exceeds 512 characters")
    target_fingerprint = _sha256(
        {
            "kind": "visual_parameter_apply",
            "expected_fingerprint": expected,
            "proposal_digest": proposal,
            "changes": changes,
        }
    )
    return {
        "expected_fingerprint": expected,
        "proposal_digest": proposal,
        "changes": changes,
        "snapshot": snapshot,
        "target_fingerprint": target_fingerprint,
        "title": "Apply visual critique changes?",
        "prompt": prompt,
    }


def build_interaction_request(target):
    descriptor = _interaction_descriptor(target)
    return {
        "target_fingerprint": descriptor["target_fingerprint"],
        "title": descriptor["title"],
        "prompt": descriptor["prompt"],
    }


def _commit_request(body):
    body = _strict_fields(
        body,
        "commit",
        (
            "scope_path",
            "output_top_path",
            "expected_fingerprint",
            "proposal_digest",
            "idempotency_key",
            "interaction_id",
            "changes",
        ),
    )
    scope = _path(body["scope_path"], "scope_path")
    output = _path(body["output_top_path"], "output_top_path")
    expected = _hex(body["expected_fingerprint"], "expected_fingerprint")
    proposal = _hex(body["proposal_digest"], "proposal_digest")
    key = _idempotency_key(body["idempotency_key"])
    interaction_id = _bounded_text(body["interaction_id"], "interaction_id", 16, 128)
    descriptor = _interaction_descriptor(
        {
            "expected_fingerprint": expected,
            "proposal_digest": proposal,
            "changes": body["changes"],
        }
    )
    snapshot = descriptor["snapshot"]
    if scope != snapshot["request"]["scope_path"] or output != snapshot["request"]["output_top_path"]:
        _fail("visual_scope_escape", "commit scope/output does not match the inspected snapshot")
    return {
        "scope_path": scope,
        "output_top_path": output,
        "expected_fingerprint": expected,
        "proposal_digest": proposal,
        "idempotency_key": key,
        "interaction_id": interaction_id,
        "changes": descriptor["changes"],
        "snapshot": snapshot,
        "target_fingerprint": descriptor["target_fingerprint"],
    }


def _cached_result(namespace, key, request_digest):
    cache_key = "%s:%s" % (namespace, key)
    with _LOCK:
        _prune_locked()
        record = _IDEMPOTENCY.get(cache_key)
        if record is None:
            return None
        if not secrets.compare_digest(record["request_digest"], request_digest):
            _fail("visual_idempotency_conflict", "idempotency key conflicts with another request")
        result = copy.deepcopy(record["result"])
        result["replayed"] = True
        return result


def _store_result(namespace, key, request_digest, result):
    cache_key = "%s:%s" % (namespace, key)
    with _LOCK:
        now = time.monotonic()
        _prune_locked(now)
        _put_locked(
            _IDEMPOTENCY,
            cache_key,
            {
                "request_digest": request_digest,
                "result": copy.deepcopy(result),
                "expires_at": now + RECORD_TTL_SECONDS,
            },
        )


def _write_value(par, style, value):
    par.val = int(value) if style == "Int" else float(value)
    actual = _read_value(par, style)
    tolerance = 0.0 if style == "Int" else 1e-9 * max(1.0, abs(float(value)))
    if abs(float(actual) - float(value)) > tolerance:
        raise RuntimeError("parameter readback mismatch")
    return actual


def _parameter_for_target(td, target):
    node = _resolve_node(td, target["path"], "target operator")
    par, style = _resolve_parameter(node, target["parameter"])
    if style != target["type"]:
        _fail("visual_stale_targets", "target parameter type changed")
    return par, style


def _apply_changes(snapshot, changes):
    import td

    targets = {item["id"]: item for item in snapshot["report"]["targets"]}
    applied = []
    readback = []
    try:
        for change in changes:
            target = targets[change["target_id"]]
            par, style = _parameter_for_target(td, target)
            actual = _write_value(par, style, change["value"])
            applied.append(target)
            readback.append({"target_id": target["id"], "value": actual})
    except Exception:  # noqa: BLE001
        restored = True
        for target in reversed(applied):
            try:
                par, style = _parameter_for_target(td, target)
                _write_value(par, style, target["value"])
            except Exception:  # noqa: BLE001
                restored = False
        return None, restored
    return readback, True


def _consume_apply(request):
    from mcp.services import interaction_service

    consumed = interaction_service.consume_interaction(
        request["interaction_id"], request["target_fingerprint"]
    )
    if not consumed.get("accepted") or consumed.get("decision") != "Apply":
        _fail("visual_approval_required", "visual Apply approval was not accepted")


def commit_visual_parameters(body):
    request = _commit_request(body)
    digest_payload = {key: value for key, value in request.items() if key != "snapshot"}
    request_digest = _sha256(digest_payload)
    cached = _cached_result("commit", request["idempotency_key"], request_digest)
    if cached is not None:
        return cached
    _consume_apply(request)

    current = _live_inspection(request["snapshot"]["request"])
    if not secrets.compare_digest(current["fingerprint"], request["expected_fingerprint"]):
        result = {"status": "conflict", "reason": "stale_targets", "replayed": False}
        _store_result("commit", request["idempotency_key"], request_digest, result)
        return result

    readback, restored_inside = _apply_changes(request["snapshot"], request["changes"])
    if readback is None:
        reason = "apply_failed" if restored_inside else "rollback_failed"
        result = {"status": "failed", "reason": reason, "replayed": False}
        _store_result("commit", request["idempotency_key"], request_digest, result)
        return result

    committed = _live_inspection(request["snapshot"]["request"])
    restore_token = secrets.token_urlsafe(32)
    changed_ids = [item["target_id"] for item in request["changes"]]
    with _LOCK:
        now = time.monotonic()
        _prune_locked(now)
        _put_locked(
            _RESTORES,
            restore_token,
            {
                "scope_path": request["scope_path"],
                "request": copy.deepcopy(request["snapshot"]["request"]),
                "original": copy.deepcopy(request["snapshot"]["report"]),
                "committed": copy.deepcopy(committed),
                "changed_ids": changed_ids,
                "restored_result": None,
                "expires_at": now + RECORD_TTL_SECONDS,
            },
        )
    result = {
        "status": "committed",
        "applied": True,
        "verified": True,
        "final_fingerprint": committed["fingerprint"],
        "restore_token": restore_token,
        "readback": readback,
        "replayed": False,
    }
    _store_result("commit", request["idempotency_key"], request_digest, result)
    return result


def _restore_request(body):
    body = _strict_fields(
        body,
        "restore",
        ("restore_token", "expected_committed_fingerprint", "idempotency_key"),
    )
    return {
        "restore_token": _bounded_text(body["restore_token"], "restore_token", 43, 128, _TOKEN_RE),
        "expected_committed_fingerprint": _hex(
            body["expected_committed_fingerprint"], "expected_committed_fingerprint"
        ),
        "idempotency_key": _idempotency_key(body["idempotency_key"]),
    }


def _restore_record(token):
    with _LOCK:
        _prune_locked()
        record = _RESTORES.get(token)
        return copy.deepcopy(record) if record is not None else None


def _set_restored_result(token, result):
    with _LOCK:
        record = _RESTORES.get(token)
        if record is not None:
            record["restored_result"] = copy.deepcopy(result)


def _restore_values(record):
    import td

    original_targets = {item["id"]: item for item in record["original"]["targets"]}
    committed_targets = {item["id"]: item for item in record["committed"]["targets"]}
    restored = []
    try:
        for target_id in reversed(record["changed_ids"]):
            target = original_targets[target_id]
            par, style = _parameter_for_target(td, target)
            _write_value(par, style, target["value"])
            restored.append(target_id)
    except Exception:  # noqa: BLE001
        for target_id in reversed(restored):
            try:
                target = committed_targets[target_id]
                par, style = _parameter_for_target(td, target)
                _write_value(par, style, target["value"])
            except Exception:  # noqa: BLE001
                pass
        return False
    return True


def restore_visual_parameters(body):
    request = _restore_request(body)
    request_digest = _sha256(request)
    cached = _cached_result("restore", request["idempotency_key"], request_digest)
    if cached is not None:
        return cached
    record = _restore_record(request["restore_token"])
    if record is None:
        _fail("visual_restore_unavailable", "restore journal is missing or expired")
    if request["expected_committed_fingerprint"] != record["committed"]["fingerprint"]:
        _fail("visual_stale_targets", "restore expected fingerprint does not match journal")
    if record["restored_result"] is not None:
        result = record["restored_result"]
        result["replayed"] = True
        _store_result("restore", request["idempotency_key"], request_digest, result)
        return result

    current = _live_inspection(record["request"])
    if not secrets.compare_digest(current["fingerprint"], record["committed"]["fingerprint"]):
        result = {
            "restored": False,
            "verified": False,
            "reason": "stale_targets",
            "replayed": False,
        }
        _store_result("restore", request["idempotency_key"], request_digest, result)
        return result
    if not _restore_values(record):
        result = {
            "restored": False,
            "verified": False,
            "reason": "rollback_failed",
            "replayed": False,
        }
        _store_result("restore", request["idempotency_key"], request_digest, result)
        return result
    restored = _live_inspection(record["request"])
    verified = secrets.compare_digest(restored["fingerprint"], record["original"]["fingerprint"])
    result = {
        "restored": verified,
        "verified": verified,
        "restored_fingerprint": restored["fingerprint"],
        "reason": None if verified else "rollback_failed",
        "replayed": False,
    }
    _set_restored_result(request["restore_token"], result)
    _store_result("restore", request["idempotency_key"], request_digest, result)
    return result


def restore_undo_label(body):
    try:
        token = body.get("restore_token") if type(body) is dict else None
        record = _restore_record(token)
        if record is not None:
            return "MCP restore enhance_build visual parameters %s" % record["scope_path"]
    except Exception:  # noqa: BLE001
        pass
    return "MCP restore enhance_build visual parameters"


def reset_state():
    """Clear bounded in-memory records. Focused tests and bridge teardown only."""
    with _LOCK:
        _INSPECTIONS.clear()
        _RESTORES.clear()
        _IDEMPOTENCY.clear()
