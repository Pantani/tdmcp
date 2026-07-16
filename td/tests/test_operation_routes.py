"""Authenticated controller/runtime tests for structured operation routes."""

import json
import os
import sys
import types
import unittest
from unittest import mock


_HERE = os.path.dirname(os.path.abspath(__file__))
_MODULES = os.path.abspath(os.path.join(_HERE, "..", "modules"))
if _MODULES not in sys.path:
    sys.path.insert(0, _MODULES)

_td_stub = sys.modules.get("td") or types.ModuleType("td")
_td_stub.op = getattr(_td_stub, "op", mock.MagicMock(name="op"))
_td_stub.app = getattr(_td_stub, "app", mock.MagicMock(name="app"))
_td_stub.project = getattr(_td_stub, "project", mock.MagicMock(name="project"))
sys.modules["td"] = _td_stub

from mcp.controllers import api_controller as controller  # noqa: E402
from mcp.services import operation_plan_service  # noqa: E402
from mcp.services import operation_runtime_service as runtime  # noqa: E402


TOKEN = "wave15-operation-token"
PRINCIPAL = "wave15-principal"


def _request(path, body, token=TOKEN):
    headers = {"host": "127.0.0.1:9980"}
    if token is not None:
        headers["authorization"] = "Bearer " + token
    return {
        "method": "POST",
        "uri": path,
        "headers": headers,
        "data": json.dumps(body),
    }


class OperationRouteTests(unittest.TestCase):
    def setUp(self):
        os.environ["TDMCP_BRIDGE_TOKEN"] = TOKEN
        os.environ["TDMCP_BRIDGE_ALLOW_EXEC"] = "0"
        controller._BACKPRESSURE["cooldown_until"] = 0.0

    def tearDown(self):
        os.environ.pop("TDMCP_BRIDGE_TOKEN", None)
        os.environ.pop("TDMCP_BRIDGE_ALLOW_EXEC", None)

    def test_operation_auth_is_required_before_body_parsing(self):
        os.environ.pop("TDMCP_BRIDGE_TOKEN")
        response = {}
        with mock.patch.object(controller, "_parse_body") as parse_body:
            controller.handle(
                {
                    "method": "POST",
                    "uri": "/api/operations/commit",
                    "data": "{not-json",
                },
                response,
            )
        self.assertEqual(response["statusCode"], 401)
        parse_body.assert_not_called()

    def test_wrong_bearer_is_rejected_before_body_parsing(self):
        response = {}
        with mock.patch.object(controller, "_parse_body") as parse_body:
            controller.handle(
                _request("/api/operations/preview", {}, token="wrong"),
                response,
            )
        self.assertEqual(response["statusCode"], 401)
        parse_body.assert_not_called()

    def test_preview_dispatches_with_exec_disabled_and_without_generic_undo(self):
        expected = {"status": "preview"}
        with mock.patch.object(
            controller.operation_runtime_service,
            "preview",
            return_value=expected,
        ) as preview:
            response = controller.handle(
                _request("/api/operations/preview", {"schema_version": 1}),
                {},
            )
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(json.loads(response["data"])["data"], expected)
        preview.assert_called_once_with({"schema_version": 1}, TOKEN)
        self.assertIsNone(
            controller._undo_label("POST", "/api/operations/commit", {})
        )

    def test_route_family_dispatches_commit_and_receipt(self):
        with mock.patch.object(
            controller.operation_runtime_service,
            "commit",
            return_value={"status": "applied"},
        ) as commit:
            controller._route(
                "POST",
                "/api/operations/commit",
                {},
                {"schema_version": 1},
                operation_principal=PRINCIPAL,
            )
        commit.assert_called_once_with({"schema_version": 1}, PRINCIPAL)

        authority = {
            "schema_version": 1,
            "operation_id": "operation-wave15-01",
            "receipt_capability": "c" * 43,
        }
        with mock.patch.object(
            controller.operation_runtime_service,
            "receipt",
            return_value={"status": "receipt"},
        ) as receipt:
            controller._route(
                "POST",
                "/api/operations/receipt",
                {},
                authority,
                operation_principal=PRINCIPAL,
            )
        receipt.assert_called_once_with(authority, PRINCIPAL)

    def test_operation_errors_preserve_codes_and_statuses(self):
        cases = (
            ("operation_authority", 403),
            ("preview_expired", 410),
            ("receipt_unavailable", 410),
            ("stale_plan", 409),
            ("invalid_operation_plan", 400),
        )
        for code, status in cases:
            with self.subTest(code=code), mock.patch.object(
                controller.operation_runtime_service,
                "preview",
                side_effect=operation_plan_service.OperationPlanError(code, "bounded"),
            ):
                response = controller.handle(
                    _request("/api/operations/preview", {"schema_version": 1}),
                    {},
                )
                payload = json.loads(response["data"])
                self.assertEqual(response["statusCode"], status)
                self.assertEqual(payload["error"]["code"], code)

    def test_route_specific_body_caps_are_bounded(self):
        self.assertEqual(
            controller._bounded_body_limit("POST", "/api/operations/preview"),
            operation_plan_service.MAX_BODY_BYTES,
        )
        self.assertEqual(
            controller._bounded_body_limit("POST", "/api/operations/receipt"),
            8 * 1024,
        )


