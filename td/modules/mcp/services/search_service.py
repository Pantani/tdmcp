"""Bounded, deterministic TouchDesigner node search.

The service intentionally returns compact node references instead of transferring
topology or parameters.  It is read-only and does not depend on ``/api/exec``, so
an integrating controller can expose it while ``TDMCP_BRIDGE_ALLOW_EXEC=0``.

Depth is artist-facing and intuitive: ``max_depth=1`` means direct children of
``root_path``.  An unbounded legacy traversal is available only through the
explicit ``unbounded=True`` internal compatibility flag.
"""

import heapq
import re
import time

DEFAULT_LIMIT = 50
MAX_LIMIT = 200
DEFAULT_NODE_SCAN_LIMIT = 5_000
MAX_NODE_SCAN_LIMIT = 10_000
DEFAULT_TIME_LIMIT_MS = 500
MAX_TIME_LIMIT_MS = 2_000
MAX_DEPTH = 32
MAX_ROOT_LENGTH = 1_024
MAX_FILTER_LENGTH = 256
FAMILIES = frozenset(("TOP", "CHOP", "SOP", "DAT", "COMP", "MAT", "POP"))

_UNSET = object()


def _bounded_int(name, value, minimum, maximum):
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("%s must be an integer." % name)
    if value < minimum or value > maximum:
        raise ValueError("%s must be between %d and %d." % (name, minimum, maximum))
    return value


def _bounded_text(name, value, maximum, *, required=False):
    if value is None and not required:
        return None
    if not isinstance(value, str):
        raise ValueError("%s must be a string." % name)
    if not value:
        raise ValueError("%s must not be empty." % name)
    if len(value) > maximum:
        raise ValueError("%s must be at most %d characters." % (name, maximum))
    return value


def _validate_root_path(root_path):
    root_path = _bounded_text("root_path", root_path, MAX_ROOT_LENGTH, required=True)
    if not root_path.startswith("/"):
        raise ValueError("root_path must be an absolute TouchDesigner path.")
    if root_path != "/":
        segments = root_path.split("/")[1:]
        if any(segment in ("", ".", "..") for segment in segments):
            raise ValueError("root_path must be a normalized absolute TouchDesigner path.")
    return root_path


_UNSUPPORTED_GLOB = frozenset(("?", "[", "]", "{", "}", "\\"))
_CONTROL_TEXT = frozenset(("\x00", "\r", "\n"))


def _validate_pattern(name, pattern):
    pattern = _bounded_text(name, pattern, MAX_FILTER_LENGTH)
    if pattern is None:
        return None
    if any(char in pattern for char in _CONTROL_TEXT):
        raise ValueError("%s contains unsupported control characters." % name)
    return pattern


def _validate_glob(name, pattern):
    pattern = _validate_pattern(name, pattern)
    if pattern is not None and any(char in pattern for char in _UNSUPPORTED_GLOB):
        raise ValueError("%s contains unsupported glob metacharacters." % name)
    return pattern


def _resolved_depth(max_depth, unbounded):
    if not isinstance(unbounded, bool):
        raise ValueError("unbounded must be a boolean.")
    if unbounded:
        if max_depth is not _UNSET and max_depth is not None:
            raise ValueError("max_depth and unbounded=true are contradictory.")
        return None
    if max_depth is _UNSET:
        return 1
    if max_depth is None:
        raise ValueError("max_depth=None requires explicit unbounded=true.")
    return _bounded_int("max_depth", max_depth, 1, MAX_DEPTH)


def _safe_string(obj, *names):
    for name in names:
        try:
            value = getattr(obj, name)
        except Exception:  # noqa: BLE001
            continue
        if value is None:
            continue
        try:
            text = str(value)
        except Exception:  # noqa: BLE001
            continue
        if text:
            return text
    return ""


