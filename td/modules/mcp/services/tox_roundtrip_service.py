"""Bounded, asynchronous quarantine validation for one ``.tox`` artifact.

The service is intentionally tox-only.  It schedules every TouchDesigner object
access on TD's main thread, loads into a uniquely-owned scratch COMP with
``COMP.loadTox``, and destroys that exact COMP before resolving.  It never calls
``project.load``, ``project.quit`` or arbitrary Python execution.
"""

import hashlib
import os
import re
import secrets
import stat
import threading
import time


MAX_PATH = 4096
MAX_ARTIFACT_BYTES = 256 * 1024 * 1024
MAX_ACTIVE = 2
MAX_RETAINED = 8
TERMINAL_RETENTION_SECONDS = 60.0
MAX_CUSTOM_PARAMETERS = 256
MAX_CONNECTORS = 64
MAX_PARAMETER_SCAN = 10000
HASH_CHUNK_BYTES = 1024 * 1024
TERMINAL = frozenset(("succeeded", "failed", "cancelled", "expired"))
_HEX_64 = re.compile(r"^[0-9a-f]{64}$")
_SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
_FILE_STYLES = frozenset(("file", "filesave", "folder"))
_LINK_NAMES = frozenset(("file", "syncfile", "externaltox", "enableexternaltox"))


class ToxRoundtripError(RuntimeError):
    code = "tox_roundtrip_error"


class InvalidToxArtifactError(ToxRoundtripError, ValueError):
    code = "invalid_tox_artifact"


class InvalidRoundtripContractError(ToxRoundtripError, ValueError):
    code = "invalid_roundtrip_contract"


class RoundtripCapacityError(ToxRoundtripError):
    code = "roundtrip_capacity"


class RoundtripNotFoundError(ToxRoundtripError, LookupError):
    code = "roundtrip_not_found"


class RoundtripLoadError(ToxRoundtripError):
    code = "roundtrip_load_failed"


_LOCK = threading.RLock()
_JOBS = {}
_CLOCK = time.monotonic


def _default_id_factory():
    return secrets.token_urlsafe(24)


_ID_FACTORY = _default_id_factory


def _td_module():
    import td

    return td


def _normalized_tox_path(value):
    if not isinstance(value, str) or not value.strip():
        raise InvalidToxArtifactError("tox roundtrip: path must be a non-empty string")
    path = value.strip()
    if len(path) > MAX_PATH or any(char in path for char in ("\x00", "\n", "\r")):
        raise InvalidToxArtifactError("tox roundtrip: invalid artifact path")
    if not os.path.isabs(path):
        raise InvalidToxArtifactError("tox roundtrip: path must be absolute")
    path = os.path.normpath(path)
    if os.path.splitext(path)[1].lower() != ".tox":
        raise InvalidToxArtifactError("tox roundtrip: only .tox artifacts are accepted")
    return path


def _validate_tox_file(path):
    if not os.path.lexists(path):
        raise InvalidToxArtifactError("tox roundtrip: artifact does not exist")
    if os.path.islink(path):
        raise InvalidToxArtifactError(
            "tox roundtrip: symlink artifacts are not allowed"
        )
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode):
        raise InvalidToxArtifactError("tox roundtrip: artifact must be a regular file")
    if info.st_size < 1 or info.st_size > MAX_ARTIFACT_BYTES:
        raise InvalidToxArtifactError("tox roundtrip: artifact size is outside bounds")


def _clean_path(value):
    path = _normalized_tox_path(value)
    _validate_tox_file(path)
    return path


def _bounded_int(value, name, minimum, maximum):
    if type(value) is not int or value < minimum or value > maximum:  # noqa: E721
        raise ValueError(
            "tox roundtrip: %s must be an integer from %d to %d"
            % (name, minimum, maximum)
        )
    return value


def _contract_sha(value):
    if not isinstance(value, str) or not _HEX_64.fullmatch(value):
        raise InvalidRoundtripContractError("tox roundtrip: invalid artifact_sha256")
    return value


