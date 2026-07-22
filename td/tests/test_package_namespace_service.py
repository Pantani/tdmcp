"""Offline tests for bounded package namespace check/apply reconciliation."""

import hashlib
import json
import os
import sys
import unittest


_HERE = os.path.dirname(os.path.abspath(__file__))
_MODULES = os.path.abspath(os.path.join(_HERE, "..", "modules"))
if _MODULES not in sys.path:
    sys.path.insert(0, _MODULES)

from mcp.services import package_namespace_service as svc  # noqa: E402


SOURCE = "https://github.com/example/package"


class Clock:
    def __init__(self, value=100.0):
        self.value = value

    def __call__(self):
        return self.value

    def advance(self, seconds):
        self.value += seconds


class Node:
    def __init__(self, path, type_name="baseCOMP", text=None):
        self.path = path
        self.name = path.rsplit("/", 1)[-1]
        self.type = type_name
        self.text = text
        self.children = []
        self.bypass = False

    def op(self, name):
        for child in self.children:
            if child.name == name:
                return child
        return None


class Fixture:
    def __init__(self, plan_cap=svc.MAX_PLANS):
        self.clock = Clock()
        self.nodes = {}
        self.consumed = []
        self.next_decision = {"accepted": True, "decision": "Delete"}
        self.deleted = []
        self.service = svc.PackageNamespaceService(
            self.resolve,
            clock=self.clock,
            id_factory=self._id,
            plan_cap=plan_cap,
            fingerprint_target=self.fingerprint,
            consume_interaction=self.consume,
            delete_node=self.delete,
        )
        self.ids = 0
        self.project = self.add(Node("/project1"))
        self.namespace = self.add(Node("/project1/tdmcp_packages"))

    def _id(self):
        self.ids += 1
        return "plan_%024d" % self.ids

    def add(self, node):
        self.nodes[node.path] = node
        return node

    def package(self, name="package_a", marker=None):
        node = self.add(Node("/project1/tdmcp_packages/%s" % name))
        self.namespace.children.append(node)
        if marker is not None:
            marker_node = self.add(
                Node(node.path + "/tdmcp_package_info", "textDAT", json.dumps(marker))
            )
            node.children.append(marker_node)
        return node

    def resolve(self, path):
        return self.nodes.get(path)

    @staticmethod
    def fingerprint(path, type_name, name):
        return hashlib.sha256("|".join((path, type_name, name)).encode()).hexdigest()

    def consume(self, request_id, fingerprint):
        self.consumed.append((request_id, fingerprint))
        return dict(self.next_decision)

    def delete(self, path, **kwargs):
        self.deleted.append((path, kwargs))
        node = self.nodes.pop(path, None)
        if node is not None:
            self.namespace.children.remove(node)
        return {"applied": node is not None}

    def check(self, **overrides):
        values = {
            "project_path": "/project1",
            "package_id": "package-a",
            "source_url": SOURCE,
            "recorded_ref": "v1.0.0",
            "recorded_target_path": "/project1/tdmcp_packages/package_a",
            "scope": "project",
            "intent": "prune",
        }
        values.update(overrides)
        return self.service.check(**values)


def marker_v1(package_id="package-a", source=SOURCE):
    return {"id": package_id, "source": source, "tox": "/private/path/package.tox"}


def marker_v2(package_id="package-a", source=SOURCE, ref="v1.0.0", scope="project"):
    return {
        "schema_version": 2,
        "package_id": package_id,
        "source_hash": hashlib.sha256(source.encode()).hexdigest(),
        "ref": ref,
        "scope": scope,
        "artifact_hash": "a" * 64,
    }


