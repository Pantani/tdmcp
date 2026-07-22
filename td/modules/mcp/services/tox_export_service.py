"""Bounded, transactional TouchDesigner COMP-to-TOX export jobs.

This service is a structured bridge primitive.  It never evaluates caller code,
loads/quits a project, or claims that TouchDesigner undo can revert a filesystem
write.  Existing targets require an internal overwrite claim produced by the
controller after consuming a matching native-broker ticket.

The first request only validates and schedules work for the next TD frame.  A
save is written to a unique same-directory temporary path, any portable-link
changes are restored in ``finally``, and a second frame verifies and atomically
promotes the artifact.  Status and cancellation are retained and idempotent.
"""

import hashlib
import json
import math
import os
import re
import secrets
import stat
import threading
import time


MAX_SOURCE_PATH = 1024
MAX_TARGET_PATH = 4096
MAX_IDEMPOTENCY_KEY = 128
MIN_IDEMPOTENCY_KEY = 16
MAX_DATS = 512
MAX_COMPS = 1024
MAX_TABLE_CELLS = 250_000
MAX_DAT_BYTES = 8 * 1024 * 1024
MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024
MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024
JOB_CAP = 32
ACTIVE_JOB_CAP = 1
TERMINAL_RETENTION_SECONDS = 300.0
STALE_TEMP_SECONDS = 3600.0
STALE_TEMP_SCAN_CAP = 16
HASH_CHUNK_BYTES = 1024 * 1024

MODES = frozenset(("as_is", "portable"))
TERMINAL = frozenset(("succeeded", "failed", "cancelled"))
CANCEL_REASONS = frozenset(("cancelled", "client_cancelled", "disconnect", "timeout"))
_KEY_RE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
_TEMP_RE = re.compile(r"^\.tdmcp-[A-Za-z0-9._-]+-[A-Za-z0-9_-]+\.tmp\.tox$")


class ToxExportError(RuntimeError):
    """Base class for typed controller error mapping."""

    code = "tox_export_error"


class InvalidArtifactPathError(ToxExportError, ValueError):
    code = "invalid_artifact_path"


class SourceNotFoundError(ToxExportError, LookupError):
    code = "source_not_found"


class SourceNotCompError(ToxExportError, ValueError):
    code = "source_not_comp"


class ArtifactOverwriteRequiredError(ToxExportError, PermissionError):
    code = "artifact_overwrite_required"


class InteractionMismatchError(ToxExportError, PermissionError):
    code = "interaction_mismatch"


class ArtifactCapacityError(ToxExportError):
    code = "artifact_capacity"


class IdempotencyConflictError(ToxExportError):
    code = "idempotency_conflict"


class UnsupportedLinkModeError(ToxExportError, ValueError):
    code = "unsupported_link_mode"


class PortableExportHeldError(ToxExportError, PermissionError):
    code = "portable_export_held"


class SnapshotLimitError(ToxExportError, ValueError):
    code = "snapshot_limit"


class ExportNotFoundError(ToxExportError, LookupError):
    code = "artifact_job_not_found"


_LOCK = threading.RLock()
_JOBS = {}
_IDEMPOTENCY = {}
_ACTIVE_OPERATION_ID = None
_CLOCK = time.monotonic


def _default_id_factory():
    return secrets.token_urlsafe(24)


_ID_FACTORY = _default_id_factory


def _clean_string(value, field, maximum):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("tox export: %s must be a non-empty string" % field)
    text = value.strip()
    if len(text) > maximum or any(char in text for char in ("\x00", "\n", "\r")):
        raise ValueError("tox export: invalid %s" % field)
    return text


def normalize_source_path(value):
    """Validate and normalize an absolute TouchDesigner operator path."""
    path = _clean_string(value, "source_path", MAX_SOURCE_PATH)
    if not path.startswith("/"):
        raise ValueError("tox export: source_path must be an absolute operator path")
    return path.rstrip("/") or "/"


def normalize_target_path(value):
    """Validate and normalize an absolute non-symlink ``.tox`` target."""
    try:
        path = _clean_string(value, "target_path", MAX_TARGET_PATH)
    except ValueError as exc:
        raise InvalidArtifactPathError(str(exc)) from exc
    if not os.path.isabs(path):
        raise InvalidArtifactPathError("tox export: target_path must be absolute")
    path = os.path.normpath(path)
    if os.path.splitext(path)[1].lower() != ".tox":
        raise InvalidArtifactPathError("tox export: target_path must end in .tox")
    if os.path.lexists(path) and os.path.islink(path):
        raise InvalidArtifactPathError("tox export: symlink targets are not allowed")
    parent = os.path.dirname(path)
    if os.path.exists(parent) and not os.path.isdir(parent):
        raise InvalidArtifactPathError("tox export: target parent is not a directory")
    return path