def _contract_root_type(value):
    if not isinstance(value, str) or not value or len(value) > 128:
        raise InvalidRoundtripContractError("tox roundtrip: invalid root_type")
    return value


def _contract_type_counts(value):
    if not isinstance(value, dict) or len(value) > 256:
        raise InvalidRoundtripContractError("tox roundtrip: invalid type_counts")
    normalized = {}
    for key in sorted(value):
        if not isinstance(key, str) or not key or len(key) > 128:
            raise InvalidRoundtripContractError("tox roundtrip: invalid type key")
        normalized[key] = _bounded_int(value[key], "type count", 0, 2000)
    return normalized


def _contract_custom_parameter(entry):
    if not isinstance(entry, dict) or set(entry) != {"page", "name", "style"}:
        raise InvalidRoundtripContractError("tox roundtrip: invalid custom parameter")
    item = {}
    for field in ("page", "name", "style"):
        text = entry[field]
        if not isinstance(text, str) or len(text) > 128:
            raise InvalidRoundtripContractError(
                "tox roundtrip: invalid custom parameter %s" % field
            )
        item[field] = text
    return item


def _contract_custom_parameters(value):
    if not isinstance(value, list) or len(value) > MAX_CUSTOM_PARAMETERS:
        raise InvalidRoundtripContractError("tox roundtrip: invalid custom_parameters")
    normalized = [_contract_custom_parameter(entry) for entry in value]
    return sorted(
        normalized, key=lambda item: (item["page"], item["name"], item["style"])
    )


def _contract_connectors(value):
    if not isinstance(value, dict) or set(value) != {"inputs", "outputs"}:
        raise InvalidRoundtripContractError("tox roundtrip: invalid connectors")
    return {
        "inputs": _bounded_int(value["inputs"], "connector inputs", 0, 64),
        "outputs": _bounded_int(value["outputs"], "connector outputs", 0, 64),
    }


def _canonical_contract(value):
    if value is None:
        return None
    if not isinstance(value, dict) or value.get("schema_version") != 1:
        raise InvalidRoundtripContractError(
            "tox roundtrip: expected_contract.schema_version must be 1"
        )
    parsers = {
        "artifact_sha256": _contract_sha,
        "root_type": _contract_root_type,
        "node_count": lambda item: _bounded_int(item, "node_count", 0, 2000),
        "type_counts": _contract_type_counts,
        "custom_parameters": _contract_custom_parameters,
        "connectors": _contract_connectors,
        "external_references": _canonical_external_expectation,
        "max_cook_errors": lambda item: _bounded_int(item, "max_cook_errors", 0, 100),
    }
    fields = set(value) - {"schema_version"}
    if fields - set(parsers):
        raise InvalidRoundtripContractError("tox roundtrip: unknown contract field")
    result = {"schema_version": 1}
    for field in fields:
        result[field] = parsers[field](value[field])
    result.setdefault("max_cook_errors", 0)
    return result


def _canonical_fingerprints(value):
    if not isinstance(value, list) or len(value) > 200:
        raise InvalidRoundtripContractError("tox roundtrip: invalid fingerprints")
    if any(not isinstance(item, str) or not _HEX_64.fullmatch(item) for item in value):
        raise InvalidRoundtripContractError(
            "tox roundtrip: invalid reference fingerprint"
        )
    return sorted(set(value))


def _external_policy(value):
    if not isinstance(value, dict):
        raise InvalidRoundtripContractError(
            "tox roundtrip: invalid external_references"
        )
    policy = value.get("policy")
    if policy not in ("none", "package_relative_only", "exact"):
        raise InvalidRoundtripContractError("tox roundtrip: invalid external policy")
    return policy


def _canonical_external_expectation(value):
    policy = _external_policy(value)
    result = {"policy": policy}
    if "count" in value:
        result["count"] = _bounded_int(value["count"], "external count", 0, 200)
    if "fingerprints" in value:
        result["fingerprints"] = _canonical_fingerprints(value["fingerprints"])
    if policy == "exact" and "fingerprints" not in result:
        raise InvalidRoundtripContractError(
            "tox roundtrip: exact policy needs fingerprints"
        )
    return result


