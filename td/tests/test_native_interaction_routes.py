"""Controller integration tests for wave-1 structured interaction routes."""

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

_td_stub = sys.modules.setdefault("td", types.ModuleType("td"))
for _name in ("op", "app", "project"):
    if not hasattr(_td_stub, _name):
        setattr(_td_stub, _name, mock.MagicMock(name=_name))
from mcp.controllers import api_controller as ac  # noqa: E402


class NativeInteractionRouteTests(unittest.TestCase):
    @staticmethod
    def _oauth_target():
        return {
            "transaction_id": "transaction_opaque_1234567890123456",
            "client_id": "client_123",
            "client_name": "Studio controller",
            "redirect_uri": "http://127.0.0.1:4567/callback",
            "registered_redirect_uris": ["http://127.0.0.1:4567/callback"],
            "allowed_redirect_origins": [],
            "resource": "http://127.0.0.1:3939/mcp",
            "scopes": ["tdmcp:access"],
        }

    def test_delete_interaction_fingerprint_is_built_from_live_node(self):
        node = {"path": "/project1/geo1", "type": "geometryCOMP", "name": "geo1"}
        with mock.patch.object(ac.api_service, "get_node", return_value=node), mock.patch.object(
            ac.interaction_service, "fingerprint_target", return_value="f" * 64
        ) as fingerprint, mock.patch.object(
            ac.interaction_service, "create_interaction", return_value={"state": "pending"}
        ) as create:
            result = ac._route(
                "POST",
                "/api/interactions",
                {},
                {"kind": "delete_node", "target": {"path": node["path"]}, "ttl_seconds": 10},
            )
        self.assertEqual(result["state"], "pending")
        fingerprint.assert_called_once_with(node["path"], node["type"], node["name"])
        self.assertEqual(create.call_args.kwargs["choices"], ("Delete", "Bypass", "Keep"))
        self.assertNotIn("target_fingerprint", {"kind": "delete_node", "target": {"path": node["path"]}})

    def test_resolved_bypass_is_consumed_once_and_never_destroyed(self):
        node = {"path": "/project1/geo1", "type": "geometryCOMP", "name": "geo1"}
        with mock.patch.object(ac.api_service, "get_node", return_value=node), mock.patch.object(
            ac.interaction_service, "fingerprint_target", return_value="f" * 64
        ), mock.patch.object(
            ac.interaction_service,
            "consume_interaction",
            return_value={"accepted": True, "decision": "Bypass"},
        ) as consume, mock.patch.object(
            ac.api_service, "delete_node", return_value={"decision": "Bypass"}
        ) as delete:
            result = ac._route(
                "DELETE",
                "/api/nodes/project1/geo1",
                {"mode": ["delete"], "interaction_id": ["opaque-ticket"]},
                {},
            )
        self.assertEqual(result["decision"], "Bypass")
        consume.assert_called_once()
        self.assertEqual(delete.call_args.kwargs["mode"], "bypass")
        self.assertEqual(delete.call_args.kwargs["decision"], "Bypass")

    def test_rejected_or_duplicate_ticket_fails_closed_to_keep(self):
        node = {"path": "/project1/geo1", "type": "geometryCOMP", "name": "geo1"}
        with mock.patch.object(ac.api_service, "get_node", return_value=node), mock.patch.object(
            ac.interaction_service, "fingerprint_target", return_value="f" * 64
        ), mock.patch.object(
            ac.interaction_service,
            "consume_interaction",
            return_value={"accepted": False, "decision": "Delete", "error": "already_consumed"},
        ), mock.patch.object(
            ac.api_service, "delete_node", return_value={"decision": "Keep"}
        ) as delete:
            ac._route(
                "DELETE",
                "/api/nodes/project1/geo1",
                {"interaction_id": ["opaque-ticket"]},
                {},
            )
        self.assertEqual(delete.call_args.kwargs["decision"], "Keep")

    def test_explicit_yolo_is_the_only_confirmation_skip(self):
        with mock.patch.object(ac.api_service, "delete_node", return_value={"decision": "Delete"}) as delete:
            ac._route(
                "DELETE",
                "/api/nodes/project1/geo1",
                {"confirmation_policy": ["yolo"]},
                {},
            )
        self.assertEqual(delete.call_args.kwargs["confirmation_policy"], "yolo")

    def test_project_overwrite_claim_is_constructed_only_after_ticket_consumption(self):
        target = "/show/existing.toe"
        with mock.patch.object(ac.project_service, "normalize_project_path", return_value=target), mock.patch.object(
            ac.interaction_service, "fingerprint_target", return_value="f" * 64
        ), mock.patch.object(
            ac.interaction_service,
            "consume_interaction",
            return_value={"accepted": True, "decision": "Overwrite"},
        ), mock.patch.object(
            ac.project_service,
            "save_project",
            return_value={"final_path": target, "verified_exists": True, "decision": "overwrite"},
        ) as save:
            result = ac._route(
                "POST", "/api/project/save", {}, {"path": target, "interaction_id": "ticket"}
            )
        claim = save.call_args.kwargs["overwrite_approval"]
        self.assertEqual(claim["target_path"], target)
        self.assertEqual(claim["choice"], "Overwrite")
        self.assertTrue(result["saved"])

    def test_structured_routes_do_not_depend_on_exec_gate(self):
        os.environ["TDMCP_BRIDGE_ALLOW_EXEC"] = "0"
        try:
            with mock.patch.object(
                ac.editor_context_service, "get_editor_context", return_value={"ui_available": False}
            ), mock.patch.object(
                ac.interaction_service,
                "interaction_summary",
                return_value={
                    "pending_count": 0,
                    "pending_limit": 3,
                    "active": False,
                    "delivery_configured": True,
                },
            ), mock.patch.object(
                ac.parameter_service, "pulse_parameter", return_value={"pulsed": True}
            ), mock.patch.object(
                ac.metadata_service, "edit_node_metadata", return_value={"applied": True}
            ):
                self.assertFalse(ac._route("GET", "/api/editor/context", {}, {})["ui_available"])
                self.assertEqual(
                    ac._route("GET", "/api/interactions/status", {}, {})["pending_count"],
                    0,
                )
                self.assertTrue(
                    ac._route(
                        "POST", "/api/nodes/project1/geo1/params/Reset/pulse", {}, {}
                    )["pulsed"]
                )
                self.assertTrue(
                    ac._route(
                        "PATCH", "/api/nodes/project1/geo1/metadata", {}, {"node_x": 100}
                    )["applied"]
                )
        finally:
            os.environ.pop("TDMCP_BRIDGE_ALLOW_EXEC", None)

    def test_oauth_consent_uses_exact_allow_deny_and_td_owned_fingerprint(self):
        target = self._oauth_target()
        with mock.patch.object(
            ac.interaction_service,
            "create_interaction",
            return_value={"state": "pending"},
        ) as create:
            result = ac._route(
                "POST",
                "/api/interactions",
                {},
                {"kind": "oauth_client_consent", "target": target},
            )
        self.assertEqual(result["state"], "pending")
        self.assertEqual(create.call_args.kwargs["choices"], ("Allow", "Deny"))
        self.assertEqual(len(create.call_args.kwargs["target_fingerprint"]), 64)
        self.assertNotIn("target_fingerprint", target)

    def test_oauth_consent_is_consumed_once_and_duplicate_fails_closed(self):
        target = self._oauth_target()
        with mock.patch.object(
            ac.interaction_service,
            "consume_interaction",
            side_effect=(
                {"state": "resolved", "accepted": True, "decision": "Allow"},
                {
                    "state": "resolved",
                    "accepted": False,
                    "decision": "Allow",
                    "error": "already_consumed",
                },
            ),
        ) as consume:
            first = ac._route(
                "POST",
                "/api/oauth/consents/opaque_request_123456789/consume",
                {},
                {"target": target},
            )
            duplicate = ac._route(
                "POST",
                "/api/oauth/consents/opaque_request_123456789/consume",
                {},
                {"target": target},
            )
        self.assertTrue(first["accepted"])
        self.assertEqual(first["decision"], "Allow")
        self.assertFalse(duplicate["accepted"])
        self.assertEqual(duplicate["error"], "already_consumed")
        self.assertEqual(consume.call_count, 2)

    def test_oauth_consent_is_bounded_authenticated_and_exec_independent(self):
        self.assertEqual(ac._bounded_body_limit("POST", "/api/interactions"), 32 * 1024)
        self.assertEqual(
            ac._bounded_body_limit(
                "POST", "/api/oauth/consents/opaque_request_123456789/consume"
            ),
            32 * 1024,
        )
        os.environ["TDMCP_BRIDGE_ALLOW_EXEC"] = "0"
        try:
            with mock.patch.object(
                ac.interaction_service,
                "create_interaction",
                return_value={"state": "pending"},
            ):
                self.assertEqual(
                    ac._route(
                        "POST",
                        "/api/interactions",
                        {},
                        {
                            "kind": "oauth_client_consent",
                            "target": self._oauth_target(),
                        },
                    )["state"],
                    "pending",
                )
        finally:
            os.environ.pop("TDMCP_BRIDGE_ALLOW_EXEC", None)

    def test_new_endpoints_still_require_bearer_auth(self):
        os.environ["TDMCP_BRIDGE_TOKEN"] = "secret"
        try:
            response = ac.handle(
                {"method": "GET", "uri": "/api/editor/context", "remoteAddress": "127.0.0.1"},
                {},
            )
            self.assertEqual(response["statusCode"], 401)
            self.assertFalse(json.loads(response["data"])["ok"])
            interaction_response = ac.handle(
                {
                    "method": "GET",
                    "uri": "/api/interactions/status",
                    "remoteAddress": "127.0.0.1",
                },
                {},
            )
            self.assertEqual(interaction_response["statusCode"], 401)
            oauth_response = ac.handle(
                {
                    "method": "POST",
                    "uri": "/api/oauth/consents/opaque_request_123456789/consume",
                    "remoteAddress": "127.0.0.1",
                    "data": json.dumps({"target": self._oauth_target()}),
                },
                {},
            )
            self.assertEqual(oauth_response["statusCode"], 401)
        finally:
            os.environ.pop("TDMCP_BRIDGE_TOKEN", None)

    def test_broker_errors_have_specific_envelope_codes(self):
        cases = (
            (ac.interaction_service.InteractionNotFoundError("missing"), "interaction_not_found"),
            (ac.interaction_service.InteractionCapacityError("full"), "interaction_capacity"),
            (ac.interaction_service.InteractionConflictError("duplicate"), "interaction_conflict"),
        )
        for error, expected in cases:
            with self.subTest(expected=expected), mock.patch.object(
                ac, "_backpressure_response", return_value=None
            ), mock.patch.object(ac, "_route", side_effect=error):
                response = ac.handle(
                    {
                        "method": "GET",
                        "uri": "/api/interactions/opaque-ticket",
                        "remoteAddress": "127.0.0.1",
                    },
                    {},
                )
            payload = json.loads(response["data"])
            self.assertEqual(payload["error"]["code"], expected)


if __name__ == "__main__":
    unittest.main()
