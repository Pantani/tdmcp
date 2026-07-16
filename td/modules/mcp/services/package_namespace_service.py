"""Bounded package-namespace ownership plans and fail-closed live reconciliation.

This is a first-class structured bridge service.  It never evaluates caller code,
does not depend on ``TDMCP_BRIDGE_ALLOW_EXEC``, and retains only hashed source
identity plus bounded TD paths in its in-memory plans.  Raw marker JSON is parsed
only long enough to classify ownership and is never returned or stored.
"""

import hashlib
import json
import math
import secrets
import threading
import time


MAX_PATH_LENGTH = 1024
MAX_PACKAGE_ID_LENGTH = 128
MAX_SOURCE_URL_LENGTH = 2048
MAX_REF_LENGTH = 256
MAX_MARKER_BYTES = 16 * 1024
MAX_CANDIDATES = 64
MAX_WARNINGS = 32
MAX_PLANS = 64
PLAN_TTL_SECONDS = 120.0
ACTIONABLE = frozenset(("aligned_owned", "renamed_owned"))
SCOPES = frozenset(("user", "project"))
INTENTS = frozenset(("prune", "replace"))


class PackageNamespaceError(RuntimeError):
    """A typed, bounded package-reconciliation failure."""

    code = "package_namespace_error"


class PackageNamespaceValidationError(PackageNamespaceError, ValueError):
    code = "invalid_input"


class PackageNamespaceNotFoundError(PackageNamespaceError, LookupError):
    code = "namespace_not_found"


class PackageNamespaceCapacityError(PackageNamespaceError):
    code = "namespace_capacity"


class PackagePlanNotFoundError(PackageNamespaceError, LookupError):
    code = "plan_not_found"


class PackagePlanExpiredError(PackageNamespaceError):
    code = "plan_expired"


class PackagePlanStaleError(PackageNamespaceError):
    code = "stale_plan"


class PackageOwnershipError(PackageNamespaceError):
    code = "foreign_package_target"


class PackageInteractionError(PackageNamespaceError):
    code = "interaction_mismatch"


class PackageStateReadbackError(PackageNamespaceError):
    code = "state_readback_failed"


class PackagePostApplyStateChangedError(PackageNamespaceError):
    code = "post_apply_state_changed"


def _bounded_text(value, field, maximum, allow_empty=False):
    if not isinstance(value, str):
        raise PackageNamespaceValidationError("%s must be a string" % field)
    value = value.strip()
    if not allow_empty and not value:
        raise PackageNamespaceValidationError("%s must not be empty" % field)
    if len(value) > maximum:
        raise PackageNamespaceValidationError("%s exceeds the maximum length" % field)
    return value


def _path(value, field="path"):
    value = _bounded_text(value, field, MAX_PATH_LENGTH)
    if not value.startswith("/") or "//" in value:
        raise PackageNamespaceValidationError("%s must be an absolute TD path" % field)
    return value.rstrip("/") or "/"


def _source_hash(source_url):
    source = _bounded_text(source_url, "source_url", MAX_SOURCE_URL_LENGTH)
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def _safe_path(value):
    try:
        path = value.path
        return str(path) if path else None
    except Exception:  # noqa: BLE001
        return None


def _safe_text(value, maximum=128):
    try:
        text = str(value)
    except Exception:  # noqa: BLE001
        return ""
    return text[:maximum]


def _canonical_digest(value):
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _marker_node(candidate):
    try:
        marker = candidate.op("tdmcp_package_info")
        if marker is not None:
            return marker
    except Exception:  # noqa: BLE001
        pass
    try:
        for child in list(candidate.children or []):
            if _safe_text(getattr(child, "name", "")) == "tdmcp_package_info":
                return child
    except Exception:  # noqa: BLE001
        pass
    return None


def _marker_result(status, matched=False, schema_version=None):
    return {
        "status": status,
        "matched": bool(matched),
        "schema_version": schema_version,
    }