def _file_version(path):
    info = os.lstat(path)
    return (
        int(info.st_dev),
        int(info.st_ino),
        int(info.st_size),
        int(getattr(info, "st_mtime_ns", int(info.st_mtime * 1000000000))),
    )


def _sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(HASH_CHUNK_BYTES)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _schedule(callback, scheduler=None):
    if scheduler is not None:
        scheduler(callback)
        return
    runner = getattr(_td_module(), "run", None)
    if not callable(runner):
        raise RuntimeError("tox roundtrip: next-frame scheduler unavailable")
    runner("args[0]()", callback, delayFrames=1)


def _new_id_locked():
    for _attempt in range(8):
        operation_id = _ID_FACTORY()
        if not isinstance(operation_id, str) or not _SAFE_ID.fullmatch(operation_id):
            raise RoundtripCapacityError(
                "tox roundtrip: id factory returned an invalid id"
            )
        if operation_id not in _JOBS:
            return operation_id
    raise RoundtripCapacityError("tox roundtrip: could not allocate operation id")


def _public(job):
    return {
        "operation_id": job["operation_id"],
        "status": job["status"],
        "verdict": job["verdict"],
        "artifact": dict(job["artifact"]),
        "runtime": dict(job["runtime"]),
        "observed": dict(job["observed"]),
        "checks": [dict(check) for check in job["checks"]],
        "cleanup": dict(job["cleanup"]),
        "error": None if job["error"] is None else dict(job["error"]),
    }


def _active_count_locked():
    return sum(job["status"] not in TERMINAL for job in _JOBS.values())


def _make_room_locked():
    while len(_JOBS) >= MAX_RETAINED:
        terminal = [job for job in _JOBS.values() if job["status"] in TERMINAL]
        if not terminal:
            raise RoundtripCapacityError("tox roundtrip: retained job limit reached")
        terminal.sort(key=lambda job: job.get("_terminal_at") or float("inf"))
        _JOBS.pop(terminal[0]["operation_id"], None)


def _prune_terminal_locked():
    now = _CLOCK()
    expired = [
        operation_id
        for operation_id, job in _JOBS.items()
        if job.get("_terminal_at") is not None
        and now - job["_terminal_at"] >= TERMINAL_RETENTION_SECONDS
    ]
    for operation_id in expired:
        _JOBS.pop(operation_id, None)


def _initial_job(operation_id, request, scheduler):
    return {
        "operation_id": operation_id,
        "status": "queued",
        "verdict": "UNVERIFIED",
        "artifact": {
            "path": request["path"],
            "size_bytes": request["version"][2],
            "sha256": "",
        },
        "runtime": {"frames_waited": 0},
        "observed": {},
        "checks": [],
        "cleanup": {
            "attempted": False,
            "removed": False,
            "verified": False,
            "scratch_path": None,
        },
        "error": None,
        "_created_at": _CLOCK(),
        "_deadline": _CLOCK() + request["timeout_ms"] / 1000.0,
        "_terminal_at": None,
        "_request": request,
        "_scheduler": scheduler,
        "_cancel_requested": False,
        "_cleanup_done": False,
        "_holder": None,
        "_holder_id": None,
        "_slot": None,
    }