class ClassificationTests(unittest.TestCase):
    def test_aligned_v1_plan_is_actionable_and_sanitized(self):
        fixture = Fixture()
        fixture.package(marker=marker_v1())
        plan = fixture.check()
        self.assertEqual(plan["classification"], "aligned_owned")
        self.assertTrue(plan["actionable"])
        self.assertEqual(plan["marker"], {"matched": True, "schema_version": 1})
        rendered = repr(plan)
        self.assertNotIn(SOURCE, rendered)
        self.assertNotIn("/private/path", rendered)
        self.assertNotIn("tox", rendered)

    def test_v2_marker_requires_ref_scope_source_and_artifact_hash(self):
        fixture = Fixture()
        fixture.package(marker=marker_v2())
        self.assertEqual(fixture.check()["classification"], "aligned_owned")

        mismatch = Fixture()
        mismatch.package(marker=marker_v2(ref="wrong"))
        self.assertEqual(mismatch.check()["classification"], "marker_mismatch")

    def test_unique_matching_marker_recovers_renamed_target(self):
        fixture = Fixture()
        fixture.package(name="artist_node", marker={"id": "other", "source": SOURCE})
        renamed = fixture.package(name="renamed", marker=marker_v1())
        plan = fixture.check()
        self.assertEqual(plan["classification"], "renamed_owned")
        self.assertEqual(plan["resolved_target_path"], renamed.path)
        self.assertTrue(plan["actionable"])

    def test_duplicate_matching_markers_are_never_actionable(self):
        fixture = Fixture()
        fixture.package(marker=marker_v1())
        fixture.package(name="copy", marker=marker_v1())
        plan = fixture.check()
        self.assertEqual(plan["classification"], "duplicate_owned")
        self.assertFalse(plan["actionable"])
        with self.assertRaises(svc.PackageOwnershipError):
            fixture.service.apply(plan["plan_id"], "Bypass", "explicit_mode")

    def test_missing_unreadable_foreign_and_mismatched_markers_are_distinct(self):
        cases = (
            (None, "marker_missing"),
            ("not-json", "marker_unreadable"),
            (json.dumps({"id": "other", "source": SOURCE}), "foreign_target"),
            (json.dumps(marker_v1(source="https://example.invalid")), "marker_mismatch"),
        )
        for raw, expected in cases:
            with self.subTest(expected=expected):
                fixture = Fixture()
                package = fixture.package()
                if raw is not None:
                    marker = fixture.add(
                        Node(package.path + "/tdmcp_package_info", "textDAT", raw)
                    )
                    package.children.append(marker)
                plan = fixture.check()
                self.assertEqual(plan["classification"], expected)
                self.assertFalse(plan["actionable"])

    def test_candidate_limit_rejects_instead_of_truncating_ownership_search(self):
        fixture = Fixture()
        for index in range(svc.MAX_CANDIDATES + 1):
            fixture.package(name="p%d" % index)
        with self.assertRaises(svc.PackageNamespaceCapacityError):
            fixture.check(recorded_target_path=None)


class PlanTests(unittest.TestCase):
    def test_identical_check_deduplicates_and_ttl_expiry_fails_closed(self):
        fixture = Fixture()
        fixture.package(marker=marker_v1())
        first = fixture.check()
        duplicate = fixture.check()
        self.assertEqual(duplicate["plan_id"], first["plan_id"])
        self.assertTrue(duplicate["deduplicated"])
        fixture.clock.advance(svc.PLAN_TTL_SECONDS + 1)
        with self.assertRaises(svc.PackagePlanExpiredError):
            fixture.service.apply(first["plan_id"], "Bypass", "explicit_mode")

    def test_plan_cap_never_evicts_an_unconsumed_live_plan(self):
        fixture = Fixture(plan_cap=1)
        fixture.package(marker=marker_v1())
        fixture.check()
        fixture.package(name="other", marker={"id": "other", "source": SOURCE})
        with self.assertRaises(svc.PackageNamespaceCapacityError):
            fixture.check(package_id="other", recorded_target_path=None)

    def test_marker_change_after_plan_is_stale_and_zero_mutation(self):
        fixture = Fixture()
        package = fixture.package(marker=marker_v1())
        plan = fixture.check()
        package.op("tdmcp_package_info").text = json.dumps(
            marker_v1(source="https://example.invalid")
        )
        with self.assertRaises(svc.PackagePlanStaleError):
            fixture.service.apply(plan["plan_id"], "Bypass", "explicit_mode")
        self.assertFalse(package.bypass)
        self.assertEqual(fixture.deleted, [])


