import copy
import json
import os
import sys
import unittest


_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
_MODULES = os.path.join(_ROOT, "td", "modules")
_CORPUS_PATH = os.path.join(
    _ROOT,
    "tests",
    "fixtures",
    "operation-plan-golden.json",
)
if _MODULES not in sys.path:
    sys.path.insert(0, _MODULES)

from mcp.services import operation_plan_service as service  # noqa: E402


_RECEIPT_FRAGMENT_FIELDS = (
    "status",
    "results",
    "verification",
    "rollback",
    "journal",
    "warnings",
    "error",
)
_PRIMARY_TERMINAL_STATES = {
    "applied",
    "failed_rolled_back",
    "failed_rollback",
    "outcome_unknown",
}
_COMMON_TERMINAL_STATES = _PRIMARY_TERMINAL_STATES | {"replayed"}


def _load_corpus():
    with open(_CORPUS_PATH, encoding="utf-8") as handle:
        return json.load(handle)


def _prepared(plan_case):
    canonical = service.canonicalize_operation_plan(plan_case["plan"])
    aliases, effects, affected, counts = service._summarize_plan(canonical)
    return service.PreparedOperation(
        canonical_plan=canonical,
        plan_digest=plan_case["plan_digest"],
        private_fingerprint="0" * 64,
        snapshot={},
        aliases=aliases,
        effects=tuple(effects),
        affected_paths=tuple(affected),
        counts=counts,
    )


def _rollback_report(fragment):
    raw = fragment["rollback"]
    errors = tuple(
        service.RollbackError(
            index=error["index"],
            code=error["code"],
            message=error["message"],
        )
        for error in raw["errors"]
    )
    return service.RollbackReport(
        attempted=raw["attempted"],
        succeeded=raw["succeeded"],
        errors=errors,
    )


def _journal_report(fragment):
    raw = fragment["journal"]
    return service.JournalReport(
        registered=raw["registered"],
        operation_id=raw["operation_id"],
        label=raw["label"],
        native_stack_delta=raw["native_stack_delta"],
        observed_state=raw["observed_state"],
    )


def _outcome(fragment, operation_id, status=None):
    error = fragment.get("error")
    outcome_status = status or fragment["status"]
    return service.TransactionOutcome(
        status=outcome_status,
        operation_id=operation_id,
        results=tuple(copy.deepcopy(fragment["results"])),
        verification_status=fragment["verification"]["status"],
        verification_snapshot=fragment["verification"]["snapshot"],
        rollback=_rollback_report(fragment),
        journal=_journal_report(fragment),
        warnings=tuple(fragment["warnings"]),
        error_code=error["code"] if error is not None else None,
        error_message=error["message"] if error is not None else None,
        private_journal={"schema_version": 2}
        if outcome_status == "applied"
        else None,
    )


def _receipt_fragment(receipt):
    return {
        field: copy.deepcopy(receipt[field])
        for field in _RECEIPT_FRAGMENT_FIELDS
        if field in receipt
    }


def _accepted_receipt(producer, prepared, operation_id, label, fragment):
    status = fragment["status"]
    if status == "outcome_unknown":
        return producer._unknown_receipt(prepared, operation_id, "c" * 43)
    outcome_status = "applied" if status == "replayed" else status
    receipt = producer._receipt_from_outcome(
        prepared,
        _outcome(fragment, operation_id, outcome_status),
        operation_id,
        label,
        "c" * 43,
    )
    if status == "replayed":
        return service.TerminalReceiptStore._public_replay({"receipt": receipt})
    return receipt


class OperationPlanGoldenTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.corpus = _load_corpus()
        cls.plan_cases = {
            case["id"]: case for case in cls.corpus["plan_cases"]
        }

    def test_plan_accept_reject_error_class_canonical_digest_and_summary(self):
        self.assertEqual(self.corpus["schema_version"], 1)
        for case in self.corpus["plan_cases"]:
            with self.subTest(case=case["id"]):
                if not case["accept"]:
                    with self.assertRaises(service.OperationPlanError) as caught:
                        service.canonicalize_operation_plan(case["plan"])
                    self.assertEqual(type(caught.exception).__name__, case["error"]["class"])
                    self.assertEqual(caught.exception.code, case["error"]["code"])
                    continue

                canonical = service.canonicalize_operation_plan(case["plan"])
                self.assertEqual(
                    service._canonical_json(canonical).hex(),
                    case["canonical_utf8_hex"],
                )
                self.assertEqual(
                    service._sha256(service._shape_plan(canonical)),
                    case["plan_digest"],
                )
                _, _, affected, counts = service._summarize_plan(canonical)
                self.assertEqual(affected, case["affected_paths"])
                self.assertEqual(counts, case["counts"])

    def test_public_error_code_intersection(self):
        for case in self.corpus["public_error_cases"]:
            with self.subTest(code=case["code"]):
                self.assertEqual(case["code"] in service._PUBLIC_ERROR_CODES, case["accept"])
                if case["accept"]:
                    error = service.OperationPlanError(case["code"], "Bounded public error.")
                    self.assertEqual(error.code, case["code"])
                    self.assertLessEqual(len(str(error).encode("utf-8")), 256)

    def test_common_terminal_receipt_safety_states(self):
        plan_case = self.plan_cases[self.corpus["receipt_plan_case_id"]]
        prepared = _prepared(plan_case)
        context = self.corpus["receipt_context"]
        operation_id = context["operation_id"]
        label = context["journal_label"]
        producer = service.OperationPlanService(
            service.ScalarSnapshotAdapter(),
            secret=b"g" * 32,
            bridge_instance_id="bridge-instance-golden",
        )

        for case in self.corpus["terminal_receipt_cases"]:
            with self.subTest(case=case["id"]):
                fragment = case["fragment"]
                status = fragment["status"]
                if not case["accept"]:
                    self._assert_receipt_rejected(
                        producer,
                        prepared,
                        operation_id,
                        label,
                        fragment,
                    )
                    continue
                self.assertIn(status, _COMMON_TERMINAL_STATES)
                receipt = _accepted_receipt(
                    producer, prepared, operation_id, label, fragment
                )
                self.assertEqual(_receipt_fragment(receipt), fragment)
                self.assertEqual(receipt["receipt_capability"], "c" * 43)
                self.assertNotIn("idempotency_key", receipt)
                self.assertEqual(receipt["operation_id"], operation_id)
                self.assertEqual(receipt["bridge_instance_id"], "bridge-instance-golden")

    def _assert_receipt_rejected(
        self,
        producer,
        prepared,
        operation_id,
        label,
        fragment,
    ):
        status = fragment["status"]
        if status not in _COMMON_TERMINAL_STATES:
            self.assertNotIn(status, _COMMON_TERMINAL_STATES)
            return
        with self.assertRaises(service.OperationPlanError):
            producer._receipt_from_outcome(
                prepared,
                _outcome(fragment, operation_id),
                operation_id,
                label,
                "c" * 43,
            )


if __name__ == "__main__":
    unittest.main()