def start_roundtrip(
    path,
    expected_contract=None,
    artifact_sha256=None,
    settle_frames=4,
    max_nodes=500,
    max_errors=50,
    max_external_refs=50,
    timeout_ms=15000,
    scheduler=None,
):
    """Validate inputs and queue one tox-only roundtrip for the next TD frame."""
    path = _clean_path(path)
    contract = _canonical_contract(expected_contract)
    if artifact_sha256 is not None and (
        not isinstance(artifact_sha256, str) or not _HEX_64.fullmatch(artifact_sha256)
    ):
        raise ValueError("tox roundtrip: invalid artifact_sha256")
    request = {
        "path": path,
        "version": _file_version(path),
        "expected_contract": contract,
        "artifact_sha256": artifact_sha256,
        "settle_frames": _bounded_int(settle_frames, "settle_frames", 1, 120),
        "max_nodes": _bounded_int(max_nodes, "max_nodes", 1, 2000),
        "max_errors": _bounded_int(max_errors, "max_errors", 1, 100),
        "max_external_refs": _bounded_int(
            max_external_refs, "max_external_refs", 1, 200
        ),
        "timeout_ms": _bounded_int(timeout_ms, "timeout_ms", 1000, 30000),
    }
    with _LOCK:
        _prune_terminal_locked()
        if _active_count_locked() >= MAX_ACTIVE:
            raise RoundtripCapacityError("tox roundtrip: active job limit reached")
        _make_room_locked()
        operation_id = _new_id_locked()
        job = _initial_job(operation_id, request, scheduler)
        used_slots = {
            item.get("_slot")
            for item in _JOBS.values()
            if item["status"] not in TERMINAL
        }
        job["_slot"] = next(
            slot for slot in range(MAX_ACTIVE) if slot not in used_slots
        )
        _JOBS[operation_id] = job
    try:
        _schedule(
            lambda operation_id=operation_id: _load_phase(operation_id), scheduler
        )
    except Exception as exc:  # noqa: BLE001
        _finish_failure(operation_id, "scheduling_error", exc, "schedule")
    return get_roundtrip(operation_id)


def _job(operation_id):
    with _LOCK:
        return _JOBS.get(operation_id)


def _check_interrupt(job):
    if job["_cancel_requested"]:
        _finish_cancelled(job["operation_id"], "cancelled")
        return True
    if _CLOCK() >= job["_deadline"]:
        _finish_failure(
            job["operation_id"],
            "timeout",
            RuntimeError("tox roundtrip: deadline exceeded"),
            "timeout",
        )
        return True
    return False


def _project_parent(td):
    parent = td.op("/project1")
    if parent is not None and bool(getattr(parent, "isCOMP", False)):
        return parent
    root = td.op("/")
    for child in list(getattr(root, "children", []) or []):
        if bool(getattr(child, "isCOMP", False)):
            return child
    raise RoundtripLoadError("tox roundtrip: quarantine project root COMP not found")


def _create_holder(job):
    td = _td_module()
    parent = _project_parent(td)
    # URL-safe operation ids may contain '-' which is not a legal TD operator
    # name. Keep a bounded, deterministic identity while replacing separators.
    safe_id = re.sub(r"[^A-Za-z0-9_]", "_", job["operation_id"][:64])
    name = "tdmcp_rt_%s" % safe_id
    if td.op(str(getattr(parent, "path", "/project1")).rstrip("/") + "/" + name):
        raise RoundtripLoadError("tox roundtrip: scratch name collision")
    holder = parent.create(td.baseCOMP, name)
    holder.nodeX = -2400
    holder.nodeY = -2400 - job["_slot"] * 180
    job["_holder"] = holder
    job["_holder_id"] = str(getattr(holder, "id", ""))
    job["cleanup"]["scratch_path"] = str(getattr(holder, "path", ""))
    return holder


def _hash_artifact(job):
    job["status"] = "hashing"
    artifact_hash = _sha256_file(job["_request"]["path"])
    job["artifact"]["sha256"] = artifact_hash
    if job["_request"]["artifact_sha256"] not in (None, artifact_hash):
        raise InvalidToxArtifactError(
            "tox roundtrip: local/bridge artifact hash mismatch"
        )


def _load_artifact(job):
    job["status"] = "loading"
    holder = _create_holder(job)
    loader = getattr(holder, "loadTox", None)
    if not callable(loader):
        raise RoundtripLoadError("tox roundtrip: COMP.loadTox is unavailable")
    # TD 2025.32820 rejects an ``asynchronous`` keyword here. The no-keyword
    # call returns control before this job's bounded settle-frame inspection.
    loader(job["_request"]["path"])
    job["checks"].append(_check("load", "PASS", "loaded", "COMP.loadTox completed"))