def _marker_payload(candidate):
    marker = _marker_node(candidate)
    if marker is None:
        return None, "missing"
    try:
        raw = marker.text
    except Exception:  # noqa: BLE001
        return None, "unreadable"
    if not isinstance(raw, str) or len(raw.encode("utf-8")) > MAX_MARKER_BYTES:
        return None, "unreadable"
    try:
        marker_data = json.loads(raw)
    except Exception:  # noqa: BLE001
        return None, "unreadable"
    if not isinstance(marker_data, dict):
        return None, "unreadable"
    return marker_data, None


def _read_v1_marker(marker_data, expected):
    marker_id = marker_data.get("id")
    marker_source = marker_data.get("source")
    same_id = isinstance(marker_id, str) and secrets.compare_digest(
        marker_id, expected["package_id"]
    )
    source_matches = isinstance(marker_source, str) and secrets.compare_digest(
        hashlib.sha256(marker_source.encode("utf-8")).hexdigest(),
        expected["source_hash"],
    )
    if same_id and source_matches:
        return _marker_result("match", True, 1)
    return _marker_result("mismatch" if same_id else "foreign", schema_version=1)


def _read_v2_marker(marker_data, expected):
    marker_id = marker_data.get("package_id")
    marker_source_hash = marker_data.get("source_hash")
    artifact_hash = marker_data.get("artifact_hash")
    same_id = isinstance(marker_id, str) and secrets.compare_digest(
        marker_id, expected["package_id"]
    )
    valid_artifact = (
        isinstance(artifact_hash, str)
        and len(artifact_hash) == 64
        and all(ch in "0123456789abcdefABCDEF" for ch in artifact_hash)
    )
    matched = (
        same_id
        and isinstance(marker_source_hash, str)
        and secrets.compare_digest(marker_source_hash, expected["source_hash"])
        and marker_data.get("ref") == expected["recorded_ref"]
        and marker_data.get("scope") == expected["scope"]
        and valid_artifact
    )
    if matched:
        return _marker_result("match", True, 2)
    return _marker_result("mismatch" if same_id else "foreign", schema_version=2)


def _read_marker(candidate, expected):
    marker_data, error = _marker_payload(candidate)
    if marker_data is None:
        return _marker_result(error or "unreadable")

    schema_version = marker_data.get("schema_version", 1)
    if schema_version == 1:
        return _read_v1_marker(marker_data, expected)
    if schema_version == 2:
        return _read_v2_marker(marker_data, expected)
    return _marker_result("unreadable")


def _scan_candidates(namespace, expected):
    try:
        candidates = list(namespace.children or [])
    except Exception as exc:  # noqa: BLE001
        raise PackageStateReadbackError("package namespace children unavailable") from exc
    if len(candidates) > MAX_CANDIDATES:
        raise PackageNamespaceCapacityError(
            "package namespace exceeds the bounded candidate limit"
        )

    summaries = []
    matches = []
    exact = None
    expected_path = expected["recorded_target_path"]
    for candidate in candidates:
        identity = _node_identity(candidate)
        marker = _read_marker(candidate, expected)
        summaries.append(
            {
                "path": identity["path"],
                "marker_status": marker["status"],
                "marker_schema_version": marker["schema_version"],
            }
        )
        candidate_info = {"identity": identity, "marker": marker}
        if identity["path"] == expected_path:
            exact = candidate_info
        if marker["matched"]:
            matches.append(candidate_info)
    return summaries, matches, exact


def _classify_candidates(matches, exact, expected_path):
    warnings = []
    resolved = None
    marker = {"matched": False, "schema_version": None}
    if len(matches) > 1:
        return (
            "duplicate_owned",
            resolved,
            marker,
            ["Multiple matching package markers were found; no target is actionable."],
        )
    if len(matches) == 1:
        resolved = matches[0]["identity"]
        marker = {
            "matched": True,
            "schema_version": matches[0]["marker"]["schema_version"],
        }
        classification = (
            "aligned_owned" if resolved["path"] == expected_path else "renamed_owned"
        )
        if exact is not None and resolved["path"] != expected_path:
            warnings.append(
                "The recorded target path is occupied by a foreign node; only the unique marker match is actionable."
            )
        return classification, resolved, marker, warnings
    if exact is None:
        return "missing_live", resolved, marker, warnings
    classification = {
        "missing": "marker_missing",
        "unreadable": "marker_unreadable",
        "mismatch": "marker_mismatch",
        "foreign": "foreign_target",
    }.get(exact["marker"]["status"], "marker_unreadable")
    return classification, resolved, marker, warnings


