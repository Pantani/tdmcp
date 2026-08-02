"""Bounded lexical search across authored code in a live TouchDesigner project.

The service treats each DAT body and parameter expression as one coherent search
document, mirroring how code is authored and inspected in TouchDesigner.  It is
read-only, deterministic, secret-aware, and independent of ``/api/exec``.
"""

from collections import Counter
import json
import math
import re
import time
import unicodedata

from . import parameter_search_service, search_service

DEFAULT_MAX_DEPTH = 3
DEFAULT_LIMIT = 50
DEFAULT_NODE_SCAN_LIMIT = 1_000
DEFAULT_DOCUMENT_SCAN_LIMIT = 10_000
DEFAULT_PARAMETER_SCAN_LIMIT = 25_000
DEFAULT_BYTE_SCAN_LIMIT = 2 * 1_024 * 1_024
DEFAULT_TIME_BUDGET_MS = 1_000

MAX_DOCUMENT_SCAN_LIMIT = 50_000
MAX_PARAMETER_SCAN_LIMIT = 100_000
MAX_BYTE_SCAN_LIMIT = 8 * 1_024 * 1_024
MIN_TIME_BUDGET_MS = 25
MAX_TIME_BUDGET_MS = 2_500
MAX_QUERY_LENGTH = 256
MAX_EXCERPT_LENGTH = 320
MAX_RESPONSE_BYTES = 256 * 1_024
_RESPONSE_HEADROOM_BYTES = 16 * 1_024

SOURCE_KINDS = frozenset(("dat_text", "parameter_expression"))
DEFAULT_SOURCE_KINDS = ("dat_text", "parameter_expression")
_TOKEN = re.compile(r"[A-Za-z0-9]+")
_IDENTIFIER_BOUNDARY = re.compile(
    r"(?<=[A-Z])(?=[A-Z][a-z])|(?<=[a-z0-9])(?=[A-Z])|"
    r"(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])"
)
_SENSITIVE_NAME = re.compile(
    r"(?:password|passwd|secret|token|api[_-]?key|credential|authorization|bearer|private[_-]?key)",
    re.IGNORECASE,
)
_SECRET_ASSIGNMENT = re.compile(
    r"([\"']?)\b(password|passwd|secret|token|api[_-]?key|credential|authorization|private[_-]?key)"
    r"\b\1(\s*[:=]\s*)(?:\"[^\"\r\n]*\"|'[^'\r\n]*'|[^\s,;]+)",
    re.IGNORECASE,
)
_BEARER_VALUE = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{8,}", re.IGNORECASE)
_URL_CREDENTIALS = re.compile(r"://[^:/\s]+:[^@\s]+@")
_PRIVATE_KEY_BLOCK = re.compile(
    r"-----BEGIN [^-\r\n]*PRIVATE KEY-----.*?-----END [^-\r\n]*PRIVATE KEY-----",
    re.DOTALL,
)


def _bounded_int(name, value, minimum, maximum):
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("%s must be an integer." % name)
    if value < minimum or value > maximum:
        raise ValueError("%s must be between %d and %d." % (name, minimum, maximum))
    return value


def _validate_query(query):
    if not isinstance(query, str):
        raise ValueError("query must be a string.")
    query = query.strip()
    if not query:
        raise ValueError("query must not be empty.")
    if len(query) > MAX_QUERY_LENGTH:
        raise ValueError("query exceeds its maximum length.")
    if any(char in query for char in ("\x00", "\r", "\n")):
        raise ValueError("query contains unsupported control characters.")
    if not _tokenize(query):
        raise ValueError("query must contain at least one alphanumeric token.")
    return query


def _validate_source_kinds(source_kinds):
    if source_kinds is None:
        return DEFAULT_SOURCE_KINDS
    if not isinstance(source_kinds, (list, tuple)) or not source_kinds:
        raise ValueError("source_kinds must be a non-empty list.")
    normalized = []
    for value in source_kinds:
        if not isinstance(value, str) or value not in SOURCE_KINDS:
            raise ValueError(
                "source_kinds entries must be one of: %s."
                % ", ".join(sorted(SOURCE_KINDS))
            )
        if value not in normalized:
            normalized.append(value)
    return tuple(normalized)


