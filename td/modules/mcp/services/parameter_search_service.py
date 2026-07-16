"""Bounded, deterministic and secret-aware TouchDesigner parameter search.

The service reuses :mod:`mcp.services.search_service` for bounded descendant
traversal, then inspects only parameters on the compact, sorted node records.
It is intentionally read-only and has no dependency on ``/api/exec``.
"""

import json
import math
import re
import time

from . import search_service

DEFAULT_MAX_DEPTH = 3
DEFAULT_LIMIT = 100
DEFAULT_NODE_SCAN_LIMIT = 1_000
DEFAULT_PARAMETER_SCAN_LIMIT = 25_000
DEFAULT_TIME_BUDGET_MS = 1_000
MAX_PARAMETER_SCAN_LIMIT = 100_000
MIN_TIME_BUDGET_MS = 25
MAX_TIME_BUDGET_MS = 2_500
MAX_NODE_FILTER_LENGTH = 128
MAX_PARAMETER_FILTER_LENGTH = 256
MAX_VALUE_TEXT_LENGTH = 256
MAX_EXPRESSION_TEXT_LENGTH = 512
MAX_RESPONSE_BYTES = 256 * 1_024
_RESPONSE_HEADROOM_BYTES = 16 * 1_024

MODES = frozenset(("CONSTANT", "EXPRESSION", "EXPORT", "BIND", "UNKNOWN"))
_SECRET_NAME = re.compile(
    r"(?:password|passwd|secret|token|api[_-]?key|credential|authorization|bearer|private[_-]?key)",
    re.IGNORECASE,
)
_UNSUPPORTED_GLOB = frozenset(("?", "[", "]", "{", "}", "\\"))
_CONTROL_TEXT = frozenset(("\x00", "\r", "\n"))


def _bounded_int(name, value, minimum, maximum):
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("%s must be an integer." % name)
    if value < minimum or value > maximum:
        raise ValueError("%s must be between %d and %d." % (name, minimum, maximum))
    return value


def _bounded_filter(name, value, maximum, *, glob=False):
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("%s must be a string." % name)
    if not value:
        raise ValueError("%s must not be empty." % name)
    if len(value) > maximum:
        raise ValueError("%s exceeds its maximum length." % name)
    if any(char in value for char in _CONTROL_TEXT):
        raise ValueError("%s contains unsupported control characters." % name)
    if glob and any(char in value for char in _UNSUPPORTED_GLOB):
        raise ValueError("%s contains unsupported glob metacharacters." % name)
    return value


def _star_glob_regex(pattern, *, anchored):
    if pattern is None:
        return None
    source = ".*".join(re.escape(part) for part in pattern.split("*"))
    if anchored:
        source = "^(?:%s)$" % source
    return re.compile(source, re.IGNORECASE)


def _regex_matches(regex, value):
    return regex is None or regex.search(value) is not None