def _node_identity(node):
    path = _safe_path(node)
    if not path:
        raise PackageStateReadbackError("package target path was unreadable")
    return {
        "path": path,
        "name": _safe_text(getattr(node, "name", "")),
        # Match api_service.get_node(), which is the authority used when the
        # broker creates the approval fingerprint. TD's ``type`` and ``OPType``
        # differ (for example ``base`` vs ``baseCOMP``), so mixing them makes a
        # correctly resolved native choice fail closed at consumption.
        "type": _safe_text(
            getattr(node, "OPType", None) or getattr(node, "type", "")
        ),
    }


class PackageNamespaceService:
    """Plan/check/apply service with bounded, sanitized, exactly-once receipts."""

    def __init__(
        self,
        resolver,
        clock=None,
        id_factory=None,
        plan_ttl=PLAN_TTL_SECONDS,
        plan_cap=MAX_PLANS,
        fingerprint_target=None,
        consume_interaction=None,
        delete_node=None,
    ):
        self._resolver = resolver
        self._clock = clock or time.monotonic
        self._id_factory = id_factory or (lambda: secrets.token_urlsafe(24))
        self._plan_ttl = float(plan_ttl)
        self._plan_cap = int(plan_cap)
        if not math.isfinite(self._plan_ttl) or self._plan_ttl <= 0:
            raise ValueError("plan_ttl must be finite and positive")
        if self._plan_cap <= 0 or self._plan_cap > MAX_PLANS:
            raise ValueError("plan_cap must be between 1 and %d" % MAX_PLANS)
        self._fingerprint_target = fingerprint_target
        self._consume_interaction = consume_interaction
        self._delete_node = delete_node
        self._plans = {}
        self._dedupe = {}
        self._sequence = 0
        self._lock = threading.RLock()

    def check(
        self,
        project_path,
        package_id,
        source_url,
        recorded_ref,
        scope,
        intent,
        recorded_target_path=None,
    ):
        expected = self._validate_expected(
            project_path,
            package_id,
            source_url,
            recorded_ref,
            scope,
            intent,
            recorded_target_path,
        )
        with self._lock:
            now = self._clock()
            self._prune(now)
            observation = self._observe(expected)
            request_digest = _canonical_digest(
                {"expected": expected, "observation": observation["fingerprint"]}
            )
            duplicate = self._dedupe.get(request_digest)
            if duplicate is not None and duplicate in self._plans:
                return self._public_plan(self._plans[duplicate], deduplicated=True)
            self._make_room()
            plan_id = self._new_plan_id()
            record = {
                "plan_id": plan_id,
                "expected": expected,
                "observation": observation,
                "request_digest": request_digest,
                "created_at": now,
                "expires_at": now + self._plan_ttl,
                "sequence": self._sequence,
                "terminal": None,
            }
            self._sequence += 1
            self._plans[plan_id] = record
            self._dedupe[request_digest] = plan_id
            return self._public_plan(record, deduplicated=False)

    def apply(
        self,
        plan_id,
        choice,
        confirmation_policy,
        interaction_id=None,
    ):
        plan_id = _bounded_text(plan_id, "plan_id", 128)
        self._validate_apply(choice, confirmation_policy, interaction_id)
        with self._lock:
            record = self._require_plan(plan_id)
            if record["terminal"] is not None:
                return self._replay_terminal(record)
            target_path, target = self._revalidate_plan(record)
            decision = self._decision(
                target,
                choice,
                confirmation_policy,
                interaction_id,
            )
            terminal = self._mutate(
                record,
                target,
                target_path,
                decision,
                confirmation_policy,
                interaction_id,
            )
            record["terminal"] = terminal
            return dict(terminal)

    def _require_plan(self, plan_id):
        record = self._plans.get(plan_id)
        if record is None:
            raise PackagePlanNotFoundError("package reconciliation plan not found")
        expired = self._clock() >= record["expires_at"] and record["terminal"] is None
        if expired:
            self._remove_plan(record)
            raise PackagePlanExpiredError("package reconciliation plan expired")
        return record

    def _revalidate_plan(self, record):
        current = self._observe(record["expected"])
        if current["fingerprint"] != record["observation"]["fingerprint"]:
            raise PackagePlanStaleError("package namespace changed after the dry-run plan")
        if current["classification"] not in ACTIONABLE:
            error = PackageOwnershipError("package target is not proved owned")
            error.code = self._ownership_error_code(current["classification"])
            raise error
        target_path = current["resolved_target_path"]
        target = self._resolver(target_path)
        if target is None:
            raise PackagePlanStaleError("package target disappeared after revalidation")
        return target_path, target

    @staticmethod
    def _ownership_error_code(classification):
        if classification == "duplicate_owned":
            return "ambiguous_package_owner"
        return "foreign_package_target"

    def clear(self):
        with self._lock:
            self._plans.clear()
            self._dedupe.clear()
            self._sequence = 0

    def _validate_expected(
        self,
        project_path,
        package_id,
        source_url,
        recorded_ref,
        scope,
        intent,
        recorded_target_path,
    ):
        project_path = _path(project_path, "project_path")
        package_id = _bounded_text(package_id, "package_id", MAX_PACKAGE_ID_LENGTH)
        recorded_ref = _bounded_text(recorded_ref, "recorded_ref", MAX_REF_LENGTH)
        if scope not in SCOPES:
            raise PackageNamespaceValidationError("scope must be user or project")
        if intent not in INTENTS:
            raise PackageNamespaceValidationError("intent must be prune or replace")
        namespace_path = project_path.rstrip("/") + "/tdmcp_packages"
        target = None
        if recorded_target_path is not None:
            target = _path(recorded_target_path, "recorded_target_path")
            prefix = namespace_path.rstrip("/") + "/"
            if not target.startswith(prefix) or "/" in target[len(prefix) :]:
                raise PackageNamespaceValidationError(
                    "recorded_target_path must be a direct child of the package namespace"
                )
        return {
            "project_path": project_path,
            "namespace_path": namespace_path,
            "package_id": package_id,
            "source_hash": _source_hash(source_url),
            "recorded_ref": recorded_ref,
            "recorded_target_path": target,
            "scope": scope,
            "intent": intent,
        }

    def _observe(self, expected):
        namespace = self._resolver(expected["namespace_path"])
        if namespace is None:
            raise PackageNamespaceNotFoundError("package namespace not found")
        expected_path = expected["recorded_target_path"]
        summaries, matches, exact = _scan_candidates(namespace, expected)
        classification, resolved, marker, warnings = _classify_candidates(
            matches, exact, expected_path
        )

        observation_core = {
            "classification": classification,
            "resolved": resolved,
            "marker": marker,
            "candidates": summaries,
        }
        return {
            "classification": classification,
            "resolved_target_path": None if resolved is None else resolved["path"],
            "resolved_identity": resolved,
            "marker": marker,
            "candidates": summaries,
            "warnings": warnings[:MAX_WARNINGS],
            "fingerprint": _canonical_digest(observation_core),
        }

    @staticmethod
    def _validate_apply(choice, confirmation_policy, interaction_id):
        if choice not in ("Bypass", "Delete"):
            raise PackageNamespaceValidationError("choice must be Bypass or Delete")
        if confirmation_policy not in ("explicit_mode", "native", "yolo"):
            raise PackageNamespaceValidationError("unsupported confirmation_policy")
        if choice == "Bypass":
            PackageNamespaceService._validate_bypass(confirmation_policy, interaction_id)
            return

        PackageNamespaceService._validate_delete(confirmation_policy, interaction_id)

    @staticmethod
    def _validate_bypass(confirmation_policy, interaction_id):
        if confirmation_policy != "explicit_mode" or interaction_id is not None:
            raise PackageNamespaceValidationError(
                "explicit Bypass requires explicit_mode and no interaction_id"
            )

    @staticmethod
    def _validate_delete(confirmation_policy, interaction_id):
        if confirmation_policy == "native" and not interaction_id:
            error = PackageInteractionError("native Delete requires interaction_id")
            error.code = "interaction_required"
            raise error
        if confirmation_policy == "yolo" and interaction_id is not None:
            raise PackageNamespaceValidationError("YOLO Delete must not include interaction_id")
        if confirmation_policy == "explicit_mode":
            raise PackageNamespaceValidationError("explicit_mode cannot authorize Delete")

    def _decision(self, target, choice, confirmation_policy, interaction_id):
        if choice == "Bypass":
            return "Bypass"
        if confirmation_policy == "yolo":
            return "Delete"
        if self._fingerprint_target is None or self._consume_interaction is None:
            raise PackageInteractionError("interaction broker is unavailable")
        identity = _node_identity(target)
        fingerprint = self._fingerprint_target(
            identity["path"], identity["type"] or "operator", identity["name"]
        )
        consumed = self._consume_interaction(interaction_id, fingerprint)
        if not consumed.get("accepted"):
            raise PackageInteractionError("interaction was not accepted for this package target")
        decision = consumed.get("decision") or "Keep"
        if decision not in ("Delete", "Bypass", "Keep"):
            return "Keep"
        return decision

    def _mutate(
        self,
        record,
        target,
        target_path,
        decision,
        confirmation_policy,
        interaction_id,
    ):
        if decision == "Keep":
            return self._terminal_response(
                record,
                "kept",
                decision,
                "keep",
                target_path,
                confirmation_policy,
                interaction_id,
            )
        if decision == "Bypass":
            try:
                target.bypass = True
                bypassed = bool(target.bypass)
            except Exception as exc:  # noqa: BLE001
                raise PackageStateReadbackError("could not confirm package bypass") from exc
            if not bypassed:
                raise PackageStateReadbackError("package bypass readback was false")
            return self._terminal_response(
                record,
                "applied",
                decision,
                "bypass",
                target_path,
                confirmation_policy,
                interaction_id,
            )
        if self._delete_node is None:
            raise PackageStateReadbackError("package delete service is unavailable")
        result = self._delete_node(
            target_path,
            mode="delete",
            decision="Delete",
            confirmation_policy=confirmation_policy,
            request_id=interaction_id,
        )
        if not result.get("applied") or self._resolver(target_path) is not None:
            raise PackageStateReadbackError("package target deletion was not confirmed")
        return self._terminal_response(
            record,
            "applied",
            "Delete",
            "delete",
            None,
            confirmation_policy,
            interaction_id,
        )

    @staticmethod
    def _terminal_response(
        record,
        status,
        decision,
        action,
        final_path,
        confirmation_policy,
        interaction_id,
    ):
        observation = record["observation"]
        return {
            "status": status,
            "plan_id": record["plan_id"],
            "package_id": record["expected"]["package_id"],
            "classification": observation["classification"],
            "resolved_target_path": observation["resolved_target_path"],
            "decision": decision,
            "action_applied": action,
            "final_path": final_path,
            "confirmation_policy": confirmation_policy,
            "request_id": interaction_id,
            "marker": dict(observation["marker"]),
            "warnings": list(observation["warnings"]),
        }

    def _replay_terminal(self, record):
        terminal = record["terminal"]
        target_path = terminal["resolved_target_path"]
        target = self._resolver(target_path) if target_path else None
        action = terminal["action_applied"]
        state_valid = self._terminal_state_valid(action, target)
        observation_valid = self._terminal_observation_valid(record, action)
        if not state_valid or not observation_valid:
            raise PackagePostApplyStateChangedError(
                "package target changed after reconciliation"
            )
        replay = dict(terminal)
        replay["status"] = "replayed"
        return replay

    @staticmethod
    def _terminal_state_valid(action, target):
        if action == "delete":
            return target is None
        if action == "keep":
            return target is not None
        try:
            return action == "bypass" and target is not None and bool(target.bypass)
        except Exception:  # noqa: BLE001
            return False

    def _terminal_observation_valid(self, record, action):
        if action == "delete":
            return True
        try:
            current = self._observe(record["expected"])
        except PackageNamespaceError:
            return False
        return current["fingerprint"] == record["observation"]["fingerprint"]

    def _public_plan(self, record, deduplicated):
        observation = record["observation"]
        return {
            "status": "planned",
            "plan_id": record["plan_id"],
            "expires_at": record["expires_at"],
            "package_id": record["expected"]["package_id"],
            "scope": record["expected"]["scope"],
            "intent": record["expected"]["intent"],
            "classification": observation["classification"],
            "actionable": observation["classification"] in ACTIONABLE,
            "resolved_target_path": observation["resolved_target_path"],
            "marker": dict(observation["marker"]),
            "candidates": list(observation["candidates"]),
            "warnings": list(observation["warnings"]),
            "deduplicated": bool(deduplicated),
        }

    def _prune(self, now):
        for record in list(self._plans.values()):
            if record["terminal"] is None and now >= record["expires_at"]:
                self._remove_plan(record)

    def _make_room(self):
        while len(self._plans) >= self._plan_cap:
            terminal = [record for record in self._plans.values() if record["terminal"] is not None]
            if not terminal:
                raise PackageNamespaceCapacityError("package reconciliation plan limit reached")
            terminal.sort(key=lambda item: item["sequence"])
            self._remove_plan(terminal[0])

    def _remove_plan(self, record):
        self._plans.pop(record["plan_id"], None)
        if self._dedupe.get(record["request_digest"]) == record["plan_id"]:
            self._dedupe.pop(record["request_digest"], None)

    def _new_plan_id(self):
        for _attempt in range(8):
            plan_id = self._id_factory()
            if (
                isinstance(plan_id, str)
                and 16 <= len(plan_id) <= 128
                and all(ch.isalnum() or ch in "-_" for ch in plan_id)
                and plan_id not in self._plans
            ):
                return plan_id
        raise PackageNamespaceCapacityError("could not allocate an opaque plan id")