def _validate_mode(value):
    if value not in MODES:
        raise ValueError("tox export: mode must be as_is or portable")
    return value


def _validate_key(value):
    text = _clean_string(value, "idempotency_key", MAX_IDEMPOTENCY_KEY)
    if len(text) < MIN_IDEMPOTENCY_KEY or not _KEY_RE.fullmatch(text):
        raise ValueError("tox export: idempotency_key must be an opaque URL-safe token")
    return text


def _validate_bool(value, field):
    if type(value) is not bool:  # noqa: E721 - reject integer truthiness
        raise ValueError("tox export: %s must be a boolean" % field)
    return value


def _td_module():
    import td

    return td


def _source_identity(source_path):
    td = _td_module()
    source = td.op(source_path)
    if source is None:
        raise SourceNotFoundError("tox export: source COMP not found")
    if not bool(getattr(source, "isCOMP", False)):
        raise SourceNotCompError("tox export: source operator is not a COMP")
    return source, {
        "path": str(getattr(source, "path", source_path)),
        "id": str(getattr(source, "id", "")),
        "type": str(getattr(source, "type", getattr(source, "OPType", "COMP"))),
        "name": str(getattr(source, "name", source_path.rsplit("/", 1)[-1])),
    }


def _target_version(path):
    if not os.path.lexists(path):
        return ("missing",)
    if os.path.islink(path):
        raise InvalidArtifactPathError("tox export: symlink targets are not allowed")
    value = os.lstat(path)
    if not stat.S_ISREG(value.st_mode):
        raise InvalidArtifactPathError("tox export: existing target must be a regular file")
    return (
        "file",
        int(value.st_dev),
        int(value.st_ino),
        int(value.st_size),
        int(getattr(value, "st_mtime_ns", int(value.st_mtime * 1_000_000_000))),
    )


def _opaque_digest(*parts):
    digest = hashlib.sha256()
    for part in parts:
        raw = str(part).encode("utf-8")
        digest.update(len(raw).to_bytes(8, "big"))
        digest.update(raw)
    return digest.hexdigest()


def _overwrite_descriptor(source_path, target_path):
    source_path = normalize_source_path(source_path)
    target_path = normalize_target_path(target_path)
    _source, identity = _source_identity(source_path)
    version = _target_version(target_path)
    fingerprint = _opaque_digest(
        "artifact_overwrite",
        target_path,
        version,
        identity["path"],
        identity["id"],
        identity["type"],
        identity["name"],
    )
    return {
        "source": identity,
        "target_path": target_path,
        "target_version": version,
        "target_fingerprint": fingerprint,
        "target_exists": version[0] == "file",
    }


def build_overwrite_request(source_path, target_path):
    """Return server-derived broker copy and fingerprint for one existing target."""
    descriptor = _overwrite_descriptor(source_path, target_path)
    if not descriptor["target_exists"]:
        raise ValueError("tox export: overwrite interaction requires an existing target")
    source = descriptor["source"]
    return {
        "target_fingerprint": descriptor["target_fingerprint"],
        "normalized_target": descriptor["target_path"],
        "title": "Overwrite existing TouchDesigner component?",
        "prompt": "%s (%s) will replace %s; Keep leaves the file unchanged."
        % (source["path"], source["type"], descriptor["target_path"]),
        "choices": ["Overwrite", "Keep"],
    }


def _approval_matches(approval, descriptor):
    if not isinstance(approval, dict):
        return False
    return (
        approval.get("kind") == "artifact_overwrite"
        and approval.get("state") == "resolved"
        and approval.get("choice") == "Overwrite"
        and approval.get("target_path") == descriptor["target_path"]
        and secrets.compare_digest(
            str(approval.get("target_fingerprint") or ""),
            descriptor["target_fingerprint"],
        )
    )


def _request_fingerprint(source_path, target_path, mode, create_folders):
    return _opaque_digest(source_path, target_path, mode, bool(create_folders))


def _portable_enabled():
    # The full Text/Table DAT + root/nested externaltox restore matrix passed on
    # 2025.32820. Other builds stay fail-closed unless the operator explicitly
    # opts into their own isolated validation with the environment override.
    raw = os.environ.get("TDMCP_TOX_PORTABLE_ENABLED")
    if raw is not None:
        return raw.strip().lower() not in ("0", "false", "no", "off")
    try:
        build = str(getattr(getattr(_td_module(), "app", None), "build", ""))
    except Exception:  # noqa: BLE001
        return False
    return build in ("2025.32820", "32820")


def _new_operation_id_locked():
    for _attempt in range(8):
        operation_id = _ID_FACTORY()
        if not isinstance(operation_id, str) or len(operation_id) < 16:
            raise ArtifactCapacityError("tox export: id factory returned an invalid id")
        if operation_id not in _JOBS:
            return operation_id
    raise ArtifactCapacityError("tox export: could not allocate an operation id")