def _validate_filters(
    *,
    node_pattern,
    node_name_glob,
    node_path_glob,
    type_filter,
    type_match,
    family,
    parameter_glob,
    value_glob,
    expression_glob,
    mode,
):
    node_pattern = _bounded_filter(
        "node_pattern", node_pattern, MAX_NODE_FILTER_LENGTH, glob=False
    )
    node_name_glob = _bounded_filter(
        "node_name_glob", node_name_glob, MAX_NODE_FILTER_LENGTH, glob=True
    )
    node_path_glob = _bounded_filter(
        "node_path_glob", node_path_glob, MAX_NODE_FILTER_LENGTH, glob=True
    )
    type_filter = _bounded_filter("type", type_filter, MAX_NODE_FILTER_LENGTH)
    parameter_glob = _bounded_filter(
        "parameter_glob", parameter_glob, MAX_PARAMETER_FILTER_LENGTH, glob=True
    )
    value_glob = _bounded_filter(
        "value_glob", value_glob, MAX_PARAMETER_FILTER_LENGTH, glob=True
    )
    expression_glob = _bounded_filter(
        "expression_glob", expression_glob, MAX_PARAMETER_FILTER_LENGTH, glob=True
    )
    if type_match not in ("partial", "exact"):
        raise ValueError("type_match must be 'partial' or 'exact'.")
    if family is not None:
        family = _bounded_filter("family", family, 8).upper()
        if family not in search_service.FAMILIES:
            raise ValueError(
                "family must be one of: %s."
                % ", ".join(sorted(search_service.FAMILIES))
            )
    if mode is not None:
        mode = _bounded_filter("mode", mode, 16).upper()
        if mode not in MODES:
            raise ValueError("mode must be one of: %s." % ", ".join(sorted(MODES)))
    return {
        "node_pattern": _star_glob_regex(node_pattern, anchored=False),
        "node_name_glob": _star_glob_regex(node_name_glob, anchored=True),
        "node_path_glob": _star_glob_regex(node_path_glob, anchored=True),
        "type_filter": type_filter,
        "type_match": type_match,
        "family": family,
        "parameter_glob": _star_glob_regex(parameter_glob, anchored=True),
        "value_glob": _star_glob_regex(value_glob, anchored=True),
        "expression_glob": _star_glob_regex(expression_glob, anchored=True),
        "mode": mode,
    }


def _has_narrowing_predicate(filters, non_default_only):
    return non_default_only or any(
        filters[name] is not None
        for name in (
            "node_pattern",
            "node_name_glob",
            "node_path_glob",
            "type_filter",
            "family",
            "parameter_glob",
            "value_glob",
            "expression_glob",
            "mode",
        )
    )


def _node_text_filters_match(hit, filters):
    if filters["node_pattern"] is not None and not (
        _regex_matches(filters["node_pattern"], hit["name"])
        or _regex_matches(filters["node_pattern"], hit["path"])
    ):
        return False
    if not _regex_matches(filters["node_name_glob"], hit["name"]):
        return False
    if not _regex_matches(filters["node_path_glob"], hit["path"]):
        return False
    return True


def _node_type_filter_matches(hit, filters):
    type_filter = filters["type_filter"]
    if type_filter is not None:
        actual = hit["type"].casefold()
        expected = type_filter.casefold()
        if filters["type_match"] == "exact" and actual != expected:
            return False
        if filters["type_match"] == "partial" and expected not in actual:
            return False
    return True


def _node_matches(hit, filters):
    return (
        _node_text_filters_match(hit, filters)
        and _node_type_filter_matches(hit, filters)
        and (filters["family"] is None or hit["family"] == filters["family"])
    )


def _normalize_mode(par):
    raw = par.mode
    name = getattr(raw, "name", None)
    text = str(name if name is not None else raw).rsplit(".", 1)[-1].upper()
    return text if text in MODES else "UNKNOWN"


def _is_sensitive(par, name):
    if _SECRET_NAME.search(name) is not None:
        return True
    try:
        return bool(getattr(par, "password", False))
    except Exception:  # noqa: BLE001 - fail closed if the password flag is unreadable
        return True


def _clip_text(value, maximum):
    if len(value) <= maximum:
        return value, False
    return value[:maximum], True


def _finite_number(value):
    if not isinstance(value, float) or math.isfinite(value):
        return value
    if math.isnan(value):
        return "NaN"
    return "Infinity" if value > 0 else "-Infinity"


def _json_mapping(value, seen, depth):
    pairs = [(str(key), item) for key, item in value.items()]
    pairs.sort(key=lambda pair: pair[0].encode("utf-8"))
    return {
        key: _json_compatible(item, seen, depth + 1)
        for key, item in pairs[:256]
    }


def _json_reference_or_text(value):
    path = getattr(value, "path", None)
    if path is not None:
        path_text = str(path)
        if path_text.startswith("/"):
            return path_text
    return str(value)