def _record_runtime(job):
    app = getattr(_td_module(), "app", None)
    if app is None:
        return
    version = getattr(app, "version", None)
    build = getattr(app, "build", None)
    if version is not None:
        job["runtime"]["td_version"] = str(version)[:64]
    if isinstance(build, (int, float, str)):
        job["runtime"]["td_build"] = str(build)[:64]


def _load_phase(operation_id):
    job = _job(operation_id)
    if job is None or job["status"] in TERMINAL or _check_interrupt(job):
        return
    try:
        _hash_artifact(job)
        _load_artifact(job)
        _record_runtime(job)
        job["status"] = "settling"
        _schedule(
            lambda operation_id=operation_id: _settle_phase(operation_id),
            job["_scheduler"],
        )
    except Exception as exc:  # noqa: BLE001
        _finish_failure(operation_id, getattr(exc, "code", "load_failed"), exc, "load")


def _settle_phase(operation_id):
    job = _job(operation_id)
    if job is None or job["status"] in TERMINAL or _check_interrupt(job):
        return
    job["runtime"]["frames_waited"] += 1
    if job["runtime"]["frames_waited"] < job["_request"]["settle_frames"]:
        try:
            _schedule(
                lambda operation_id=operation_id: _settle_phase(operation_id),
                job["_scheduler"],
            )
        except Exception as exc:  # noqa: BLE001
            _finish_failure(operation_id, "scheduling_error", exc, "settle")
        return
    _inspect_phase(operation_id)


def _walk_descendants(root, limit):
    queue = list(getattr(root, "children", []) or [])
    result = []
    seen = set()
    while queue and len(result) <= limit:
        node = queue.pop(0)
        token = str(getattr(node, "id", "")) or str(getattr(node, "path", id(node)))
        if token in seen:
            continue
        seen.add(token)
        result.append(node)
        queue.extend(list(getattr(node, "children", []) or []))
    return result


def _op_type(node):
    return str(getattr(node, "OPType", None) or getattr(node, "type", "unknown"))[:128]


def _custom_parameters(holder):
    result = []
    for par in list(getattr(holder, "customPars", []) or []):
        page = getattr(getattr(par, "page", None), "name", "")
        result.append(
            {
                "page": str(page)[:128],
                "name": str(getattr(par, "name", ""))[:128],
                "style": str(getattr(par, "style", ""))[:128],
            }
        )
        if len(result) > MAX_CUSTOM_PARAMETERS:
            raise ValueError("tox roundtrip: custom parameter limit exceeded")
    return sorted(result, key=lambda item: (item["page"], item["name"], item["style"]))


def _par_value(par):
    evaluator = getattr(par, "eval", None)
    if callable(evaluator):
        return evaluator()
    return getattr(par, "val", "")


def _classify_reference(value):
    text = str(value or "").strip()
    if not text:
        return None
    lower = text.lower()
    if lower.startswith(("http://", "https://", "ftp://", "smb://", "\\\\")):
        kind = "network"
    elif "$" in text or "`" in text:
        kind = "expression_unknown"
    elif os.path.isabs(text) or re.match(r"^[A-Za-z]:[\\/]", text):
        kind = "machine_absolute"
    else:
        kind = "package_relative"
    fingerprint = hashlib.sha256(
        (kind + "\0" + text).encode("utf-8", "replace")
    ).hexdigest()
    return kind, fingerprint


def _node_parameters(node):
    pars = getattr(node, "pars", None)
    return list(pars() if callable(pars) else [])


def _scannable_parameters(nodes):
    total_parameters = 0
    for node in nodes:
        for par in _node_parameters(node):
            total_parameters += 1
            if total_parameters > MAX_PARAMETER_SCAN:
                raise ValueError("tox roundtrip: parameter scan limit exceeded")
            yield par


def _linked_reference(par):
    name = str(getattr(par, "name", "")).lower()
    style = str(getattr(par, "style", "")).lower()
    if name not in _LINK_NAMES and style not in _FILE_STYLES:
        return None
    return _classify_reference(_par_value(par))