def _phase(name, status="pending", duration_ms=None, error=None):
    value = {"name": name, "status": status}
    if duration_ms is not None:
        value["duration_ms"] = max(0, int(duration_ms))
    if error is not None:
        value["error"] = str(error)[:256]
    return value


def _initial_job(operation_id, request, descriptor, approval, scheduler):
    decision = "Overwrite" if descriptor["target_exists"] else "not_required"
    return {
        "operation_id": operation_id,
        "status": "queued",
        "verdict": None,
        "source_path": request["source_path"],
        "target_path": request["target_path"],
        "mode": request["mode"],
        "decision": decision,
        "interaction_id": (approval or {}).get("request_id"),
        "action_applied": False,
        "phases": [],
        "live_state": {"snapshot_count": 0, "restored": True, "verified": True},
        "cleanup": {"temp_removed": True, "pending": False},
        "verification": {"level": "load_independent", "portable_links_at_save": None},
        "artifact": None,
        "error": None,
        "created_at": _CLOCK(),
        "_terminal_at": None,
        "_idempotency_key": request["idempotency_key"],
        "_request_fingerprint": request["request_fingerprint"],
        "_target_fingerprint": descriptor["target_fingerprint"],
        "_source_identity": descriptor["source"],
        "_create_folders": request["create_folders"],
        "_scheduler": scheduler,
        "_cancel_requested": False,
        "_temp_path": None,
        "_created_dirs": [],
    }


def _public_job(job, **extra):
    value = {
        "operation_id": job["operation_id"],
        "status": job["status"],
        "verdict": job["verdict"],
        "source_path": job["source_path"],
        "target_path": job["target_path"],
        "mode": job["mode"],
        "decision": job["decision"],
        "interaction_id": job["interaction_id"],
        "action_applied": job["action_applied"],
        "phases": [dict(item) for item in job["phases"]],
        "live_state": dict(job["live_state"]),
        "cleanup": dict(job["cleanup"]),
        "verification": dict(job["verification"]),
        "artifact": None if job["artifact"] is None else dict(job["artifact"]),
        "error": None if job["error"] is None else dict(job["error"]),
    }
    value.update(extra)
    return value


def _expired(operation_id=None, idempotency_key=None):
    value = {
        "operation_id": operation_id,
        "status": "expired",
        "verdict": "UNVERIFIED",
        "action_applied": False,
        "phases": [],
        "artifact": None,
        "error": {"code": "expired", "message": "tox export job is not retained"},
    }
    if idempotency_key is not None:
        value["idempotency_key"] = idempotency_key
    return value


def _drop_locked(operation_id):
    job = _JOBS.pop(operation_id, None)
    if job is None:
        return
    key = job["_idempotency_key"]
    if _IDEMPOTENCY.get(key) == operation_id:
        _IDEMPOTENCY.pop(key, None)


def _prune_locked(now=None):
    current = _CLOCK() if now is None else now
    stale = []
    for operation_id, job in _JOBS.items():
        terminal_at = job.get("_terminal_at")
        if terminal_at is not None and current - terminal_at >= TERMINAL_RETENTION_SECONDS:
            stale.append(operation_id)
    for operation_id in stale:
        _drop_locked(operation_id)


def _make_room_locked():
    while len(_JOBS) >= JOB_CAP:
        terminal = [job for job in _JOBS.values() if job["status"] in TERMINAL]
        if not terminal:
            raise ArtifactCapacityError("tox export: retained job limit reached")
        terminal.sort(key=lambda item: item.get("_terminal_at") or math.inf)
        _drop_locked(terminal[0]["operation_id"])


def _active_count_locked():
    return sum(1 for job in _JOBS.values() if job["status"] not in TERMINAL)


def _same_idempotent_job_locked(key, fingerprint):
    operation_id = _IDEMPOTENCY.get(key)
    if operation_id is None:
        return None
    job = _JOBS.get(operation_id)
    if job is None:
        _IDEMPOTENCY.pop(key, None)
        return None
    if not secrets.compare_digest(job["_request_fingerprint"], fingerprint):
        raise IdempotencyConflictError("tox export: idempotency key has a different request")
    return job


def _schedule(callback, scheduler=None):
    if scheduler is not None:
        scheduler(callback)
        return
    td = _td_module()
    runner = getattr(td, "run", None)
    if runner is None:
        raise RuntimeError("tox export: next-frame scheduler unavailable")
    runner("args[0]()", callback, delayFrames=1)


def _validated_start_request(
    source_path,
    target_path,
    mode,
    create_folders,
    idempotency_key,
):
    source_path = normalize_source_path(source_path)
    target_path = normalize_target_path(target_path)
    mode = _validate_mode(mode)
    create_folders = _validate_bool(create_folders, "create_folders")
    key = _validate_key(idempotency_key or secrets.token_urlsafe(24))
    if mode == "portable" and not _portable_enabled():
        raise PortableExportHeldError("tox export: portable sanitization is held by runtime policy")
    return {
        "source_path": source_path,
        "target_path": target_path,
        "mode": mode,
        "create_folders": create_folders,
        "idempotency_key": key,
        "request_fingerprint": _request_fingerprint(
            source_path, target_path, mode, create_folders
        ),
    }


