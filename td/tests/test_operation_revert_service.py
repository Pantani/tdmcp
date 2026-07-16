import copy
import os
import sys
import unittest
from unittest import mock


_HERE = os.path.dirname(os.path.abspath(__file__))
_MODULES = os.path.abspath(os.path.join(_HERE, "..", "modules"))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
if _MODULES not in sys.path:
    sys.path.insert(0, _MODULES)

from mcp.services import operation_plan_service as plan_service  # noqa: E402
from mcp.services import operation_revert_service as revert_service  # noqa: E402
from mcp.services import operation_td_adapter as td_adapter  # noqa: E402
from test_operation_td_adapter import (  # noqa: E402
    FakeTD,
    operation_plan,
    single_created_node_plan,
)


PRINCIPAL = "oauth-client-operation-revert"
OTHER_PRINCIPAL = "oauth-client-operation-revert-other"
SECRET = b"operation-revert-test-secret-key-32-bytes"
INSTANCE = "bridge-instance-operation-revert"


class BoundAdapter(plan_service.ScalarSnapshotAdapter, plan_service.LiveTransactionAdapter):
    capability = plan_service._LIVE_TRANSACTION_CAPABILITY

    def __init__(self, td):
        self.td = td
        self.commit_calls = 0
        self.revert_calls = 0

    def capture(self, canonical_plan, affected_paths, requested_operator_types):
        return td_adapter.capture_scalar_snapshot(
            self.td,
            canonical_plan,
            affected_paths,
            requested_operator_types,
        )

    def execute(self, prepared, operation_id, label):
        self.commit_calls += 1
        return td_adapter.execute_td_transaction(
            self.td,
            prepared,
            operation_id,
            label,
        )

    def validate_journal_v2(self, journal):
        return td_adapter.validate_journal_v2(journal)

    def observe_journal(self, journal):
        return td_adapter.observe_journal(journal, self.td)

    def execute_revert(self, journal, revert_operation_id, label):
        self.revert_calls += 1
        return td_adapter.execute_revert_transaction(
            self.td,
            journal,
            revert_operation_id,
            label,
        )