def _external_references(nodes, maximum):
    found = []
    classifications = {}
    truncated = False
    for par in _scannable_parameters(nodes):
        classified = _linked_reference(par)
        if classified is None:
            continue
        kind, fingerprint = classified
        classifications[kind] = classifications.get(kind, 0) + 1
        if len(found) < maximum:
            found.append(fingerprint)
        else:
            truncated = True
    return {
        "total": sum(classifications.values()),
        "classifications": dict(sorted(classifications.items())),
        "fingerprints": sorted(set(found)),
        "truncated": truncated,
    }


def _node_error_lines(node):
    errors = getattr(node, "errors", None)
    if not callable(errors):
        return []
    try:
        raw = errors(recurse=False)
    except TypeError:
        raw = errors()
    return raw.splitlines() if isinstance(raw, str) else list(raw or [])


def _all_error_lines(nodes):
    for node in nodes:
        yield from _node_error_lines(node)


def _redact_error_line(line, artifact_path, home):
    message = str(line).replace(artifact_path, "[artifact]").replace(home, "[home]")
    return message.strip()[:256]


def _error_lines(nodes, artifact_path, maximum):
    messages = []
    seen = set()
    home = os.path.expanduser("~")
    for line in _all_error_lines(nodes):
        message = _redact_error_line(line, artifact_path, home)
        if not message or message in seen:
            continue
        seen.add(message)
        if len(messages) < maximum:
            messages.append(message)
    return len(seen), messages, len(seen) > maximum


def _check(name, verdict, code, summary, expected=None, actual=None):
    value = {
        "name": name,
        "verdict": verdict,
        "code": code,
        "summary": str(summary)[:256],
    }
    if expected is not None:
        value["expected"] = expected
    if actual is not None:
        value["actual"] = actual
    return value


def _compare(name, expected, actual):
    if expected is None:
        return _check(
            name, "UNVERIFIED", "expectation_missing", "No expectation supplied"
        )
    if expected == actual:
        return _check(
            name, "PASS", "matched", "Observed contract matched", expected, actual
        )
    return _check(
        name, "FAIL", "mismatch", "Observed contract differed", expected, actual
    )


def _external_check(expected, actual):
    if expected is None:
        return _check(
            "external_references",
            "UNVERIFIED",
            "expectation_missing",
            "No expectation supplied",
        )
    policy = expected["policy"]
    passed = True
    if policy == "none":
        passed = actual["total"] == 0
    elif policy == "package_relative_only":
        passed = not any(
            key in actual["classifications"]
            for key in ("machine_absolute", "network", "expression_unknown")
        )
    else:
        passed = expected.get("fingerprints", []) == actual["fingerprints"]
    if "count" in expected:
        passed = passed and expected["count"] == actual["total"]
    return _check(
        "external_references",
        "PASS" if passed else "FAIL",
        "matched" if passed else "mismatch",
        "External reference policy matched"
        if passed
        else "External reference policy differed",
        expected,
        {
            "total": actual["total"],
            "classifications": actual["classifications"],
            "fingerprints": actual["fingerprints"],
            "truncated": actual["truncated"],
        },
    )


def _contract_checks(job):
    contract = job["_request"]["expected_contract"]
    observed = job["observed"]
    if contract is None:
        contract = {}
    checks = [
        _compare(
            "artifact_hash",
            contract.get("artifact_sha256") or job["_request"]["artifact_sha256"],
            job["artifact"]["sha256"],
        ),
        _compare("root_type", contract.get("root_type"), observed["root_type"]),
        _compare("node_count", contract.get("node_count"), observed["node_count"]),
        _compare("type_counts", contract.get("type_counts"), observed["type_counts"]),
        _compare(
            "custom_parameters",
            contract.get("custom_parameters"),
            observed["custom_parameters"],
        ),
        _compare("connectors", contract.get("connectors"), observed["connectors"]),
        _external_check(
            contract.get("external_references"), observed["external_references"]
        ),
    ]
    maximum = contract.get("max_cook_errors") if contract else None
    if maximum is None:
        checks.append(
            _check(
                "cook_errors",
                "UNVERIFIED",
                "expectation_missing",
                "No error limit supplied",
            )
        )
    else:
        actual = observed["cook_error_count"]
        checks.append(
            _check(
                "cook_errors",
                "PASS" if actual <= maximum else "FAIL",
                "within_limit" if actual <= maximum else "limit_exceeded",
                "Cook errors are within limit"
                if actual <= maximum
                else "Cook error limit exceeded",
                maximum,
                actual,
            )
        )
    return checks