def _tokenize(text):
    normalized = unicodedata.normalize("NFD", str(text))
    ascii_text = normalized.encode("ascii", "ignore").decode("ascii")
    tokens = []
    for identifier in _TOKEN.findall(ascii_text):
        folded = identifier.lower()
        tokens.append(folded)
        parts = _IDENTIFIER_BOUNDARY.split(identifier)
        if len(parts) > 1:
            tokens.extend(part.lower() for part in parts if part.lower() != folded)
    return tokens


def _redact_text(text):
    redacted = _PRIVATE_KEY_BLOCK.sub("[REDACTED PRIVATE KEY]", text)
    redacted = _URL_CREDENTIALS.sub("://[REDACTED]@", redacted)
    redacted = _BEARER_VALUE.sub("Bearer [REDACTED]", redacted)
    redacted = _SECRET_ASSIGNMENT.sub(
        lambda match: "%s%s%s%s[REDACTED]"
        % (match.group(1), match.group(2), match.group(1), match.group(3)),
        redacted,
    )
    return redacted, redacted != text


def _clip_utf8(text, maximum_bytes):
    candidate = text[:maximum_bytes]
    encoded = candidate.encode("utf-8")
    if len(encoded) <= maximum_bytes:
        return candidate, len(candidate) < len(text)
    return encoded[:maximum_bytes].decode("utf-8", errors="ignore"), True


def _document(record, source_kind, field, text, *, redacted=False, truncated=False):
    hit = record["hit"]
    searchable = " ".join(
        (hit["path"], hit["name"], hit["type"], hit["family"], source_kind, field, text)
    )
    return {
        "op": hit["path"],
        "type": hit["type"],
        "family": hit["family"],
        "source_kind": source_kind,
        "field": field,
        "text": text,
        "searchable": searchable,
        "tokens": _tokenize(searchable),
        "redacted": redacted,
        "content_truncated": truncated,
    }


def _safe_dat_document(record, remaining_bytes):
    hit = record["hit"]
    if hit["family"] != "DAT":
        return "not_applicable", None, 0
    if _SENSITIVE_NAME.search(hit["name"]) or _SENSITIVE_NAME.search(hit["path"]):
        return "redacted", None, 0
    try:
        raw = str(record["node"].text)
    except Exception:  # noqa: BLE001
        return "unreadable", None, 0
    redacted, changed = _redact_text(raw)
    clipped, char_truncated = _clip_utf8(redacted, remaining_bytes)
    encoded_bytes = len(clipped.encode("utf-8"))
    if not clipped and raw:
        return "byte_limit", None, 0
    return (
        "matched",
        _document(
            record,
            "dat_text",
            "text",
            clipped,
            redacted=changed,
            truncated=char_truncated,
        ),
        encoded_bytes,
    )


def _named_parameters(node):
    parameters = []
    unreadable = 0
    try:
        raw_parameters = list(node.pars() or [])
    except Exception:  # noqa: BLE001
        return parameters, 1
    for par in raw_parameters:
        try:
            name = str(par.name)
            if not name:
                raise ValueError("empty parameter name")
        except Exception:  # noqa: BLE001
            unreadable += 1
            continue
        parameters.append((name.encode("utf-8"), name, par))
    parameters.sort(key=lambda item: item[0])
    return parameters, unreadable


def _read_expression(record, name, par):
    try:
        hit = record["hit"]
        sensitive_node = _SENSITIVE_NAME.search(hit["name"]) or _SENSITIVE_NAME.search(
            hit["path"]
        )
        if sensitive_node or parameter_search_service._is_sensitive(par, name):
            return "redacted", None
        expression = getattr(par, "expr", "")
        return "read", "" if expression is None else str(expression)
    except Exception:  # noqa: BLE001
        return "unreadable", None


def _safe_expression_document(record, name, par, remaining_bytes):
    outcome, expression = _read_expression(record, name, par)
    if outcome != "read":
        return outcome, None, 0
    if not expression:
        return "not_applicable", None, 0
    redacted, changed = _redact_text(expression)
    clipped, char_truncated = _clip_utf8(redacted, remaining_bytes)
    encoded_bytes = len(clipped.encode("utf-8"))
    if not clipped and expression:
        return "byte_limit", None, 0
    return (
        "matched",
        _document(
            record,
            "parameter_expression",
            name,
            clipped,
            redacted=changed,
            truncated=char_truncated,
        ),
        encoded_bytes,
    )