class OperationRuntimeReceiptTests(unittest.TestCase):
    def tearDown(self):
        runtime.reset_for_tests()

    @staticmethod
    def _terminal(status="applied"):
        return {
            "status": status,
            "operation_id": "operation-wave15-01",
            "receipt_capability": "c" * 43,
            "bridge_instance_id": "bridge-instance-wave15",
            "plan_digest": "a" * 64,
            "owner_path": "/project1/show",
            "affected_paths": ["/project1/show/a"],
            "results": [],
            "verification": {"status": "PASS", "snapshot": "after"},
            "rollback": {"attempted": False, "succeeded": True, "errors": []},
            "journal": {
                "registered": status == "applied",
                "operation_id": "operation-wave15-01" if status == "applied" else None,
                "label": "MCP operation wave15" if status == "applied" else None,
                "native_stack_delta": 1 if status == "applied" else 0,
                "observed_state": "applied" if status == "applied" else "unknown",
            },
            "warnings": [],
        }

    def test_receipt_authorizes_before_live_observation_and_reports_exact_state(self):
        terminal = self._terminal()
        fake = mock.MagicMock()
        private_journal = {"schema_version": 2, "operation_id": terminal["operation_id"]}
        fake.get_private_operation_record.return_value = {
            "receipt": terminal,
            "private_journal": private_journal,
        }
        fake._transaction_adapter.observe_journal.return_value = "undone"
        runtime._SERVICE = fake

        authority = {
            "schema_version": 1,
            "operation_id": terminal["operation_id"],
            "receipt_capability": terminal["receipt_capability"],
        }
        result = runtime.receipt(authority, PRINCIPAL)

        fake.get_private_operation_record.assert_called_once_with(
            terminal["operation_id"], terminal["receipt_capability"], PRINCIPAL
        )
        fake._transaction_adapter.observe_journal.assert_called_once_with(private_journal)
        self.assertEqual(
            result["observation"],
            {
                "available": True,
                "state": "undone",
                "verification": "PASS",
                "snapshot": "before",
            },
        )

    def test_failed_receipt_never_invokes_live_observation(self):
        terminal = self._terminal("failed_rolled_back")
        fake = mock.MagicMock()
        fake.get_private_operation_record.return_value = {
            "receipt": terminal,
            "private_journal": None,
        }
        runtime._SERVICE = fake
        result = runtime.receipt(
            {
                "schema_version": 1,
                "operation_id": terminal["operation_id"],
                "receipt_capability": terminal["receipt_capability"],
            },
            PRINCIPAL,
        )
        fake._transaction_adapter.observe_journal.assert_not_called()
        self.assertEqual(result["observation"]["reason"], "not_applicable")

    def test_receipt_request_is_strict_and_capability_errors_are_uniform(self):
        for payload in (
            {},
            {"schema_version": 2, "operation_id": "x", "receipt_capability": "c" * 43},
            {
                "schema_version": 1,
                "operation_id": "x",
                "receipt_capability": "c" * 43,
                "principal": "caller-controlled",
            },
        ):
            with self.subTest(payload=payload), self.assertRaises(
                operation_plan_service.OperationPlanError
            ):
                runtime.receipt(payload, PRINCIPAL)


if __name__ == "__main__":
    unittest.main()