def _find_duplicate(request):
    with _LOCK:
        _prune_locked()
        return _same_idempotent_job_locked(
            request["idempotency_key"], request["request_fingerprint"]
        )


def _assert_overwrite_allowed(descriptor, approval):
    if not descriptor["target_exists"] or _approval_matches(approval, descriptor):
        return
    if approval is None:
        raise ArtifactOverwriteRequiredError("tox export: existing target requires approval")
    raise InteractionMismatchError("tox export: overwrite approval no longer matches target")


def _register_job(request, descriptor, approval, scheduler):
    with _LOCK:
        _prune_locked()
        duplicate = _same_idempotent_job_locked(
            request["idempotency_key"], request["request_fingerprint"]
        )
        if duplicate is not None:
            return duplicate, True
        if _active_count_locked() >= ACTIVE_JOB_CAP:
            raise ArtifactCapacityError("tox export: another export is active")
        _make_room_locked()
        operation_id = _new_operation_id_locked()
        job = _initial_job(operation_id, request, descriptor, approval, scheduler)
        _JOBS[operation_id] = job
        _IDEMPOTENCY[request["idempotency_key"]] = operation_id
        return job, False


def start_export(
    source_path,
    target_path,
    mode="as_is",
    create_folders=False,
    idempotency_key=None,
    overwrite_approval=None,
    scheduler=None,
):
    """Validate, deduplicate and enqueue a bounded TOX export job."""
    request = _validated_start_request(
        source_path, target_path, mode, create_folders, idempotency_key
    )
    duplicate = _find_duplicate(request)
    if duplicate is not None:
        return _public_job(duplicate, deduplicated=True)

    descriptor = _overwrite_descriptor(request["source_path"], request["target_path"])
    _assert_overwrite_allowed(descriptor, overwrite_approval)
    job, deduplicated = _register_job(
        request, descriptor, overwrite_approval, scheduler
    )
    if deduplicated:
        return _public_job(job, deduplicated=True)
    operation_id = job["operation_id"]

    try:
        _schedule(lambda operation_id=operation_id: _save_phase(operation_id), scheduler)
    except Exception as exc:  # noqa: BLE001 - scheduling failure is terminal
        _finish_failure(operation_id, "scheduling_error", exc)
    return get_export(operation_id)


def _set_status(operation_id, status):
    with _LOCK:
        job = _JOBS.get(operation_id)
        if job is None or job["status"] in TERMINAL:
            return False
        if job["_cancel_requested"] and status not in ("restoring", "cancel_requested"):
            return False
        job["status"] = status
        return True


def _append_phase(operation_id, name, status, started, error=None):
    duration = (_CLOCK() - started) * 1000.0
    with _LOCK:
        job = _JOBS.get(operation_id)
        if job is not None:
            job["phases"].append(_phase(name, status, duration, error))


def _job_private(operation_id):
    with _LOCK:
        return _JOBS.get(operation_id)


def _job_cancelled(operation_id):
    with _LOCK:
        job = _JOBS.get(operation_id)
        return job is None or bool(job["_cancel_requested"])


def _preflight_still_matches(job):
    current = _overwrite_descriptor(job["source_path"], job["target_path"])
    if not secrets.compare_digest(current["target_fingerprint"], job["_target_fingerprint"]):
        raise InteractionMismatchError("tox export: source or target changed before save")
    return _source_identity(job["source_path"])[0]


def _missing_directories(parent):
    missing = []
    current = parent
    while current and not os.path.exists(current):
        missing.append(current)
        next_path = os.path.dirname(current)
        if next_path == current:
            break
        current = next_path
    return missing


def _ensure_parent(job):
    parent = os.path.dirname(job["target_path"])
    if os.path.isdir(parent):
        return
    if not job["_create_folders"]:
        raise InvalidArtifactPathError("tox export: target directory does not exist")
    missing = _missing_directories(parent)
    os.makedirs(parent, exist_ok=True)
    job["_created_dirs"] = missing


def _safe_temp_name(job):
    basename = os.path.basename(job["target_path"])
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", basename)[:160] or "component.tox"
    temp = os.path.join(
        os.path.dirname(job["target_path"]),
        ".tdmcp-%s-%s.tmp.tox" % (safe, job["operation_id"]),
    )
    if os.path.lexists(temp):
        raise InvalidArtifactPathError("tox export: temporary path collision")
    return temp


def _mode_name(par):
    mode = getattr(par, "mode", None)
    name = getattr(mode, "name", None)
    return str(name if name is not None else mode).upper()