def _node_record(node):
    path = _safe_string(node, "path")
    name = _safe_string(node, "name")
    op_type = _safe_string(node, "OPType", "type")
    family = _safe_string(node, "family").upper()
    if not path.startswith("/") or not name or not op_type or not family:
        return None
    return {
        "node": node,
        "hit": {"path": path, "name": name, "type": op_type, "family": family},
    }


def _direct_records(parent):
    children = parent.findChildren(depth=1)
    records = []
    for child in list(children or []):
        record = _node_record(child)
        if record is not None:
            records.append(record)
    records.sort(key=lambda item: (item["hit"]["path"].casefold(), item["hit"]["path"]))
    return records


def _resolve_root(root_path, op_lookup):
    root = op_lookup(root_path)
    if root is None:
        raise LookupError("Network not found: %s" % root_path)
    if not hasattr(root, "findChildren"):
        raise ValueError("root_path is not a searchable TouchDesigner network.")
    return root


def _op_lookup_or_td(op_lookup):
    if op_lookup is not None:
        return op_lookup
    import td

    return td.op


def _initial_heap(root):
    heap = []
    for sequence, record in enumerate(_direct_records(root)):
        path = record["hit"]["path"]
        heapq.heappush(heap, (path.casefold(), path, sequence, 1, record))
    return heap, len(heap)


def _budget_stop_reason(records, node_scan_limit, deadline, clock):
    if clock() >= deadline:
        return "time_limit"
    if len(records) >= node_scan_limit:
        return "node_scan_limit"
    return None


def _can_descend(record, depth, resolved_depth):
    if resolved_depth is not None and depth >= resolved_depth:
        return False
    return hasattr(record["node"], "findChildren")


def _push_children(heap, record, depth, seen_paths, sequence):
    for child_record in _direct_records(record["node"]):
        child_path = child_record["hit"]["path"]
        if child_path in seen_paths:
            continue
        heapq.heappush(
            heap,
            (child_path.casefold(), child_path, sequence, depth + 1, child_record),
        )
        sequence += 1
    return sequence


def _scan_heap(heap, resolved_depth, node_scan_limit, deadline, clock, sequence):
    records = []
    seen_paths = set()
    stop_reason = "completed"
    while heap:
        budget_reason = _budget_stop_reason(records, node_scan_limit, deadline, clock)
        if budget_reason is not None:
            stop_reason = budget_reason
            break

        _, path, _, depth, record = heapq.heappop(heap)
        if path in seen_paths:
            continue
        seen_paths.add(path)
        records.append(record)
        if _can_descend(record, depth, resolved_depth):
            sequence = _push_children(heap, record, depth, seen_paths, sequence)
    return records, stop_reason


def scan_nodes(
    root_path,
    *,
    max_depth=_UNSET,
    unbounded=False,
    node_scan_limit=DEFAULT_NODE_SCAN_LIMIT,
    time_limit_ms=DEFAULT_TIME_LIMIT_MS,
    op_lookup=None,
    clock=None,
):
    """Return ``(records, metadata)`` for a reusable bounded descendant scan.

    ``records`` are sorted globally by absolute path and retain the live node in
    an internal ``node`` field for the parameter-search consumer.  Only the compact
    ``hit`` field is safe for a public response.
    """
    root_path = _validate_root_path(root_path)
    resolved_depth = _resolved_depth(max_depth, unbounded)
    node_scan_limit = _bounded_int(
        "node_scan_limit", node_scan_limit, 1, MAX_NODE_SCAN_LIMIT
    )
    time_limit_ms = _bounded_int("time_limit_ms", time_limit_ms, 1, MAX_TIME_LIMIT_MS)
    op_lookup = _op_lookup_or_td(op_lookup)
    clock = clock if clock is not None else time.monotonic
    root = _resolve_root(root_path, op_lookup)
    deadline = clock() + (time_limit_ms / 1_000.0)
    heap, sequence = _initial_heap(root)
    records, stop_reason = _scan_heap(
        heap, resolved_depth, node_scan_limit, deadline, clock, sequence
    )

    records.sort(key=lambda item: (item["hit"]["path"].casefold(), item["hit"]["path"]))
    scan_truncated = stop_reason != "completed"
    return records, {
        "scanned": len(records),
        "scan_truncated": scan_truncated,
        "count_complete": not scan_truncated,
        "stop_reason": stop_reason,
    }