def _json_nested_value(value, seen, depth):
    if isinstance(value, (list, tuple)):
        return [_json_compatible(item, seen, depth + 1) for item in value[:256]]
    if isinstance(value, dict):
        return _json_mapping(value, seen, depth)
    return _json_reference_or_text(value)


def _json_compatible(value, seen, depth=0):
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        text = str(value)
        return value if len(text) <= MAX_VALUE_TEXT_LENGTH else text
    if isinstance(value, float):
        return _finite_number(value)
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if depth >= 6:
        return "[MAX_DEPTH]"

    identity = id(value)
    if identity in seen:
        return "[CYCLE]"
    seen.add(identity)
    try:
        return _json_nested_value(value, seen, depth)
    finally:
        seen.remove(identity)


_UNSERIALIZED = object()


def _serialize_scalar(value):
    if value is None or isinstance(value, bool):
        return value, False
    if isinstance(value, int):
        text = str(value)
        if len(text) <= MAX_VALUE_TEXT_LENGTH:
            return value, False
        return _clip_text(text, MAX_VALUE_TEXT_LENGTH)
    if isinstance(value, float) and math.isfinite(value):
        return value, False
    if isinstance(value, str):
        return _clip_text(value, MAX_VALUE_TEXT_LENGTH)
    return _UNSERIALIZED, False