def _new_state(stop_reason):
    return {
        "documents": [],
        "scanned_documents": 0,
        "scanned_parameters": 0,
        "scanned_bytes": 0,
        "unreadable_documents": 0,
        "skipped_documents": 0,
        "redacted_documents": 0,
        "stop_reason": stop_reason,
        "document_scan_stopped": False,
    }


def _document_budget_reason(state, document_scan_limit, byte_scan_limit, deadline, clock):
    if state["scanned_documents"] >= document_scan_limit:
        return "document_scan_limit"
    if state["scanned_bytes"] >= byte_scan_limit:
        return "byte_scan_limit"
    if clock() >= deadline:
        return "time_limit"
    return None


def _record_outcome(state, outcome, document, encoded_bytes):
    if outcome == "not_applicable":
        return
    state["scanned_documents"] += 1
    if outcome == "unreadable":
        state["unreadable_documents"] += 1
        state["skipped_documents"] += 1
        return
    if outcome == "redacted":
        state["redacted_documents"] += 1
        state["skipped_documents"] += 1
        return
    if outcome == "byte_limit":
        state["stop_reason"] = "byte_scan_limit"
        state["document_scan_stopped"] = True
        return
    state["documents"].append(document)
    state["scanned_bytes"] += encoded_bytes
    if document["redacted"]:
        state["redacted_documents"] += 1
    if document["content_truncated"]:
        state["stop_reason"] = "byte_scan_limit"
        state["document_scan_stopped"] = True


def _stop_for_document_budget(
    state, document_scan_limit, byte_scan_limit, deadline, clock
):
    reason = _document_budget_reason(
        state, document_scan_limit, byte_scan_limit, deadline, clock
    )
    if reason is None:
        return False
    state["stop_reason"] = reason
    state["document_scan_stopped"] = True
    return True


def _scan_dat_source(
    record,
    source_kinds,
    state,
    document_scan_limit,
    byte_scan_limit,
    deadline,
    clock,
):
    if "dat_text" not in source_kinds or _stop_for_document_budget(
        state, document_scan_limit, byte_scan_limit, deadline, clock
    ):
        return
    remaining = byte_scan_limit - state["scanned_bytes"]
    _record_outcome(state, *_safe_dat_document(record, remaining))


def _scan_parameter_sources(
    record,
    source_kinds,
    state,
    document_scan_limit,
    parameter_scan_limit,
    byte_scan_limit,
    deadline,
    clock,
):
    if "parameter_expression" not in source_kinds:
        return
    parameters, unreadable = _named_parameters(record["node"])
    state["unreadable_documents"] += unreadable
    state["skipped_documents"] += unreadable
    for _, name, par in parameters:
        if state["scanned_parameters"] >= parameter_scan_limit:
            state["stop_reason"] = "parameter_scan_limit"
            state["document_scan_stopped"] = True
            return
        state["scanned_parameters"] += 1
        if _stop_for_document_budget(
            state, document_scan_limit, byte_scan_limit, deadline, clock
        ):
            return
        remaining = byte_scan_limit - state["scanned_bytes"]
        _record_outcome(
            state, *_safe_expression_document(record, name, par, remaining)
        )
        if state["document_scan_stopped"]:
            return


def _scan_record(
    record,
    source_kinds,
    state,
    document_scan_limit,
    parameter_scan_limit,
    byte_scan_limit,
    deadline,
    clock,
):
    _scan_dat_source(
        record,
        source_kinds,
        state,
        document_scan_limit,
        byte_scan_limit,
        deadline,
        clock,
    )
    if state["document_scan_stopped"]:
        return
    _scan_parameter_sources(
        record,
        source_kinds,
        state,
        document_scan_limit,
        parameter_scan_limit,
        byte_scan_limit,
        deadline,
        clock,
    )


def _bm25_index(documents):
    frequencies = []
    document_frequency = Counter()
    total_length = 0
    for document in documents:
        frequency = Counter(document["tokens"])
        frequencies.append(frequency)
        total_length += len(document["tokens"])
        document_frequency.update(frequency.keys())
    average_length = max(1.0, total_length / float(len(documents)))
    return frequencies, document_frequency, average_length