class OperationRevertServiceTests(unittest.TestCase):
    def setUp(self):
        self._previous_td_module = sys.modules.get("td")
        td_adapter._JOURNALS.clear()
        self.td = FakeTD()
        self.adapter = BoundAdapter(self.td)
        self.records = plan_service.OperationRecordStore()
        self.gate = plan_service.OperationMutationGate()
        self.plan_service = plan_service.OperationPlanService(
            self.adapter,
            self.adapter,
            secret=SECRET,
            bridge_instance_id=INSTANCE,
            receipt_store=self.records,
            mutation_gate=self.gate,
        )
        self.revert_service = revert_service.OperationRevertService(
            self.adapter,
            self.records,
            self.gate,
            SECRET,
            INSTANCE,
        )

    def tearDown(self):
        td_adapter._JOURNALS.clear()
        if self._previous_td_module is None:
            sys.modules.pop("td", None)
        else:
            sys.modules["td"] = self._previous_td_module

    def _apply(self, plan=None, key="operation-commit-revert-0001"):
        plan = copy.deepcopy(plan or single_created_node_plan())
        preview = self.plan_service.preview(plan, PRINCIPAL)
        receipt = self.plan_service.commit(
            {
                **plan,
                "preview_token": preview["preview_token"],
                "idempotency_key": key,
            },
            PRINCIPAL,
        )
        self.assertEqual(receipt["status"], "applied")
        return receipt

    @staticmethod
    def _revert_payload(receipt, key="operation-revert-direct-0001"):
        return {
            "schema_version": 1,
            "operation_id": receipt["operation_id"],
            "receipt_capability": receipt["receipt_capability"],
            "idempotency_key": key,
        }

    def test_exact_revert_replay_lineage_and_native_compensation_cycles(self):
        source = self._apply()
        source_node = self.td.op("/project1/show/insert1")
        self.assertIsNotNone(source_node)
        self.assertEqual(len(self.td.ui.undo.undoStack), 1)
        payload = self._revert_payload(source)

        with mock.patch.object(
            self.td.ui.undo,
            "undo",
            side_effect=AssertionError("revert core must not call native Undo"),
        ), mock.patch.object(
            self.td.ui.undo,
            "redo",
            side_effect=AssertionError("revert core must not call native Redo"),
        ):
            reverted = self.revert_service.revert(payload, PRINCIPAL)

        self.assertEqual(reverted["status"], "reverted")
        self.assertEqual(reverted["original_operation_id"], source["operation_id"])
        self.assertIsNone(self.td.op("/project1/show/insert1"))
        self.assertEqual(len(self.td.ui.undo.undoStack), 2)
        self.assertEqual(self.adapter.revert_calls, 1)

        source_record = self.plan_service.get_private_operation_record(
            source["operation_id"],
            source["receipt_capability"],
            PRINCIPAL,
        )
        self.assertEqual(source_record["superseded_by"], reverted["revert_operation_id"])
        compensation = self.records.lookup_private(
            reverted["revert_operation_id"],
            reverted["receipt_capability"],
            self.plan_service._authority_binding(PRINCIPAL),
            INSTANCE,
        )
        self.assertEqual(compensation["generation"], 1)
        self.assertEqual(compensation["direction"], "compensating_revert")
        self.assertEqual(
            compensation["lineage"],
            {
                "root_operation_id": source["operation_id"],
                "source_operation_id": source["operation_id"],
            },
        )

        replay = self.revert_service.revert(payload, PRINCIPAL)
        self.assertEqual(replay["status"], "replayed")
        self.assertEqual(replay["revert_operation_id"], reverted["revert_operation_id"])
        self.assertEqual(replay["receipt_capability"], reverted["receipt_capability"])
        self.assertEqual(self.adapter.revert_calls, 1)
        self.assertEqual(len(self.td.ui.undo.undoStack), 2)

        sys.modules["td"] = self.td
        self.td.ui.undo.undo()
        recreated = self.td.op("/project1/show/insert1")
        self.assertIsNotNone(recreated)
        self.assertNotEqual(recreated.id, source_node.id)
        self.assertEqual(
            self.adapter.observe_journal(compensation["private_journal"]),
            "undone",
        )
        self.td.ui.undo.redo()
        self.assertIsNone(self.td.op("/project1/show/insert1"))
        self.assertEqual(
            self.adapter.observe_journal(compensation["private_journal"]),
            "redone",
        )

    def test_drift_wrong_authority_and_shared_gate_are_zero_write(self):
        source = self._apply()
        payload = self._revert_payload(source, "operation-revert-drift-0001")
        node = self.td.op("/project1/show/insert1")
        node.nodeX += 1

        with self.assertRaises(plan_service.OperationPlanError) as caught:
            self.revert_service.revert(payload, PRINCIPAL)
        self.assertEqual(caught.exception.code, "operation_drifted")
        self.assertIs(self.td.op("/project1/show/insert1"), node)
        self.assertEqual(len(self.td.ui.undo.undoStack), 1)
        self.assertEqual(self.adapter.revert_calls, 0)

        node.nodeX -= 1
        with self.assertRaises(plan_service.OperationPlanError) as caught:
            self.revert_service.revert(payload, OTHER_PRINCIPAL)
        self.assertEqual(caught.exception.code, "receipt_unavailable")
        self.assertTrue(self.gate.acquire())
        try:
            with self.assertRaises(plan_service.OperationPlanError) as caught:
                self.revert_service.revert(payload, PRINCIPAL)
            self.assertEqual(caught.exception.code, "operation_busy")
            self.assertIs(self.td.op("/project1/show/insert1"), node)
            self.assertEqual(len(self.td.ui.undo.undoStack), 1)
        finally:
            self.gate.release()

        reverted = self.revert_service.revert(payload, PRINCIPAL)
        self.assertEqual(reverted["status"], "reverted")
        self.assertIsNone(self.td.op("/project1/show/insert1"))

    def test_adapter_preflight_drift_and_capture_error_never_claim_pass(self):
        source = self._apply(key="operation-commit-preflight-claims-0001")
        source_record = self.plan_service.get_private_operation_record(
            source["operation_id"],
            source["receipt_capability"],
            PRINCIPAL,
        )
        journal = source_record["private_journal"]
        node = self.td.op("/project1/show/insert1")
        node.nodeX += 1
        drift = td_adapter.execute_revert_transaction(
            self.td,
            journal,
            "operation-revert-preflight-drift",
            "MCP revert preflight drift",
        )
        self.assertEqual(drift.error_code, "operation_drifted")
        self.assertEqual(drift.verification_status, "FAIL")
        self.assertEqual(drift.verification_snapshot, "unknown")
        self.assertEqual(len(self.td.ui.undo.undoStack), 1)

        node.nodeX -= 1
        with mock.patch.object(
            td_adapter,
            "_journal_snapshot",
            side_effect=td_adapter.OperationTdAdapterError("verification_failed"),
        ):
            unavailable = td_adapter.execute_revert_transaction(
                self.td,
                journal,
                "operation-revert-preflight-capture",
                "MCP revert preflight capture",
            )
        self.assertEqual(unavailable.verification_status, "FAIL")
        self.assertEqual(unavailable.verification_snapshot, "unknown")
        self.assertEqual(len(self.td.ui.undo.undoStack), 1)
        self.assertIs(self.td.op("/project1/show/insert1"), node)

    def test_incoherent_sensitive_failed_adapter_outcome_becomes_generic_unknown(self):
        source = self._apply(key="operation-commit-unsafe-revert-0001")
        sensitive = "private-project-value-must-not-escape"
        unsafe = plan_service.RevertTransactionOutcome(
            status="failed_rolled_back",
            source_operation_id=source["operation_id"],
            revert_operation_id="ignored-by-mock",
            verification_status="PASS",
            verification_snapshot="before",
            rollback=plan_service.RollbackReport(attempted=False, succeeded=False),
            journal=plan_service.JournalReport(),
            warnings=(sensitive,),
            error_code="not-a-public-code",
        )

        def unsafe_execute(_journal, revert_operation_id, _label):
            return plan_service.RevertTransactionOutcome(
                **{
                    **unsafe.__dict__,
                    "revert_operation_id": revert_operation_id,
                }
            )

        with mock.patch.object(
            self.adapter,
            "execute_revert",
            side_effect=unsafe_execute,
        ):
            receipt = self.revert_service.revert(
                self._revert_payload(source, "operation-revert-unsafe-0001"),
                PRINCIPAL,
            )

        self.assertEqual(receipt["status"], "outcome_unknown")
        self.assertNotIn(sensitive, repr(receipt))
        self.assertIsNotNone(self.td.op("/project1/show/insert1"))
        self.assertEqual(len(self.td.ui.undo.undoStack), 1)

    def test_partial_inverse_failure_rolls_forward_exactly_without_new_item(self):
        source = self._apply(
            operation_plan(),
            key="operation-commit-mixed-revert-0001",
        )
        source_record = self.plan_service.get_private_operation_record(
            source["operation_id"],
            source["receipt_capability"],
            PRINCIPAL,
        )
        expected_after = copy.deepcopy(
            source_record["private_journal"]["target_snapshot"]
        )
        original_restore = td_adapter._restore_action_before
        calls = {"count": 0}

        def fail_after_two_writes(td, action):
            calls["count"] += 1
            if calls["count"] == 3:
                raise td_adapter.OperationTdAdapterError("apply_failed")
            return original_restore(td, action)

        with mock.patch.object(
            td_adapter,
            "_restore_action_before",
            side_effect=fail_after_two_writes,
        ):
            failed = self.revert_service.revert(
                self._revert_payload(source, "operation-revert-partial-0001"),
                PRINCIPAL,
            )

        self.assertGreaterEqual(calls["count"], 3)
        self.assertEqual(failed["status"], "failed_rolled_back")
        self.assertEqual(failed["verification"], {"status": "PASS", "snapshot": "after"})
        self.assertTrue(failed["rollback"]["attempted"])
        self.assertTrue(failed["rollback"]["succeeded"])
        self.assertEqual(len(self.td.ui.undo.undoStack), 1)
        current = td_adapter._journal_snapshot(
            self.td,
            source_record["private_journal"],
        )
        self.assertTrue(
            td_adapter._snapshot_matches_with_refreshed_create_identity(
                expected_after,
                current,
            )
        )
        refreshed = self.plan_service.get_private_operation_record(
            source["operation_id"],
            source["receipt_capability"],
            PRINCIPAL,
        )
        self.assertIsNone(refreshed["superseded_by"])

    def test_global_state_restore_failure_rolls_forward_before_returning_failure(self):
        source = self._apply(key="operation-commit-global-restore-0001")
        source_record = self.plan_service.get_private_operation_record(
            source["operation_id"],
            source["receipt_capability"],
            PRINCIPAL,
        )
        expected_after = copy.deepcopy(
            source_record["private_journal"]["target_snapshot"]
        )
        original_restore = td_adapter._restore_global_state
        calls = {"count": 0}

        def fail_first_restore(undo, original):
            calls["count"] += 1
            if calls["count"] == 1:
                return False
            return original_restore(undo, original)

        with mock.patch.object(
            td_adapter,
            "_restore_global_state",
            side_effect=fail_first_restore,
        ):
            failed = self.revert_service.revert(
                self._revert_payload(source, "operation-revert-global-restore-0001"),
                PRINCIPAL,
            )

        self.assertGreaterEqual(calls["count"], 2)
        self.assertEqual(failed["status"], "failed_rolled_back")
        self.assertEqual(failed["verification"], {"status": "PASS", "snapshot": "after"})
        self.assertIsNotNone(self.td.op("/project1/show/insert1"))
        self.assertEqual(len(self.td.ui.undo.undoStack), 1)
        self.assertTrue(self.td.ui.undo.globalState)
        current = td_adapter._journal_snapshot(
            self.td,
            source_record["private_journal"],
        )
        self.assertTrue(
            td_adapter._snapshot_matches_with_refreshed_create_identity(
                expected_after,
                current,
            )
        )

    def test_post_inverse_snapshot_exception_restores_after_with_zero_item(self):
        source = self._apply(key="operation-commit-post-inverse-snapshot-0001")
        source_record = self.plan_service.get_private_operation_record(
            source["operation_id"],
            source["receipt_capability"],
            PRINCIPAL,
        )
        expected_after = copy.deepcopy(
            source_record["private_journal"]["target_snapshot"]
        )
        original_snapshot = td_adapter._journal_snapshot
        calls = {"count": 0}

        def fail_post_inverse(td, journal):
            calls["count"] += 1
            if calls["count"] == 3:
                raise td_adapter.OperationTdAdapterError("verification_failed")
            return original_snapshot(td, journal)

        with mock.patch.object(
            td_adapter,
            "_journal_snapshot",
            side_effect=fail_post_inverse,
        ):
            failed = self.revert_service.revert(
                self._revert_payload(
                    source,
                    "operation-revert-post-inverse-snapshot-0001",
                ),
                PRINCIPAL,
            )

        self.assertGreaterEqual(calls["count"], 4)
        self.assertEqual(failed["status"], "failed_rolled_back")
        self.assertEqual(failed["verification"], {"status": "PASS", "snapshot": "after"})
        self.assertEqual(len(self.td.ui.undo.undoStack), 1)
        self.assertTrue(self.td.ui.undo.globalState)
        current = original_snapshot(self.td, source_record["private_journal"])
        self.assertTrue(
            td_adapter._snapshot_matches_with_refreshed_create_identity(
                expected_after,
                current,
            )
        )

    def test_pre_callback_stack_read_failure_restores_after_with_zero_item(self):
        source = self._apply(key="operation-commit-stack-read-failure-0001")
        source_record = self.plan_service.get_private_operation_record(
            source["operation_id"],
            source["receipt_capability"],
            PRINCIPAL,
        )
        expected_after = copy.deepcopy(
            source_record["private_journal"]["target_snapshot"]
        )
        with mock.patch.object(
            td_adapter,
            "_stack_labels",
            side_effect=td_adapter.OperationTdAdapterError("undo_unavailable"),
        ):
            failed = self.revert_service.revert(
                self._revert_payload(source, "operation-revert-stack-read-0001"),
                PRINCIPAL,
            )

        self.assertEqual(failed["status"], "failed_rolled_back")
        self.assertEqual(failed["verification"], {"status": "PASS", "snapshot": "after"})
        self.assertEqual(len(self.td.ui.undo.undoStack), 1)
        self.assertTrue(self.td.ui.undo.globalState)
        current = td_adapter._journal_snapshot(
            self.td,
            source_record["private_journal"],
        )
        self.assertTrue(
            td_adapter._snapshot_matches_with_refreshed_create_identity(
                expected_after,
                current,
            )
        )

    def test_capacity_and_absolute_ttl_refuse_before_mutation(self):
        now = [0.0]
        records = plan_service.OperationRecordStore(
            clock=lambda: now[0],
            ttl_seconds=31,
            capacity=1,
        )
        gate = plan_service.OperationMutationGate()
        plan_instance = plan_service.OperationPlanService(
            self.adapter,
            self.adapter,
            secret=SECRET,
            bridge_instance_id=INSTANCE,
            receipt_store=records,
            mutation_gate=gate,
        )
        reverter = revert_service.OperationRevertService(
            self.adapter,
            records,
            gate,
            SECRET,
            INSTANCE,
        )
        plan = single_created_node_plan()
        preview = plan_instance.preview(plan, PRINCIPAL)
        source = plan_instance.commit(
            {
                **plan,
                "preview_token": preview["preview_token"],
                "idempotency_key": "operation-capacity-commit-0001",
            },
            PRINCIPAL,
        )
        with self.assertRaises(plan_service.OperationPlanError) as caught:
            reverter.revert(
                self._revert_payload(source, "operation-capacity-revert-0001"),
                PRINCIPAL,
            )
        self.assertEqual(caught.exception.code, "operation_capacity")
        self.assertIsNotNone(self.td.op("/project1/show/insert1"))
        self.assertEqual(len(self.td.ui.undo.undoStack), 1)

        now[0] = 32.0
        with self.assertRaises(plan_service.OperationPlanError) as caught:
            reverter.revert(
                self._revert_payload(source, "operation-expired-revert-0001"),
                PRINCIPAL,
            )
        self.assertEqual(caught.exception.code, "receipt_unavailable")
        self.assertIsNotNone(self.td.op("/project1/show/insert1"))

    def test_active_compensation_reservation_pins_source_absolute_ttl(self):
        now = [0.0]
        records = plan_service.OperationRecordStore(
            clock=lambda: now[0],
            ttl_seconds=31,
            capacity=2,
        )
        authority = "a" * 64
        instance = "bridge-instance-pin-test"
        source_id = "operation-source-pin-test"
        source_capability = "s" * 43
        records.begin(
            "b" * 64,
            "c" * 64,
            source_id,
            source_capability,
            authority,
            instance,
        )
        records.complete(
            "b" * 64,
            "c" * 64,
            {
                "status": "applied",
                "operation_id": source_id,
                "receipt_capability": source_capability,
            },
            private_journal={"schema_version": 2},
        )
        revert_id = "operation-revert-pin-test"
        records.begin(
            "d" * 64,
            "e" * 64,
            revert_id,
            "r" * 43,
            authority,
            instance,
            generation=1,
            direction="compensating_revert",
            lineage={
                "root_operation_id": source_id,
                "source_operation_id": source_id,
            },
        )

        now[0] = 32.0
        self.assertIsNotNone(
            records.lookup_private(
                source_id,
                source_capability,
                authority,
                instance,
            )
        )
        records.abandon("d" * 64, "e" * 64)
        self.assertIsNone(
            records.lookup_private(
                source_id,
                source_capability,
                authority,
                instance,
            )
        )


if __name__ == "__main__":
    unittest.main()