def _type_counts(nodes):
    counts = {}
    for node in nodes:
        op_type = _op_type(node)
        counts[op_type] = counts.get(op_type, 0) + 1
    return dict(sorted(counts.items()))


def _holder_connectors(holder):
    connectors = {
        "inputs": len(list(getattr(holder, "inputConnectors", []) or [])),
        "outputs": len(list(getattr(holder, "outputConnectors", []) or [])),
    }
    if connectors["inputs"] > MAX_CONNECTORS or connectors["outputs"] > MAX_CONNECTORS:
        raise ValueError("tox roundtrip: connector limit exceeded")
    return connectors


def _observed_contract(job, holder, bounded_nodes):
    all_nodes = [holder] + bounded_nodes
    type_counts = _type_counts(bounded_nodes)
    connectors = _holder_connectors(holder)
    external_references = _external_references(
        all_nodes, job["_request"]["max_external_refs"]
    )
    error_count, error_messages, errors_truncated = _error_lines(
        all_nodes, job["_request"]["path"], job["_request"]["max_errors"]
    )
    return {
        "root_type": _op_type(holder),
        "node_count": len(bounded_nodes),
        "type_counts": type_counts,
        "custom_parameters": _custom_parameters(holder),
        "connectors": connectors,
        "external_references": external_references,
        "cook_error_count": error_count,
        "cook_errors": error_messages,
        "cook_errors_truncated": errors_truncated,
    }


def _node_bounds_check(job, nodes, overflow):
    return _check(
        "node_bounds",
        "FAIL" if overflow else "PASS",
        "limit_exceeded" if overflow else "within_limit",
        "Node limit exceeded" if overflow else "Node traversal stayed within bounds",
        job["_request"]["max_nodes"],
        len(nodes),
    )


def _verify_artifact_unchanged(job):
    if _file_version(job["_request"]["path"]) != job["_request"]["version"]:
        raise InvalidToxArtifactError(
            "tox roundtrip: artifact changed during validation"
        )


def _checks_verdict(checks):
    verdicts = {check["verdict"] for check in checks}
    if "FAIL" in verdicts:
        return "FAIL"
    if "UNVERIFIED" in verdicts:
        return "UNVERIFIED"
    return "PASS"


def _inspect_phase(operation_id):
    job = _job(operation_id)
    if job is None or job["status"] in TERMINAL or _check_interrupt(job):
        return
    try:
        job["status"] = "inspecting"
        holder = job["_holder"]
        nodes = _walk_descendants(holder, job["_request"]["max_nodes"])
        overflow = len(nodes) > job["_request"]["max_nodes"]
        bounded_nodes = nodes[: job["_request"]["max_nodes"]]
        job["observed"] = _observed_contract(job, holder, bounded_nodes)
        job["checks"].append(_node_bounds_check(job, nodes, overflow))
        job["checks"].extend(_contract_checks(job))
        _verify_artifact_unchanged(job)
        _finish_terminal(operation_id, "succeeded", _checks_verdict(job["checks"]))
    except Exception as exc:  # noqa: BLE001
        _finish_failure(
            operation_id, getattr(exc, "code", "inspection_failed"), exc, "inspect"
        )