def _serialize_value(value):
    scalar, truncated = _serialize_scalar(value)
    if scalar is not _UNSERIALIZED:
        return scalar, truncated

    compatible = _json_compatible(value, set())
    if isinstance(value, (list, tuple, dict)):
        text = json.dumps(
            compatible,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    else:
        text = str(compatible)
    return _clip_text(text, MAX_VALUE_TEXT_LENGTH)


def _value_filter_text(value):
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    return str(value)


def _named_parameters(node):
    parameters = list(node.pars() or [])
    named = []
    unreadable_names = 0
    for par in parameters:
        try:
            name = str(par.name)
            if not name:
                raise ValueError("empty parameter name")
        except Exception:  # noqa: BLE001
            unreadable_names += 1
            continue
        named.append((name.encode("utf-8"), name, par))
    named.sort(key=lambda item: item[0])
    return named, unreadable_names


def _parameter_identity(par, name, filters, non_default_only):
    if getattr(par, "page") is None:
        return "skipped", None, None
    mode = _normalize_mode(par)
    non_default = not bool(par.isDefault)
    if filters["parameter_glob"] is not None and not _regex_matches(
        filters["parameter_glob"], name
    ):
        return "filtered", None, None
    if filters["mode"] is not None and mode != filters["mode"]:
        return "filtered", None, None
    if non_default_only and not non_default:
        return "filtered", None, None
    return "matched", mode, non_default


def _base_hit(record, name, mode, non_default):
    return {
        "op": record["hit"]["path"],
        "type": record["hit"]["type"],
        "family": record["hit"]["family"],
        "par": name,
        "mode": mode,
        "non_default": non_default,
    }


def _redacted_hit(record, name, par, mode, non_default):
    hit = _base_hit(record, name, mode, non_default)
    expression = getattr(par, "expr", "")
    hit["value"] = "[REDACTED]"
    if expression:
        hit["expr"] = "[REDACTED]"
    hit["redacted"] = True
    return hit


def _public_hit(record, name, par, mode, non_default, filters):
    expression = getattr(par, "expr", "")
    expression = "" if expression is None else str(expression)
    if filters["expression_glob"] is not None and not _regex_matches(
        filters["expression_glob"], expression
    ):
        return None

    value, value_truncated = _serialize_value(par.eval())
    if filters["value_glob"] is not None and not _regex_matches(
        filters["value_glob"], _value_filter_text(value)
    ):
        return None

    hit = _base_hit(record, name, mode, non_default)
    hit["value"] = value
    if expression:
        hit["expr"], expr_truncated = _clip_text(
            expression, MAX_EXPRESSION_TEXT_LENGTH
        )
        if expr_truncated:
            hit["expr_truncated"] = True
    if value_truncated:
        hit["value_truncated"] = True
    return hit


def _build_hit(record, name, par, filters, non_default_only):
    outcome, mode, non_default = _parameter_identity(
        par, name, filters, non_default_only
    )
    if outcome != "matched":
        return outcome, None

    sensitive = _is_sensitive(par, name)
    content_filter = (
        filters["value_glob"] is not None or filters["expression_glob"] is not None
    )
    if sensitive and content_filter:
        return "skipped", None
    if sensitive:
        return "redacted", _redacted_hit(record, name, par, mode, non_default)
    hit = _public_hit(record, name, par, mode, non_default, filters)
    return ("matched", hit) if hit is not None else ("filtered", None)


def _retained_size(hit):
    return len(
        json.dumps(hit, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode(
            "utf-8"
        )
    )


def _translated_stop_reason(reason):
    if reason in ("completed", "node_scan_limit", "time_limit"):
        return reason
    return "completed"


def _new_scan_state(stop_reason):
    return {
        "results": [],
        "scanned_parameters": 0,
        "matched": 0,
        "unreadable_parameters": 0,
        "skipped_parameters": 0,
        "redacted_parameters": 0,
        "retained_bytes": 0,
        "retention_closed": False,
        "stop_reason": stop_reason,
        "parameter_scan_stopped": False,
    }


def _parameter_budget_reason(state, parameter_scan_limit, deadline, clock):
    if state["scanned_parameters"] >= parameter_scan_limit:
        return "parameter_scan_limit"
    if clock() >= deadline:
        return "time_limit"
    return None


def _retain_hit(state, hit, limit):
    if len(state["results"]) >= limit or state["retention_closed"]:
        return
    hit_size = _retained_size(hit)
    if state["retained_bytes"] + hit_size > MAX_RESPONSE_BYTES - _RESPONSE_HEADROOM_BYTES:
        state["retention_closed"] = True
        return
    state["results"].append(hit)
    state["retained_bytes"] += hit_size


def _scan_parameter(record, name, par, filters, non_default_only, limit, state):
    state["scanned_parameters"] += 1
    try:
        outcome, hit = _build_hit(record, name, par, filters, non_default_only)
    except Exception:  # noqa: BLE001
        state["unreadable_parameters"] += 1
        state["skipped_parameters"] += 1
        return
    if outcome == "skipped":
        state["skipped_parameters"] += 1
        return
    if hit is None:
        return
    state["matched"] += 1
    if outcome == "redacted":
        state["redacted_parameters"] += 1
    _retain_hit(state, hit, limit)


def _scan_record_parameters(
    record,
    filters,
    non_default_only,
    limit,
    parameter_scan_limit,
    deadline,
    clock,
    state,
):
    try:
        named, unreadable_names = _named_parameters(record["node"])
    except Exception:  # noqa: BLE001
        state["unreadable_parameters"] += 1
        state["skipped_parameters"] += 1
        return
    state["unreadable_parameters"] += unreadable_names
    state["skipped_parameters"] += unreadable_names
    state["scanned_parameters"] += unreadable_names

    for _, name, par in named:
        budget_reason = _parameter_budget_reason(
            state, parameter_scan_limit, deadline, clock
        )
        if budget_reason is not None:
            state["stop_reason"] = budget_reason
            state["parameter_scan_stopped"] = True
            return
        _scan_parameter(
            record, name, par, filters, non_default_only, limit, state
        )


def _scan_parameter_records(
    records,
    filters,
    non_default_only,
    limit,
    parameter_scan_limit,
    deadline,
    clock,
    stop_reason,
):
    state = _new_scan_state(stop_reason)
    for record in records:
        if not _node_matches(record["hit"], filters):
            continue
        if clock() >= deadline:
            state["stop_reason"] = "time_limit"
            state["parameter_scan_stopped"] = True
            break
        _scan_record_parameters(
            record,
            filters,
            non_default_only,
            limit,
            parameter_scan_limit,
            deadline,
            clock,
            state,
        )
        if state["parameter_scan_stopped"]:
            break
    return state


def search_parameters(
    root_path="/project1",
    *,
    max_depth=DEFAULT_MAX_DEPTH,
    node_pattern=None,
    node_name_glob=None,
    node_path_glob=None,
    type_filter=None,
    type_match="partial",
    family=None,
    parameter_glob=None,
    value_glob=None,
    expression_glob=None,
    mode=None,
    non_default_only=False,
    limit=DEFAULT_LIMIT,
    node_scan_limit=DEFAULT_NODE_SCAN_LIMIT,
    parameter_scan_limit=DEFAULT_PARAMETER_SCAN_LIMIT,
    time_budget_ms=DEFAULT_TIME_BUDGET_MS,
    op_lookup=None,
    clock=None,
):
    """Return a compact parameter-search report with truthful bounded metadata."""
    if not isinstance(non_default_only, bool):
        raise ValueError("non_default_only must be a boolean.")
    max_depth = _bounded_int("max_depth", max_depth, 1, search_service.MAX_DEPTH)
    limit = _bounded_int("limit", limit, 1, search_service.MAX_LIMIT)
    node_scan_limit = _bounded_int(
        "node_scan_limit", node_scan_limit, 1, search_service.MAX_NODE_SCAN_LIMIT
    )
    parameter_scan_limit = _bounded_int(
        "parameter_scan_limit",
        parameter_scan_limit,
        1,
        MAX_PARAMETER_SCAN_LIMIT,
    )
    time_budget_ms = _bounded_int(
        "time_budget_ms", time_budget_ms, MIN_TIME_BUDGET_MS, MAX_TIME_BUDGET_MS
    )
    filters = _validate_filters(
        node_pattern=node_pattern,
        node_name_glob=node_name_glob,
        node_path_glob=node_path_glob,
        type_filter=type_filter,
        type_match=type_match,
        family=family,
        parameter_glob=parameter_glob,
        value_glob=value_glob,
        expression_glob=expression_glob,
        mode=mode,
    )
    if root_path == "/" and not _has_narrowing_predicate(filters, non_default_only):
        raise ValueError("root_path='/' requires at least one narrowing predicate.")

    clock = clock if clock is not None else time.monotonic
    started = clock()
    deadline = started + (time_budget_ms / 1_000.0)
    records, node_metadata = search_service.scan_nodes(
        root_path,
        max_depth=max_depth,
        node_scan_limit=node_scan_limit,
        time_limit_ms=min(time_budget_ms, search_service.MAX_TIME_LIMIT_MS),
        op_lookup=op_lookup,
        clock=clock,
    )
    records.sort(key=lambda item: item["hit"]["path"].encode("utf-8"))
    state = _scan_parameter_records(
        records,
        filters,
        non_default_only,
        limit,
        parameter_scan_limit,
        deadline,
        clock,
        _translated_stop_reason(node_metadata["stop_reason"]),
    )
    scan_truncated = node_metadata["scan_truncated"] or state["parameter_scan_stopped"]
    elapsed_ms = max(0, int(round((clock() - started) * 1_000.0)))
    returned = len(state["results"])
    return {
        "root_path": root_path,
        "max_depth": max_depth,
        "results": state["results"],
        "scanned_nodes": node_metadata["scanned"],
        "scanned_parameters": state["scanned_parameters"],
        "matched": state["matched"],
        "returned": returned,
        "limit": limit,
        "truncated": state["matched"] > returned,
        "scan_truncated": scan_truncated,
        "count_complete": not scan_truncated,
        "unreadable_parameters": state["unreadable_parameters"],
        "skipped_parameters": state["skipped_parameters"],
        "redacted_parameters": state["redacted_parameters"],
        "stop_reason": state["stop_reason"],
        "elapsed_ms": elapsed_ms,
    }
