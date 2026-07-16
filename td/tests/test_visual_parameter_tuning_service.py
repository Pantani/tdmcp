"""Offline contract tests for bounded visual parameter inspect/commit/restore."""

import os
import sys
import types
import unittest
from unittest import mock


_HERE = os.path.dirname(os.path.abspath(__file__))
_MODULES = os.path.abspath(os.path.join(_HERE, "..", "modules"))
if _MODULES not in sys.path:
    sys.path.insert(0, _MODULES)

td = sys.modules.setdefault("td", types.ModuleType("td"))

from mcp.services import interaction_service  # noqa: E402
from mcp.services import visual_parameter_tuning_service as visual  # noqa: E402


class Named:
    def __init__(self, name):
        self.name = name

    def __str__(self):
        return self.name


class FakePar:
    def __init__(
        self,
        value,
        style="Float",
        mode="CONSTANT",
        minimum=0,
        maximum=1,
        clamp_min=True,
        clamp_max=True,
    ):
        self._value = value
        self.style = Named(style)
        self.mode = Named(mode)
        self.min = minimum
        self.max = maximum
        self.clampMin = clamp_min
        self.clampMax = clamp_max
        self.readOnly = False
        self.fail_value = None

    def eval(self):
        return self._value

    @property
    def val(self):
        return self._value

    @val.setter
    def val(self, value):
        if self.fail_value is not None and value == self.fail_value:
            raise RuntimeError("injected assignment failure")
        self._value = value


class FakeNode:
    def __init__(self, path, type_name, parameters=None):
        self.path = path
        self.type = type_name
        self.isTOP = type_name.endswith("TOP")
        self.par = types.SimpleNamespace(**(parameters or {}))


