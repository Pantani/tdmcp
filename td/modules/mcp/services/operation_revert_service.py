"""Unregistered exact-CAS compensation core for structured TD operations.

This module has no route, broker or TouchDesigner import.  The authenticated
runtime injects the same private record store, HMAC key, bridge instance and
non-queued mutation gate used by commit.  Public callers never receive the
private journal passed to the live adapter.
"""

import copy
import hashlib
import hmac
import secrets

from .operation_plan_service import (
    JournalReport,
    LiveTransactionAdapter,
    OperationMutationGate,
    OperationPlanError,
    OperationRecordStore,
    RECEIPT_CAPABILITY_BYTES,
    RevertTransactionOutcome,
    RollbackReport,
    _IDEMPOTENCY_RE,
    _LIVE_TRANSACTION_CAPABILITY,
    _PUBLIC_ERROR_CODES,
    _PUBLIC_ERROR_MESSAGES,
    _RECEIPT_CAPABILITY_RE,
    _canonical_json,
    _fail,
    _strict_fields,
    operation_authority_binding,
)


SCHEMA_VERSION = 1
MAX_REVERT_BODY_BYTES = 8 * 1024


class OperationRevertService:
    """Receipt-authorized, idempotent compensating transaction coordinator."""

    def __init__(
        self,
        transaction_adapter,
        record_store,
        mutation_gate,
        secret,
        bridge_instance_id,
    ):
        if (
            not isinstance(transaction_adapter, LiveTransactionAdapter)
            or getattr(transaction_adapter, "capability", None)
            is not _LIVE_TRANSACTION_CAPABILITY
        ):
            _fail("unverified_live_boundary", "live compensation adapter is unavailable")
        if not isinstance(record_store, OperationRecordStore):
            _fail("invalid_operation_plan", "operation record store is invalid")
        if not isinstance(mutation_gate, OperationMutationGate):
            _fail("invalid_operation_plan", "operation mutation gate is invalid")
        self._adapter = transaction_adapter
        self._records = record_store
        self._gate = mutation_gate
        self._secret = bytes(secret)
        if len(self._secret) < 32:
            _fail("invalid_operation_plan", "operation HMAC key is invalid")
        self.bridge_instance_id = bridge_instance_id
        if (
            type(bridge_instance_id) is not str
            or not _IDEMPOTENCY_RE.fullmatch(bridge_instance_id)
        ):
            _fail("invalid_operation_plan", "bridge instance id is invalid")

    @staticmethod
    def _validate_request(payload):
        if len(_canonical_json(payload)) > MAX_REVERT_BODY_BYTES:
            _fail("operation_capacity", "operation revert exceeds 8 KiB")
        payload = _strict_fields(
            payload,
            "operation revert",
            (
                "schema_version",
                "operation_id",
                "receipt_capability",
                "idempotency_key",
            ),
        )
        if payload["schema_version"] != SCHEMA_VERSION:
            _fail("invalid_operation_plan", "operation revert schema is unsupported")
        operation_id = payload["operation_id"]
        if type(operation_id) is not str or not _IDEMPOTENCY_RE.fullmatch(operation_id):
            _fail("invalid_operation_plan", "operation identity is invalid")
        capability = payload["receipt_capability"]
        if (
            type(capability) is not str
            or not _RECEIPT_CAPABILITY_RE.fullmatch(capability)
        ):
            _fail("receipt_unavailable", "structured operation receipt is unavailable")
        key = payload["idempotency_key"]
        if type(key) is not str or not _IDEMPOTENCY_RE.fullmatch(key):
            _fail("invalid_operation_plan", "idempotency_key is invalid")
        return operation_id, capability, key

    def _authority_binding(self, principal):
        return operation_authority_binding(
            self._secret,
            self.bridge_instance_id,
            principal,
        )

    def _bindings(self, operation_id, capability, key, authority_binding):
        dedupe_id = hmac.new(
            self._secret,
            _canonical_json(
                {
                    "domain": "operation-revert-dedupe-v1",
                    "key": key,
                    "authority": authority_binding,
                    "instance": self.bridge_instance_id,
                }
            ),
            hashlib.sha256,
        ).hexdigest()
        fingerprint = hmac.new(
            self._secret,
            _canonical_json(
                {
                    "domain": "operation-revert-v1",
                    "key": key,
                    "source_operation_id": operation_id,
                    "source_capability": capability,
                    "authority": authority_binding,
                    "instance": self.bridge_instance_id,
                }
            ),
            hashlib.sha256,
        ).hexdigest()
        return dedupe_id, fingerprint

    def _authorized_source(self, operation_id, capability, authority_binding):
        record = self._records.lookup_private(
            operation_id,
            capability,
            authority_binding,
            self.bridge_instance_id,
        )
        if record is None:
            _fail("receipt_unavailable", "structured operation receipt is unavailable")
        receipt = record["receipt"]
        if receipt.get("status") != "applied" or record["superseded_by"] is not None:
            _fail("operation_not_applied", "structured operation is not applied")
        journal = record["private_journal"]
        try:
            journal = self._adapter.validate_journal_v2(journal)
        except Exception as exc:  # noqa: BLE001 - private corruption is one safe error.
            raise OperationPlanError(
                "receipt_unavailable",
                "structured operation receipt is unavailable",
            ) from exc
        if (
            journal.get("operation_id") != operation_id
            or journal.get("generation") != record["generation"]
            or journal.get("direction") != record["direction"]
            or journal.get("lineage") != record["lineage"]
        ):
            _fail("receipt_unavailable", "structured operation receipt is unavailable")
        return record, journal

    def revert(self, payload, principal):
        operation_id, capability, key = self._validate_request(payload)
        authority_binding = self._authority_binding(principal)
        dedupe_id, fingerprint = self._bindings(
            operation_id,
            capability,
            key,
            authority_binding,
        )
        replay = self._records.replay(
            dedupe_id,
            fingerprint,
            authority_binding,
            self.bridge_instance_id,
        )
        if replay is not None:
            return replay

        source_record, source_journal = self._authorized_source(
            operation_id,
            capability,
            authority_binding,
        )
        revert_operation_id = secrets.token_urlsafe(18)
        revert_capability = secrets.token_urlsafe(RECEIPT_CAPABILITY_BYTES)
        lineage = {
            "root_operation_id": source_record["lineage"]["root_operation_id"],
            "source_operation_id": operation_id,
        }
        raced_replay = self._records.begin(
            dedupe_id,
            fingerprint,
            revert_operation_id,
            revert_capability,
            authority_binding,
            self.bridge_instance_id,
            generation=source_record["generation"] + 1,
            direction="compensating_revert",
            lineage=lineage,
        )
        if raced_replay is not None:
            return raced_replay
        if not self._gate.acquire():
            self._records.abandon(dedupe_id, fingerprint)
            _fail("operation_busy", "another structured mutation is active")

        label = ("MCP revert %s · %s" % (operation_id[:8], revert_operation_id[:8]))[:128]
        try:
            if self._adapter.observe_journal(source_journal) not in ("applied", "redone"):
                self._records.abandon(dedupe_id, fingerprint)
                _fail("operation_drifted", "structured operation state drifted")
            try:
                outcome = self._adapter.execute_revert(
                    source_journal,
                    revert_operation_id,
                    label,
                )
                receipt, private_journal = self._receipt_from_outcome(
                    source_record,
                    outcome,
                    operation_id,
                    revert_operation_id,
                    revert_capability,
                    label,
                )
            except Exception:  # noqa: BLE001 - native failures never leak details.
                receipt = self._unknown_receipt(
                    source_record,
                    operation_id,
                    revert_operation_id,
                    revert_capability,
                )
                private_journal = None
            return self._records.complete(
                dedupe_id,
                fingerprint,
                receipt,
                private_journal=private_journal,
                supersedes_operation_id=operation_id
                if receipt["status"] == "reverted"
                else None,
            )
        finally:
            self._gate.release()

    def _receipt_from_outcome(
        self,
        source_record,
        outcome,
        source_operation_id,
        revert_operation_id,
        revert_capability,
        label,
    ):
        if not isinstance(outcome, RevertTransactionOutcome):
            return (
                self._unknown_receipt(
                    source_record,
                    source_operation_id,
                    revert_operation_id,
                    revert_capability,
                ),
                None,
            )
        self._validate_outcome_identity(
            outcome,
            source_operation_id,
            revert_operation_id,
        )
        private_journal = self._validated_outcome_journal(
            source_record,
            outcome,
            source_operation_id,
            revert_operation_id,
            label,
        )
        receipt = self._outcome_receipt(
            source_record,
            outcome,
            source_operation_id,
            revert_operation_id,
            revert_capability,
        )
        self._attach_outcome_error(receipt, outcome)
        return receipt, private_journal

    @staticmethod
    def _validate_outcome_identity(
        outcome,
        source_operation_id,
        revert_operation_id,
    ):
        if (
            outcome.status
            not in (
                "reverted",
                "failed_rolled_back",
                "failed_rollback",
                "outcome_unknown",
            )
            or outcome.source_operation_id != source_operation_id
            or outcome.revert_operation_id != revert_operation_id
        ):
            _fail("outcome_unknown", "compensation outcome identity is invalid")

    def _validated_outcome_journal(
        self,
        source_record,
        outcome,
        source_operation_id,
        revert_operation_id,
        label,
    ):
        if outcome.status == "reverted":
            private_journal = self._adapter.validate_journal_v2(outcome.private_journal)
            if not self._is_reverted_outcome(
                outcome,
                private_journal,
                source_record,
                source_operation_id,
                revert_operation_id,
                label,
            ):
                _fail("outcome_unknown", "compensation safety claims are inconsistent")
            return private_journal
        if not self._is_failed_outcome(outcome):
            _fail("outcome_unknown", "failed compensation claims are inconsistent")
        return None

    def _outcome_receipt(
        self,
        source_record,
        outcome,
        source_operation_id,
        revert_operation_id,
        revert_capability,
    ):
        return {
            "status": outcome.status,
            "original_operation_id": source_operation_id,
            "revert_operation_id": revert_operation_id,
            "receipt_capability": revert_capability,
            "bridge_instance_id": self.bridge_instance_id,
            "plan_digest": source_record["receipt"]["plan_digest"],
            "owner_path": source_record["receipt"]["owner_path"],
            "affected_paths": copy.deepcopy(source_record["receipt"]["affected_paths"]),
            "decision": "Revert",
            "verification": {
                "status": outcome.verification_status
                if outcome.verification_status in ("PASS", "FAIL")
                else "FAIL",
                "snapshot": outcome.verification_snapshot
                if outcome.verification_snapshot in ("before", "after", "unknown")
                else "unknown",
            },
            "rollback": outcome.rollback.public(),
            "journal": outcome.journal.public(),
            "warnings": ["Compensation adapter reported a bounded warning."]
            if outcome.warnings
            else [],
        }

    @staticmethod
    def _attach_outcome_error(receipt, outcome):
        if outcome.status != "reverted":
            code = outcome.error_code if type(outcome.error_code) is str else "revert_failed"
            receipt["error"] = {
                "code": code
                if code in _PUBLIC_ERROR_MESSAGES
                else "revert_failed",
                "message": _PUBLIC_ERROR_MESSAGES.get(
                    code,
                    "Structured operation compensation failed safely.",
                ),
            }

    @staticmethod
    def _is_reverted_outcome(
        outcome,
        journal,
        source_record,
        source_operation_id,
        revert_operation_id,
        label,
    ):
        return (
            outcome.verification_status == "PASS"
            and outcome.verification_snapshot == "before"
            and isinstance(outcome.rollback, RollbackReport)
            and outcome.rollback.attempted is False
            and outcome.rollback.succeeded is True
            and not outcome.rollback.errors
            and isinstance(outcome.journal, JournalReport)
            and outcome.journal.registered is True
            and outcome.journal.operation_id == revert_operation_id
            and outcome.journal.label == label
            and outcome.journal.native_stack_delta == 1
            and outcome.journal.observed_state == "applied"
            and outcome.error_code is None
            and journal["operation_id"] == revert_operation_id
            and journal["generation"] == source_record["generation"] + 1
            and journal["direction"] == "compensating_revert"
            and journal["lineage"]
            == {
                "root_operation_id": source_record["lineage"]["root_operation_id"],
                "source_operation_id": source_operation_id,
            }
        )

    @staticmethod
    def _journal_is_clear(journal):
        return (
            isinstance(journal, JournalReport)
            and journal.registered is False
            and journal.operation_id is None
            and journal.label is None
            and journal.native_stack_delta == 0
            and journal.observed_state == "unknown"
        )

    @staticmethod
    def _is_failed_outcome(outcome):
        if (
            outcome.private_journal is not None
            or not isinstance(outcome.rollback, RollbackReport)
            or not OperationRevertService._journal_is_clear(outcome.journal)
            or outcome.error_code not in _PUBLIC_ERROR_CODES
            or type(outcome.warnings) not in (list, tuple)
            or len(outcome.warnings) > 16
        ):
            return False
        if outcome.status == "failed_rolled_back":
            proven_after = (
                outcome.verification_status == "PASS"
                and outcome.verification_snapshot == "after"
                and outcome.rollback.succeeded is True
                and not outcome.rollback.errors
            )
            unverified_zero_write = (
                outcome.verification_status == "FAIL"
                and outcome.verification_snapshot == "unknown"
                and outcome.rollback.attempted is False
                and outcome.rollback.succeeded is True
                and not outcome.rollback.errors
            )
            return proven_after or unverified_zero_write
        if outcome.status == "failed_rollback":
            return (
                outcome.verification_status == "FAIL"
                and outcome.verification_snapshot == "unknown"
                and outcome.rollback.attempted is True
                and outcome.rollback.succeeded is False
            )
        return (
            outcome.status == "outcome_unknown"
            and outcome.verification_status == "FAIL"
            and outcome.verification_snapshot == "unknown"
            and outcome.rollback.succeeded is False
        )

    def _unknown_receipt(
        self,
        source_record,
        source_operation_id,
        revert_operation_id,
        revert_capability,
    ):
        source = source_record["receipt"]
        return {
            "status": "outcome_unknown",
            "original_operation_id": source_operation_id,
            "revert_operation_id": revert_operation_id,
            "receipt_capability": revert_capability,
            "bridge_instance_id": self.bridge_instance_id,
            "plan_digest": source["plan_digest"],
            "owner_path": source["owner_path"],
            "affected_paths": copy.deepcopy(source["affected_paths"]),
            "decision": "Revert",
            "verification": {"status": "FAIL", "snapshot": "unknown"},
            "rollback": RollbackReport(attempted=False, succeeded=False).public(),
            "journal": JournalReport().public(),
            "warnings": ["Native compensation outcome could not be established."],
            "error": {
                "code": "outcome_unknown",
                "message": _PUBLIC_ERROR_MESSAGES["outcome_unknown"],
            },
        }


__all__ = ("OperationRevertService",)