class ApplyTests(unittest.TestCase):
    def test_explicit_bypass_is_read_back_and_safe_to_replay(self):
        fixture = Fixture()
        package = fixture.package(marker=marker_v1())
        plan = fixture.check()
        applied = fixture.service.apply(plan["plan_id"], "Bypass", "explicit_mode")
        self.assertEqual(applied["action_applied"], "bypass")
        self.assertTrue(package.bypass)
        replay = fixture.service.apply(plan["plan_id"], "Bypass", "explicit_mode")
        self.assertEqual(replay["status"], "replayed")
        package.bypass = False
        with self.assertRaises(svc.PackagePostApplyStateChangedError):
            fixture.service.apply(plan["plan_id"], "Bypass", "explicit_mode")

    def test_replay_rejects_marker_change_even_when_bypass_flag_remains_true(self):
        fixture = Fixture()
        package = fixture.package(marker=marker_v1())
        plan = fixture.check()
        fixture.service.apply(plan["plan_id"], "Bypass", "explicit_mode")
        package.op("tdmcp_package_info").text = json.dumps(
            marker_v1(source="https://example.invalid")
        )
        with self.assertRaises(svc.PackagePostApplyStateChangedError):
            fixture.service.apply(plan["plan_id"], "Bypass", "explicit_mode")

    def test_native_delete_consumes_bound_interaction_once_and_confirms_absence(self):
        fixture = Fixture()
        package = fixture.package(marker=marker_v1())
        package.OPType = "baseCOMP"
        package.type = "base"
        plan = fixture.check()
        result = fixture.service.apply(
            plan["plan_id"], "Delete", "native", interaction_id="interaction-ticket"
        )
        self.assertEqual(result["action_applied"], "delete")
        self.assertIsNone(result["final_path"])
        self.assertIsNone(fixture.resolve(package.path))
        self.assertEqual(len(fixture.consumed), 1)
        self.assertEqual(
            fixture.consumed[0][1],
            fixture.fingerprint(package.path, "baseCOMP", package.name),
        )
        replay = fixture.service.apply(
            plan["plan_id"], "Delete", "native", interaction_id="interaction-ticket"
        )
        self.assertEqual(replay["status"], "replayed")
        self.assertEqual(len(fixture.consumed), 1)

    def test_native_keep_and_bypass_override_requested_delete(self):
        for decision, expected_action in (("Keep", "keep"), ("Bypass", "bypass")):
            with self.subTest(decision=decision):
                fixture = Fixture()
                package = fixture.package(marker=marker_v1())
                fixture.next_decision = {"accepted": True, "decision": decision}
                plan = fixture.check()
                result = fixture.service.apply(
                    plan["plan_id"], "Delete", "native", interaction_id="ticket"
                )
                self.assertEqual(result["action_applied"], expected_action)
                self.assertIsNotNone(fixture.resolve(package.path))
                self.assertEqual(fixture.deleted, [])
                self.assertEqual(package.bypass, decision == "Bypass")

    def test_rejected_or_wrong_interaction_fails_without_mutation(self):
        fixture = Fixture()
        package = fixture.package(marker=marker_v1())
        fixture.next_decision = {
            "accepted": False,
            "decision": "Delete",
            "error": "fingerprint_mismatch",
        }
        plan = fixture.check()
        with self.assertRaises(svc.PackageInteractionError):
            fixture.service.apply(plan["plan_id"], "Delete", "native", "wrong")
        self.assertIsNotNone(fixture.resolve(package.path))
        self.assertEqual(fixture.deleted, [])

    def test_explicit_yolo_is_audited_and_never_accepts_interaction_id(self):
        fixture = Fixture()
        fixture.package(marker=marker_v1())
        plan = fixture.check()
        result = fixture.service.apply(plan["plan_id"], "Delete", "yolo")
        self.assertEqual(result["confirmation_policy"], "yolo")
        self.assertEqual(fixture.consumed, [])

        second = Fixture()
        second.package(marker=marker_v1())
        second_plan = second.check()
        with self.assertRaises(svc.PackageNamespaceValidationError):
            second.service.apply(second_plan["plan_id"], "Delete", "yolo", "ticket")

    def test_exec_disabled_environment_does_not_change_structured_service(self):
        previous = os.environ.get("TDMCP_BRIDGE_ALLOW_EXEC")
        os.environ["TDMCP_BRIDGE_ALLOW_EXEC"] = "0"
        try:
            fixture = Fixture()
            fixture.package(marker=marker_v1())
            self.assertTrue(fixture.check()["actionable"])
        finally:
            if previous is None:
                os.environ.pop("TDMCP_BRIDGE_ALLOW_EXEC", None)
            else:
                os.environ["TDMCP_BRIDGE_ALLOW_EXEC"] = previous


if __name__ == "__main__":
    unittest.main()