def _constant_par_snapshot(node, name):
    par = getattr(getattr(node, "par", None), name, None)
    if par is None:
        return None
    mode_name = _mode_name(par)
    if "CONSTANT" not in mode_name:
        raise UnsupportedLinkModeError(
            "tox export: %s.%s is not in constant mode" % (getattr(node, "path", "?"), name)
        )
    return {"par": par, "name": name, "mode": getattr(par, "mode", None), "value": par.val}


def _table_content(node):
    rows = int(getattr(node, "numRows", 0))
    cols = int(getattr(node, "numCols", 0))
    if rows * cols > MAX_TABLE_CELLS:
        raise SnapshotLimitError("tox export: table DAT exceeds the cell snapshot limit")
    values = []
    for row_index in range(rows):
        row = []
        for col_index in range(cols):
            cell = node[row_index, col_index]
            row.append(str(getattr(cell, "val", cell)))
        values.append(row)
    return {"kind": "table", "value": values}


def _dat_content(node):
    if bool(getattr(node, "isTable", False)):
        content = _table_content(node)
    else:
        content = {"kind": "text", "value": str(getattr(node, "text", ""))}
    raw = json.dumps(content["value"], ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(raw) > MAX_DAT_BYTES:
        raise SnapshotLimitError("tox export: DAT exceeds the content snapshot limit")
    content["bytes"] = len(raw)
    content["digest"] = hashlib.sha256(raw).hexdigest()
    return content


def _storage_digest(node):
    storage = getattr(node, "storage", None)
    if not isinstance(storage, dict):
        return None
    digest = hashlib.sha256()
    for key in sorted(storage, key=lambda value: repr(value)):
        digest.update(repr(key).encode("utf-8", "replace"))
        digest.update(b"\0")
        digest.update(repr(storage[key]).encode("utf-8", "replace"))
        digest.update(b"\0")
    return digest.hexdigest()


def _descendants(source):
    finder = getattr(source, "findChildren", None)
    if not callable(finder):
        return []
    try:
        return list(finder())
    except TypeError:
        return list(finder(depth=999))


def _dat_snapshot_entry(node):
    if str(getattr(node, "family", "")) != "DAT":
        return None
    if getattr(getattr(node, "par", None), "file", None) is None:
        return None
    content = _dat_content(node)
    return {
        "node": node,
        "path": str(getattr(node, "path", "")),
        "id": str(getattr(node, "id", "")),
        "file": _constant_par_snapshot(node, "file"),
        "syncfile": _constant_par_snapshot(node, "syncfile"),
        "content": content,
        "storage_digest": _storage_digest(node),
    }


def _dat_snapshots(descendants):
    entries = []
    total_bytes = 0
    for node in descendants:
        entry = _dat_snapshot_entry(node)
        if entry is None:
            continue
        if len(entries) >= MAX_DATS:
            raise SnapshotLimitError("tox export: linked DAT count exceeds limit")
        total_bytes += entry["content"]["bytes"]
        if total_bytes > MAX_SNAPSHOT_BYTES:
            raise SnapshotLimitError("tox export: total DAT snapshot exceeds limit")
        entries.append(entry)
    return entries, total_bytes


def _comp_snapshot_entry(node):
    if getattr(getattr(node, "par", None), "externaltox", None) is None:
        return None
    return {
        "node": node,
        "path": str(getattr(node, "path", "")),
        "id": str(getattr(node, "id", "")),
        "externaltox": _constant_par_snapshot(node, "externaltox"),
    }


def _comp_snapshots(source, descendants):
    entries = []
    candidates = [source] + [
        node for node in descendants if bool(getattr(node, "isCOMP", False))
    ]
    for node in candidates:
        entry = _comp_snapshot_entry(node)
        if entry is None:
            continue
        if len(entries) >= MAX_COMPS:
            raise SnapshotLimitError("tox export: linked COMP count exceeds limit")
        entries.append(entry)
    return entries


def _portable_snapshot(source):
    descendants = _descendants(source)
    dats, total_bytes = _dat_snapshots(descendants)
    comps = _comp_snapshots(source, descendants)
    return {"dats": dats, "comps": comps, "total_bytes": total_bytes}


def _set_par(snapshot, value):
    snapshot["par"].val = value


def _content_digest(content):
    raw = json.dumps(content, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _current_content(entry):
    node = entry["node"]
    if entry["content"]["kind"] == "table":
        return _table_content(node)["value"]
    return str(getattr(node, "text", ""))


def _sanitize_snapshot(snapshot):
    changed = []
    for entry in snapshot["dats"]:
        if entry["syncfile"] is not None:
            _set_par(entry["syncfile"], False)
            changed.append(entry["syncfile"])
        _set_par(entry["file"], "")
        changed.append(entry["file"])
        digest = _content_digest(_current_content(entry))
        if digest != entry["content"]["digest"]:
            raise RuntimeError("DAT content changed while sanitizing %s" % entry["path"])
    for entry in snapshot["comps"]:
        _set_par(entry["externaltox"], "")
        changed.append(entry["externaltox"])
    return changed


def _restore_table(node, rows):
    node.clear()
    for row in rows:
        node.appendRow(row)


def _restore_content(entry):
    current = _current_content(entry)
    expected = entry["content"]["value"]
    if current == expected:
        return
    if entry["content"]["kind"] == "table":
        _restore_table(entry["node"], expected)
    else:
        entry["node"].text = expected


def _restore_snapshot(snapshot):
    errors = []
    for entry in reversed(snapshot["comps"]):
        try:
            _set_par(entry["externaltox"], entry["externaltox"]["value"])
        except Exception as exc:  # noqa: BLE001 - collect every restore failure
            errors.append("%s.externaltox: %s" % (entry["path"], exc))
    for entry in reversed(snapshot["dats"]):
        try:
            _set_par(entry["file"], entry["file"]["value"])
            if entry["syncfile"] is not None:
                _set_par(entry["syncfile"], entry["syncfile"]["value"])
            _restore_content(entry)
        except Exception as exc:  # noqa: BLE001 - collect every restore failure
            errors.append("%s: %s" % (entry["path"], exc))
    return errors


def _same_mode(current, expected):
    return str(getattr(current, "name", current)) == str(getattr(expected, "name", expected))


def _verify_par(snapshot):
    return snapshot["par"].val == snapshot["value"] and _same_mode(
        snapshot["par"].mode, snapshot["mode"]
    )


def _verify_dat_entry(entry):
    errors = []
    if not _verify_par(entry["file"]):
        errors.append("%s.file" % entry["path"])
    if entry["syncfile"] is not None and not _verify_par(entry["syncfile"]):
        errors.append("%s.syncfile" % entry["path"])
    if _content_digest(_current_content(entry)) != entry["content"]["digest"]:
        errors.append("%s.content" % entry["path"])
    before_storage = entry["storage_digest"]
    if before_storage is not None and _storage_digest(entry["node"]) != before_storage:
        errors.append("%s.storage" % entry["path"])
    return errors


def _verify_comp_entry(entry):
    return [] if _verify_par(entry["externaltox"]) else ["%s.externaltox" % entry["path"]]


def _verify_snapshot(snapshot):
    errors = []
    for entry in snapshot["dats"]:
        errors.extend(_verify_dat_entry(entry))
    for entry in snapshot["comps"]:
        errors.extend(_verify_comp_entry(entry))
    return errors


def _cleanup_temp(job):
    temp = job.get("_temp_path")
    removed = True
    if temp and os.path.lexists(temp):
        try:
            os.unlink(temp)
        except OSError:
            removed = False
    job["cleanup"]["temp_removed"] = removed or not (temp and os.path.lexists(temp))
    job["cleanup"]["pending"] = not job["cleanup"]["temp_removed"]


def _cleanup_created_dirs(job):
    for path in job.get("_created_dirs", []):
        try:
            os.rmdir(path)
        except OSError:
            pass


def _finish_terminal(operation_id, status, verdict, error=None):
    global _ACTIVE_OPERATION_ID
    with _LOCK:
        job = _JOBS.get(operation_id)
        if job is None or job["status"] in TERMINAL:
            return
        job["status"] = status
        job["verdict"] = verdict
        job["error"] = error
        job["_terminal_at"] = _CLOCK()
        if _ACTIVE_OPERATION_ID == operation_id:
            _ACTIVE_OPERATION_ID = None


def _finish_failure(operation_id, code, exc, phase=None):
    job = _job_private(operation_id)
    if job is None:
        return
    _cleanup_temp(job)
    _cleanup_created_dirs(job)
    message = str(exc)[:512]
    if phase is not None:
        job["phases"].append(_phase(phase, "fail", error=message))
    _finish_terminal(
        operation_id,
        "failed",
        "FAIL",
        {"code": code, "message": message},
    )


def _update_live_state(job, snapshot, restore_errors, verify_errors):
    count = len(snapshot["dats"]) + len(snapshot["comps"]) if snapshot else 0
    job["live_state"] = {
        "snapshot_count": count,
        "restored": not restore_errors,
        "verified": not restore_errors and not verify_errors,
    }


def _save_to_temp(source, temp):
    source.save(temp, createFolders=False)
    if not os.path.isfile(temp):
        raise IOError("tox export: COMP.save did not create the temporary artifact")


def _prepare_snapshot(operation_id, job):
    started = _CLOCK()
    _set_status(operation_id, "snapshotting")
    source = _preflight_still_matches(job)
    _ensure_parent(job)
    cleanup_stale_temps(job["target_path"])
    job["_temp_path"] = _safe_temp_name(job)
    snapshot = _portable_snapshot(source) if job["mode"] == "portable" else None
    _append_phase(operation_id, "snapshot", "pass", started)
    return source, snapshot


def _sanitize_and_save(operation_id, job, source, snapshot):
    if snapshot is not None:
        started = _CLOCK()
        _set_status(operation_id, "sanitizing")
        _sanitize_snapshot(snapshot)
        job["verification"]["portable_links_at_save"] = 0
        _append_phase(operation_id, "sanitize", "pass", started)

    started = _CLOCK()
    _set_status(operation_id, "saving")
    _save_to_temp(source, job["_temp_path"])
    _append_phase(operation_id, "save_temp", "pass", started)


def _restore_after_save(operation_id, job, snapshot):
    if snapshot is None:
        _update_live_state(job, None, [], [])
        return [], []
    started = _CLOCK()
    _set_status(operation_id, "restoring")
    restore_errors = _restore_snapshot(snapshot)
    verify_errors = _verify_snapshot(snapshot)
    status = "pass" if not restore_errors and not verify_errors else "fail"
    detail = "; ".join((restore_errors + verify_errors)[:8]) or None
    _append_phase(operation_id, "restore", status, started, detail)
    _update_live_state(job, snapshot, restore_errors, verify_errors)
    return restore_errors, verify_errors


def _save_phase(operation_id):
    job = _job_private(operation_id)
    if job is None or job["status"] in TERMINAL:
        return
    if _job_cancelled(operation_id):
        _finish_cancelled(operation_id, "cancelled before save")
        return
    snapshot = None
    restore_errors = []
    verify_errors = []
    try:
        source, snapshot = _prepare_snapshot(operation_id, job)
        _sanitize_and_save(operation_id, job, source, snapshot)
    except Exception as exc:  # noqa: BLE001 - restoration must still run
        save_error = exc
    else:
        save_error = None
    finally:
        restore_errors, verify_errors = _restore_after_save(
            operation_id, job, snapshot
        )

    if restore_errors or verify_errors:
        _finish_failure(
            operation_id,
            "live_restore_failed",
            RuntimeError("; ".join((restore_errors + verify_errors)[:8])),
        )
        return
    if save_error is not None:
        _finish_failure(
            operation_id,
            getattr(save_error, "code", "save_failed"),
            save_error,
        )
        return
    if _job_cancelled(operation_id):
        _finish_cancelled(operation_id, "cancelled before promotion")
        return
    _set_status(operation_id, "verifying")
    try:
        _schedule(
            lambda operation_id=operation_id: _verify_promote_phase(operation_id),
            job["_scheduler"],
        )
    except Exception as exc:  # noqa: BLE001 - scheduling failure is terminal
        _finish_failure(operation_id, "scheduling_error", exc)


def _regular_file(path):
    if not os.path.lexists(path) or os.path.islink(path):
        raise IOError("tox export: artifact is missing or is a symlink")
    value = os.lstat(path)
    if not stat.S_ISREG(value.st_mode):
        raise IOError("tox export: artifact is not a regular file")
    size = int(value.st_size)
    if size < 1 or size > MAX_ARTIFACT_BYTES:
        raise IOError("tox export: artifact size is outside the supported range")
    return size


def _sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(HASH_CHUNK_BYTES)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _td_build():
    td = _td_module()
    app = getattr(td, "app", None)
    return {
        "td_build": getattr(app, "build", None) if app is not None else None,
        "td_version": getattr(app, "version", None) if app is not None else None,
    }


def _target_unchanged(job):
    current = _overwrite_descriptor(job["source_path"], job["target_path"])
    return secrets.compare_digest(current["target_fingerprint"], job["_target_fingerprint"])


def _promote_and_readback(job, temp_size, temp_hash):
    if not _target_unchanged(job):
        raise InteractionMismatchError("tox export: source or target changed before promotion")
    os.replace(job["_temp_path"], job["target_path"])
    # The filesystem mutation has happened even if the defensive readback below
    # fails.  Preserve that distinction so callers never infer a no-op.
    job["action_applied"] = True
    final_size = _regular_file(job["target_path"])
    final_hash = _sha256_file(job["target_path"])
    if final_size != temp_size or not secrets.compare_digest(final_hash, temp_hash):
        raise IOError("tox export: final artifact readback did not match the verified temp")
    return final_size, final_hash


def _verify_promote_phase(operation_id):
    job = _job_private(operation_id)
    if job is None or job["status"] in TERMINAL:
        return
    if _job_cancelled(operation_id):
        _finish_cancelled(operation_id, "cancelled before promotion")
        return
    try:
        started = _CLOCK()
        temp_size = _regular_file(job["_temp_path"])
        temp_hash = _sha256_file(job["_temp_path"])
        _append_phase(operation_id, "verify_temp", "pass", started)
        if _job_cancelled(operation_id):
            _finish_cancelled(operation_id, "cancelled before promotion")
            return
        started = _CLOCK()
        _set_status(operation_id, "promoting")
        final_size, final_hash = _promote_and_readback(job, temp_size, temp_hash)
        _append_phase(operation_id, "promote", "pass", started)
    except InteractionMismatchError as exc:
        _finish_failure(operation_id, "interaction_mismatch", exc)
        return
    except Exception as exc:  # noqa: BLE001 - typed terminal report
        _finish_failure(operation_id, "temp_verification_or_promotion_failed", exc)
        return

    job["action_applied"] = True
    job["artifact"] = {
        "path": job["target_path"],
        "size_bytes": final_size,
        "sha256": final_hash,
        **_td_build(),
    }
    job["cleanup"]["temp_removed"] = not os.path.lexists(job["_temp_path"])
    job["cleanup"]["pending"] = not job["cleanup"]["temp_removed"]
    _finish_terminal(operation_id, "succeeded", "PASS")


def _finish_cancelled(operation_id, message):
    job = _job_private(operation_id)
    if job is None:
        return
    _cleanup_temp(job)
    _cleanup_created_dirs(job)
    _finish_terminal(
        operation_id,
        "cancelled",
        "PASS",
        {"code": "cancelled", "message": str(message)[:256]},
    )


def get_export(operation_id):
    """Return retained job status without private snapshot/content fields."""
    operation_id = _clean_string(operation_id, "operation_id", 128)
    with _LOCK:
        _prune_locked()
        job = _JOBS.get(operation_id)
        return _expired(operation_id=operation_id) if job is None else _public_job(job)


def get_export_by_key(idempotency_key):
    """Recover a response-lost start through its opaque idempotency key."""
    key = _validate_key(idempotency_key)
    with _LOCK:
        _prune_locked()
        operation_id = _IDEMPOTENCY.get(key)
        job = _JOBS.get(operation_id) if operation_id is not None else None
        return _expired(idempotency_key=key) if job is None else _public_job(job)


def cancel_export(operation_id, reason="client_cancelled"):
    """Cancel exactly once; a running ``COMP.save`` restores before terminating."""
    operation_id = _clean_string(operation_id, "operation_id", 128)
    if reason not in CANCEL_REASONS:
        raise ValueError("tox export: unsupported cancellation reason")
    with _LOCK:
        _prune_locked()
        job = _JOBS.get(operation_id)
        if job is None:
            return _expired(operation_id=operation_id)
        if job["status"] in TERMINAL or job["_cancel_requested"]:
            return _public_job(job, accepted=False)
        job["_cancel_requested"] = True
        running = job["status"] in ("snapshotting", "sanitizing", "saving", "restoring")
        job["status"] = "cancel_requested" if running else job["status"]
    if not running:
        _finish_cancelled(operation_id, reason)
    return _public_job(job, accepted=True)


def cancel_all(reason="disconnect"):
    """Fail closed on bridge teardown without exposing retained job contents."""
    if reason not in CANCEL_REASONS:
        raise ValueError("tox export: unsupported cancellation reason")
    with _LOCK:
        ids = [job["operation_id"] for job in _JOBS.values() if job["status"] not in TERMINAL]
    return [cancel_export(operation_id, reason) for operation_id in ids]


def _temp_candidates(parent):
    candidates = []
    for name in sorted(os.listdir(parent)):
        if len(candidates) >= STALE_TEMP_SCAN_CAP:
            break
        if _TEMP_RE.fullmatch(name):
            candidates.append(os.path.join(parent, name))
    return candidates


def _remove_if_stale(path, current):
    try:
        value = os.lstat(path)
        if not stat.S_ISREG(value.st_mode) or current - value.st_mtime < STALE_TEMP_SECONDS:
            return False
        os.unlink(path)
        return True
    except OSError:
        return False


def cleanup_stale_temps(target_path, now=None):
    """Remove only this service's bounded, old temp files beside one target."""
    target = normalize_target_path(target_path)
    parent = os.path.dirname(target)
    if not os.path.isdir(parent):
        return {"checked": 0, "removed": 0}
    candidates = _temp_candidates(parent)
    current = time.time() if now is None else float(now)
    removed = sum(1 for path in candidates if _remove_if_stale(path, current))
    return {"checked": len(candidates), "removed": removed}


def _reset_for_tests(clock=None, id_factory=None):
    """Clear module state; intentionally private and used only by focused tests."""
    global _ACTIVE_OPERATION_ID, _CLOCK, _ID_FACTORY
    with _LOCK:
        _JOBS.clear()
        _IDEMPOTENCY.clear()
        _ACTIVE_OPERATION_ID = None
        _CLOCK = clock or time.monotonic
        _ID_FACTORY = id_factory or _default_id_factory