def _cleanup(job):
    if job["_cleanup_done"]:
        return bool(job["cleanup"]["verified"])
    job["_cleanup_done"] = True
    job["cleanup"]["attempted"] = True
    path = job["cleanup"].get("scratch_path")
    if not path:
        job["cleanup"].update({"removed": True, "verified": True})
        return True
    try:
        td = _td_module()
        current = td.op(path)
        if current is not None and str(getattr(current, "id", "")) != job["_holder_id"]:
            job["cleanup"].update({"removed": False, "verified": False})
            return False
        if current is not None:
            current.destroy()
        removed = td.op(path) is None
        job["cleanup"].update({"removed": removed, "verified": removed})
        return removed
    except Exception:  # noqa: BLE001
        job["cleanup"].update({"removed": False, "verified": False})
        return False


def _finish_terminal(operation_id, status, verdict, error=None):
    with _LOCK:
        job = _JOBS.get(operation_id)
        if job is None or job["status"] in TERMINAL:
            return False
    cleanup_ok = _cleanup(job)
    with _LOCK:
        if job["status"] in TERMINAL:
            return False
        if not cleanup_ok:
            status = "failed"
            verdict = "FAIL"
            error = {
                "code": "cleanup_failed",
                "phase": "cleanup",
                "message": "tox roundtrip: scratch cleanup could not be verified",
                "retryable": False,
            }
        job["checks"].append(
            _check(
                "cleanup",
                "PASS" if cleanup_ok else "FAIL",
                "verified" if cleanup_ok else "cleanup_failed",
                "Scratch holder removed"
                if cleanup_ok
                else "Scratch holder cleanup failed",
            )
        )
        job["status"] = status
        job["verdict"] = verdict
        job["error"] = error
        job["_terminal_at"] = _CLOCK()
        job["_holder"] = None
        return True


def _finish_failure(operation_id, code, exc, phase):
    error = {
        "code": str(code)[:64],
        "phase": str(phase)[:64],
        "message": str(exc)[:256],
        "retryable": code in ("scheduling_error", "timeout"),
    }
    _finish_terminal(operation_id, "failed", "FAIL", error)


def _finish_cancelled(operation_id, message):
    _finish_terminal(
        operation_id,
        "cancelled",
        "UNVERIFIED",
        {
            "code": "cancelled",
            "phase": "cancel",
            "message": str(message)[:256],
            "retryable": True,
        },
    )


def get_roundtrip(operation_id):
    if not isinstance(operation_id, str) or not _SAFE_ID.fullmatch(operation_id):
        raise RoundtripNotFoundError("tox roundtrip: job not found")
    job = _job(operation_id)
    if job is None:
        return {
            "operation_id": operation_id,
            "status": "expired",
            "verdict": "UNVERIFIED",
            "artifact": {},
            "runtime": {"frames_waited": 0},
            "observed": {},
            "checks": [],
            "cleanup": {"attempted": False, "removed": False, "verified": False},
            "error": {
                "code": "expired",
                "phase": "status",
                "message": "tox roundtrip: job is no longer retained",
                "retryable": True,
            },
        }
    if job["status"] not in TERMINAL and _CLOCK() >= job["_deadline"]:
        _finish_failure(
            operation_id, "timeout", RuntimeError("deadline exceeded"), "timeout"
        )
    return _public(job)


def cancel_roundtrip(operation_id, reason="client_cancelled"):
    job = _job(operation_id)
    if job is None:
        return get_roundtrip(operation_id)
    with _LOCK:
        if job["status"] in TERMINAL:
            return _public(job)
        job["_cancel_requested"] = True
    _finish_cancelled(operation_id, str(reason)[:64])
    return get_roundtrip(operation_id)


def cancel_all(reason="disconnect"):
    with _LOCK:
        active = [
            job["operation_id"]
            for job in _JOBS.values()
            if job["status"] not in TERMINAL
        ]
    for operation_id in active:
        cancel_roundtrip(operation_id, reason)
    return len(active)


def _reset_for_tests(clock=None, id_factory=None):
    global _CLOCK, _ID_FACTORY
    with _LOCK:
        _JOBS.clear()
    _CLOCK = clock or time.monotonic
    _ID_FACTORY = id_factory or _default_id_factory