def _bm25_document_score(
    frequency,
    length,
    document_frequency,
    document_count,
    average_length,
    query_tokens,
):
    score = 0.0
    for token in set(query_tokens):
        term_frequency = frequency.get(token, 0)
        if not term_frequency:
            continue
        containing = document_frequency[token]
        inverse_frequency = math.log(
            1.0 + (document_count - containing + 0.5) / (containing + 0.5)
        )
        numerator = term_frequency * 2.2
        denominator = term_frequency + 1.2 * (
            0.25 + 0.75 * (length / average_length)
        )
        score += inverse_frequency * (numerator / denominator)
    return score


def _bm25_scores(documents, query_tokens):
    if not documents:
        return []
    frequencies, document_frequency, average_length = _bm25_index(documents)
    document_count = len(documents)
    return [
        _bm25_document_score(
            frequency,
            max(1, len(document["tokens"])),
            document_frequency,
            document_count,
            average_length,
            query_tokens,
        )
        for document, frequency in zip(documents, frequencies)
    ]


def _line_rank(line, query_folded, query_tokens):
    folded = line.casefold()
    exact = 1 if query_folded in folded else 0
    line_tokens = set(_tokenize(line))
    terms = sum(1 for token in set(query_tokens) if token in line_tokens)
    return exact, terms


def _matching_column(line, query_folded, query_tokens):
    folded = line.casefold()
    column = folded.find(query_folded)
    if column >= 0:
        return column
    columns = [folded.find(token) for token in query_tokens]
    columns = [value for value in columns if value >= 0]
    return min(columns) if columns else 0