def _glob_matches(value, pattern):
    if pattern is None:
        return True
    source = ".*".join(re.escape(part) for part in pattern.split("*"))
    return re.match("^(?:%s)$" % source, value, re.IGNORECASE) is not None


def _pattern_matches(value, pattern):
    if pattern is None:
        return True
    source = ".*".join(re.escape(part) for part in pattern.split("*"))
    return re.search(source, value, re.IGNORECASE) is not None


def _text_filters_match(hit, pattern, name_glob, path_glob):
    if pattern is not None and not (
        _pattern_matches(hit["name"], pattern)
        or _pattern_matches(hit["path"], pattern)
    ):
        return False
    if not _glob_matches(hit["name"], name_glob):
        return False
    return _glob_matches(hit["path"], path_glob)


def _type_filter_matches(hit, type_filter, type_match):
    if type_filter is not None:
        actual = hit["type"].casefold()
        expected = type_filter.casefold()
        if type_match == "exact" and actual != expected:
            return False
        if type_match in ("contains", "partial") and expected not in actual:
            return False
    return True


def _matches(hit, *, pattern, name_glob, path_glob, type_filter, type_match, family):
    return (
        _text_filters_match(hit, pattern, name_glob, path_glob)
        and _type_filter_matches(hit, type_filter, type_match)
        and (family is None or hit["family"] == family)
    )


def search_nodes(
    root_path,
    *,
    pattern=None,
    name_glob=None,
    path_glob=None,
    type_filter=None,
    type_match="contains",
    family=None,
    max_depth=_UNSET,
    unbounded=False,
    limit=DEFAULT_LIMIT,
    node_scan_limit=DEFAULT_NODE_SCAN_LIMIT,
    time_limit_ms=DEFAULT_TIME_LIMIT_MS,
    op_lookup=None,
    clock=None,
):
    """Search descendants of ``root_path`` and return compact, bounded hits."""
    pattern = _validate_pattern("pattern", pattern)
    name_glob = _validate_glob("name_glob", name_glob)
    path_glob = _validate_glob("path_glob", path_glob)
    type_filter = _bounded_text("type_filter", type_filter, MAX_FILTER_LENGTH)
    if type_match not in ("exact", "contains", "partial"):
        raise ValueError("type_match must be 'exact' or 'partial'.")
    if family is not None:
        family = _bounded_text("family", family, 8).upper()
        if family not in FAMILIES:
            raise ValueError("family must be one of: %s." % ", ".join(sorted(FAMILIES)))
    limit = _bounded_int("limit", limit, 1, MAX_LIMIT)

    records, scan_metadata = scan_nodes(
        root_path,
        max_depth=max_depth,
        unbounded=unbounded,
        node_scan_limit=node_scan_limit,
        time_limit_ms=time_limit_ms,
        op_lookup=op_lookup,
        clock=clock,
    )
    matches = [
        record["hit"]
        for record in records
        if _matches(
            record["hit"],
            pattern=pattern,
            name_glob=name_glob,
            path_glob=path_glob,
            type_filter=type_filter,
            type_match=type_match,
            family=family,
        )
    ]
    returned = matches[:limit]
    metadata = {
        "scanned": scan_metadata["scanned"],
        "matched": len(matches),
        "returned": len(returned),
        "truncated": len(matches) > len(returned),
        "scan_truncated": scan_metadata["scan_truncated"],
        "count_complete": scan_metadata["count_complete"],
        "stop_reason": scan_metadata["stop_reason"],
    }
    return {"root": root_path, "nodes": returned, "metadata": metadata}