_DEFAULT_SERVICE = None


def _td_resolver(path):
    import td

    return td.op(path)


def _default_service():
    global _DEFAULT_SERVICE
    if _DEFAULT_SERVICE is None:
        from mcp.services import api_service, interaction_service

        _DEFAULT_SERVICE = PackageNamespaceService(
            _td_resolver,
            fingerprint_target=interaction_service.fingerprint_target,
            consume_interaction=interaction_service.consume_interaction,
            delete_node=api_service.delete_node,
        )
    return _DEFAULT_SERVICE


def check_package_namespace(**kwargs):
    """Create/deduplicate a bounded dry-run plan without mutating TD."""
    return _default_service().check(**kwargs)


def apply_package_namespace(**kwargs):
    """Revalidate and apply one Bypass/Delete action exactly once."""
    return _default_service().apply(**kwargs)


def clear_package_namespace_plans():
    """Clear in-memory plans during bridge teardown and focused tests."""
    if _DEFAULT_SERVICE is not None:
        _DEFAULT_SERVICE.clear()


def package_namespace_undo_label(plan_id):
    """Return a bounded label for an existing plan without exposing plan data."""
    plan_id = _bounded_text(plan_id, "plan_id", 128)
    service = _default_service()
    with service._lock:
        record = service._plans.get(plan_id)
        if record is None:
            return "MCP reconcile_package_namespace"
        package_id = record["expected"]["package_id"]
        return "MCP reconcile_package_namespace %s" % package_id