class VisualServiceTests(unittest.TestCase):
    def setUp(self):
        visual.reset_state()
        interaction_service._DEFAULT_BROKER.clear()
        interaction_service.configure_delivery(lambda callback: callback(), lambda _payload: True)
        self.opacity = FakePar(0.5)
        self.gamma = FakePar(1.0, minimum=0, maximum=2)
        self.nodes = {
            "/project1/out1": FakeNode("/project1/out1", "nullTOP"),
            "/project1/level1": FakeNode(
                "/project1/level1",
                "levelTOP",
                {"opacity": self.opacity, "gamma": self.gamma},
            ),
        }
        td.op = lambda path: self.nodes.get(path)

    def inspect_body(self, two=False):
        targets = [
            {
                "node_path": "/project1/level1",
                "parameter": "opacity",
                "minimum": 0,
                "maximum": 1,
            }
        ]
        if two:
            targets.append(
                {
                    "node_path": "/project1/level1",
                    "parameter": "gamma",
                    "minimum": 0,
                    "maximum": 2,
                }
            )
        return {
            "scope_path": "/project1",
            "output_top_path": "/project1/out1",
            "targets": targets,
        }

    def approved_commit(self, inspected, changes, key="a" * 64):
        target = {
            "expected_fingerprint": inspected["fingerprint"],
            "proposal_digest": "b" * 64,
            "changes": changes,
        }
        descriptor = visual.build_interaction_request(target)
        ticket = interaction_service.create_interaction(
            kind="visual_parameter_apply",
            choices=("Apply", "Keep"),
            title=descriptor["title"],
            prompt=descriptor["prompt"],
            target_fingerprint=descriptor["target_fingerprint"],
            ttl_seconds=30,
            dedupe_key="approval-" + key,
        )
        interaction_service.resolve_interaction(ticket["request_id"], "Apply")
        return visual.commit_visual_parameters(
            {
                "scope_path": "/project1",
                "output_top_path": "/project1/out1",
                "expected_fingerprint": inspected["fingerprint"],
                "proposal_digest": "b" * 64,
                "idempotency_key": key,
                "interaction_id": ticket["request_id"],
                "changes": changes,
            }
        )

    def test_inspect_returns_only_eligible_bounded_scalar_snapshot(self):
        report = visual.inspect_visual_parameters(self.inspect_body())
        self.assertRegex(report["fingerprint"], r"^[a-f0-9]{64}$")
        self.assertEqual(report["targets"][0]["id"], "t1")
        self.assertEqual(report["targets"][0]["type"], "Float")
        self.assertEqual(report["targets"][0]["mode"], "CONSTANT")
        self.assertNotIn("object", repr(report))

    def test_inspect_ignores_inactive_native_clamp_sentinels(self):
        self.nodes["/project1/level1"].par.fontsize = FakePar(
            16.0,
            minimum=0,
            maximum=0,
            clamp_min=False,
            clamp_max=False,
        )
        body = self.inspect_body()
        body["targets"] = [
            {
                "node_path": "/project1/level1",
                "parameter": "fontsize",
                "minimum": 8,
                "maximum": 120,
            }
        ]
        report = visual.inspect_visual_parameters(body)
        self.assertEqual(report["targets"][0]["minimum"], 8.0)
        self.assertEqual(report["targets"][0]["maximum"], 120.0)

    def test_inspect_rejects_scope_escape_non_top_and_ineligible_parameter(self):
        escaped = self.inspect_body()
        escaped["targets"][0]["node_path"] = "/outside/level1"
        with self.assertRaisesRegex(visual.VisualParameterTuningError, "escapes"):
            visual.inspect_visual_parameters(escaped)
        self.nodes["/project1/out1"].isTOP = False
        self.nodes["/project1/out1"].type = "baseCOMP"
        with self.assertRaisesRegex(visual.VisualParameterTuningError, "TOP"):
            visual.inspect_visual_parameters(self.inspect_body())
        self.nodes["/project1/out1"].isTOP = True
        self.opacity.mode = Named("EXPRESSION")
        with self.assertRaisesRegex(visual.VisualParameterTuningError, "CONSTANT"):
            visual.inspect_visual_parameters(self.inspect_body())

    def test_interaction_copy_is_server_derived_and_exactly_apply_keep(self):
        inspected = visual.inspect_visual_parameters(self.inspect_body())
        descriptor = visual.build_interaction_request(
            {
                "expected_fingerprint": inspected["fingerprint"],
                "proposal_digest": "b" * 64,
                "changes": [{"target_id": "t1", "value": 0.75}],
            }
        )
        self.assertIn("/project1/level1.opacity: 0.5 -> 0.75", descriptor["prompt"])
        self.assertNotIn("choices", descriptor)
        self.assertRegex(descriptor["target_fingerprint"], r"^[a-f0-9]{64}$")

    def test_commit_requires_consumed_apply_and_is_exactly_once(self):
        inspected = visual.inspect_visual_parameters(self.inspect_body())
        changes = [{"target_id": "t1", "value": 0.75}]
        committed = self.approved_commit(inspected, changes)
        self.assertEqual(committed["status"], "committed")
        self.assertEqual(self.opacity.eval(), 0.75)
        replayed = self.approved_commit(inspected, changes)
        self.assertTrue(replayed["replayed"])
        self.assertEqual(replayed["restore_token"], committed["restore_token"])

    def test_keep_ticket_cannot_authorize_commit(self):
        inspected = visual.inspect_visual_parameters(self.inspect_body())
        changes = [{"target_id": "t1", "value": 0.75}]
        target = {
            "expected_fingerprint": inspected["fingerprint"],
            "proposal_digest": "b" * 64,
            "changes": changes,
        }
        descriptor = visual.build_interaction_request(target)
        ticket = interaction_service.create_interaction(
            kind="visual_parameter_apply",
            choices=("Apply", "Keep"),
            title=descriptor["title"],
            prompt=descriptor["prompt"],
            target_fingerprint=descriptor["target_fingerprint"],
            ttl_seconds=30,
        )
        interaction_service.resolve_interaction(ticket["request_id"], "Keep")
        with self.assertRaisesRegex(visual.VisualParameterTuningError, "not accepted"):
            visual.commit_visual_parameters(
                {
                    "scope_path": "/project1",
                    "output_top_path": "/project1/out1",
                    "expected_fingerprint": inspected["fingerprint"],
                    "proposal_digest": "b" * 64,
                    "idempotency_key": "a" * 64,
                    "interaction_id": ticket["request_id"],
                    "changes": changes,
                }
            )
        self.assertEqual(self.opacity.eval(), 0.5)

    def test_commit_cas_refuses_artist_edit_after_approval(self):
        inspected = visual.inspect_visual_parameters(self.inspect_body())
        self.opacity.val = 0.6
        result = self.approved_commit(
            inspected, [{"target_id": "t1", "value": 0.75}]
        )
        self.assertEqual(result["status"], "conflict")
        self.assertEqual(self.opacity.eval(), 0.6)

    def test_partial_apply_failure_restores_every_original_value(self):
        inspected = visual.inspect_visual_parameters(self.inspect_body(two=True))
        self.gamma.fail_value = 1.5
        result = self.approved_commit(
            inspected,
            [
                {"target_id": "t1", "value": 0.75},
                {"target_id": "t2", "value": 1.5},
            ],
        )
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["reason"], "apply_failed")
        self.assertEqual(self.opacity.eval(), 0.5)
        self.assertEqual(self.gamma.eval(), 1.0)

    def test_restore_is_cas_protected_verified_and_idempotent(self):
        inspected = visual.inspect_visual_parameters(self.inspect_body())
        committed = self.approved_commit(
            inspected, [{"target_id": "t1", "value": 0.75}]
        )
        body = {
            "restore_token": committed["restore_token"],
            "expected_committed_fingerprint": committed["final_fingerprint"],
            "idempotency_key": "c" * 64,
        }
        restored = visual.restore_visual_parameters(body)
        self.assertTrue(restored["verified"])
        self.assertEqual(restored["restored_fingerprint"], inspected["fingerprint"])
        self.assertEqual(self.opacity.eval(), 0.5)
        replayed = visual.restore_visual_parameters(body)
        self.assertTrue(replayed["replayed"])

    def test_restore_refuses_artist_edit_after_commit(self):
        inspected = visual.inspect_visual_parameters(self.inspect_body())
        committed = self.approved_commit(
            inspected, [{"target_id": "t1", "value": 0.75}]
        )
        self.opacity.val = 0.9
        restored = visual.restore_visual_parameters(
            {
                "restore_token": committed["restore_token"],
                "expected_committed_fingerprint": committed["final_fingerprint"],
                "idempotency_key": "c" * 64,
            }
        )
        self.assertFalse(restored["restored"])
        self.assertEqual(restored["reason"], "stale_targets")
        self.assertEqual(self.opacity.eval(), 0.9)

    def test_service_has_no_exec_gate_or_python_payload_surface(self):
        with mock.patch.dict(os.environ, {"TDMCP_BRIDGE_ALLOW_EXEC": "0"}):
            report = visual.inspect_visual_parameters(self.inspect_body())
        self.assertIn("fingerprint", report)
        with self.assertRaises(visual.VisualParameterTuningError):
            visual.inspect_visual_parameters({**self.inspect_body(), "script": "1+1"})


if __name__ == "__main__":
    unittest.main()