def _clip_excerpt(line, column):
    if len(line) <= MAX_EXCERPT_LENGTH:
        return line, False
    start = max(0, column - (MAX_EXCERPT_LENGTH // 3))
    end = min(len(line), start + MAX_EXCERPT_LENGTH)
    if end - start < MAX_EXCERPT_LENGTH:
        start = max(0, end - MAX_EXCERPT_LENGTH)
    excerpt = line[start:end]
    if start:
        excerpt = "…" + excerpt[1:]
    if end < len(line):
        excerpt = excerpt[:-1] + "…"
    return excerpt, True


def _best_excerpt(text, query, query_tokens):
    lines = text.splitlines() or [text]
    query_folded = query.casefold()
    best_index = 0
    best_rank = (-1, -1)
    for index, line in enumerate(lines):
        rank = _line_rank(line, query_folded, query_tokens)
        if rank > best_rank:
            best_rank = rank
            best_index = index
    line = lines[best_index]
    column = _matching_column(line, query_folded, query_tokens)
    excerpt, truncated = _clip_excerpt(line, column)
    return excerpt, best_index + 1, column + 1, truncated


def _ranked_hit(document, bm25_score, query, query_tokens):
    folded_query = query.casefold()
    literal = folded_query in document["searchable"].casefold()
    if bm25_score <= 0 and not literal:
        return None
    score = bm25_score + (2.0 if literal else 0.0)
    if folded_query in document["op"].casefold() or folded_query == document["field"].casefold():
        score += 1.0
    excerpt, line, column, excerpt_truncated = _best_excerpt(
        document["text"], query, query_tokens
    )
    hit = {
        "op": document["op"],
        "type": document["type"],
        "family": document["family"],
        "source_kind": document["source_kind"],
        "field": document["field"],
        "line": line,
        "column": column,
        "excerpt": excerpt,
        "score": round(score, 6),
        "rank_sources": (["literal"] if literal else []) + ["bm25"],
    }
    if document["redacted"]:
        hit["redacted"] = True
    if document["content_truncated"]:
        hit["content_truncated"] = True
    if excerpt_truncated:
        hit["excerpt_truncated"] = True
    return hit


def _rank_documents(documents, query):
    query_tokens = _tokenize(query)
    bm25 = _bm25_scores(documents, query_tokens)
    ranked = []
    for document, bm25_score in zip(documents, bm25):
        hit = _ranked_hit(document, bm25_score, query, query_tokens)
        if hit is not None:
            ranked.append(hit)
    ranked.sort(
        key=lambda hit: (
            -hit["score"],
            hit["op"].encode("utf-8"),
            hit["source_kind"],
            hit["field"].encode("utf-8"),
        )
    )
    return ranked


def _bounded_results(ranked, limit):
    retained = []
    retained_bytes = 0
    response_closed = False
    for hit in ranked:
        if len(retained) >= limit:
            break
        size = len(
            json.dumps(hit, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode(
                "utf-8"
            )
        )
        if retained_bytes + size > MAX_RESPONSE_BYTES - _RESPONSE_HEADROOM_BYTES:
            response_closed = True
            break
        retained.append(hit)
        retained_bytes += size
    return retained, response_closed


def search_code(
    query,
    root_path="/project1",
    *,
    max_depth=DEFAULT_MAX_DEPTH,
    source_kinds=None,
    node_pattern=None,
    node_name_glob=None,
    node_path_glob=None,
    type_filter=None,
    type_match="partial",
    family=None,
    limit=DEFAULT_LIMIT,
    node_scan_limit=DEFAULT_NODE_SCAN_LIMIT,
    document_scan_limit=DEFAULT_DOCUMENT_SCAN_LIMIT,
    parameter_scan_limit=DEFAULT_PARAMETER_SCAN_LIMIT,
    byte_scan_limit=DEFAULT_BYTE_SCAN_LIMIT,
    time_budget_ms=DEFAULT_TIME_BUDGET_MS,
    op_lookup=None,
    clock=None,
):
    """Search DAT bodies and parameter expressions with truthful bounded metadata."""
    query = _validate_query(query)
    source_kinds = _validate_source_kinds(source_kinds)
    max_depth = _bounded_int("max_depth", max_depth, 1, search_service.MAX_DEPTH)
    limit = _bounded_int("limit", limit, 1, search_service.MAX_LIMIT)
    node_scan_limit = _bounded_int(
        "node_scan_limit", node_scan_limit, 1, search_service.MAX_NODE_SCAN_LIMIT
    )
    document_scan_limit = _bounded_int(
        "document_scan_limit", document_scan_limit, 1, MAX_DOCUMENT_SCAN_LIMIT
    )
    parameter_scan_limit = _bounded_int(
        "parameter_scan_limit", parameter_scan_limit, 1, MAX_PARAMETER_SCAN_LIMIT
    )
    byte_scan_limit = _bounded_int(
        "byte_scan_limit", byte_scan_limit, 1, MAX_BYTE_SCAN_LIMIT
    )
    time_budget_ms = _bounded_int(
        "time_budget_ms", time_budget_ms, MIN_TIME_BUDGET_MS, MAX_TIME_BUDGET_MS
    )
    filters = parameter_search_service._validate_filters(
        node_pattern=node_pattern,
        node_name_glob=node_name_glob,
        node_path_glob=node_path_glob,
        type_filter=type_filter,
        type_match=type_match,
        family=family,
        parameter_glob=None,
        value_glob=None,
        expression_glob=None,
        mode=None,
    )

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
    state = _new_state(node_metadata["stop_reason"])
    for record in records:
        if not parameter_search_service._node_matches(record["hit"], filters):
            continue
        _scan_record(
            record,
            source_kinds,
            state,
            document_scan_limit,
            parameter_scan_limit,
            byte_scan_limit,
            deadline,
            clock,
        )
        if state["document_scan_stopped"]:
            break

    ranked = _rank_documents(state["documents"], query)
    results, response_closed = _bounded_results(ranked, limit)
    matched = len(ranked)
    returned = len(results)
    scan_truncated = node_metadata["scan_truncated"] or state["document_scan_stopped"]
    elapsed_ms = max(0, int(round((clock() - started) * 1_000.0)))
    return {
        "query": query,
        "root_path": root_path,
        "max_depth": max_depth,
        "source_kinds": list(source_kinds),
        "results": results,
        "scanned_nodes": node_metadata["scanned"],
        "scanned_documents": state["scanned_documents"],
        "scanned_parameters": state["scanned_parameters"],
        "scanned_bytes": state["scanned_bytes"],
        "matched": matched,
        "returned": returned,
        "limit": limit,
        "truncated": matched > returned or response_closed,
        "scan_truncated": scan_truncated,
        "count_complete": not scan_truncated,
        "unreadable_documents": state["unreadable_documents"],
        "skipped_documents": state["skipped_documents"],
        "redacted_documents": state["redacted_documents"],
        "stop_reason": state["stop_reason"],
        "elapsed_ms": elapsed_ms,
    }
