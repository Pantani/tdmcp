"""Focused controller coverage for Wave 10 structured editor routes."""

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


class Wave10EditorRouteTests(unittest.TestCase):
    def setUp(self):
        os.environ["TDMCP_BRIDGE_TOKEN"] = "wave10-secret"
        os.environ["TDMCP_BRIDGE_ALLOW_EXEC"] = "0"

    def tearDown(self):
        os.environ.pop("TDMCP_BRIDGE_TOKEN", None)
        os.environ.pop("TDMCP_BRIDGE_ALLOW_EXEC", None)

    @staticmethod
    def _request(method, uri, body=None, authenticated=True):
        request = {
            "method": method,
            "uri": uri,
            "remoteAddress": "127.0.0.1",
        }
        if authenticated:
            request["headers"] = {"authorization": "Bearer wave10-secret"}
        if body is not None:
            request["data"] = json.dumps(body)
        return request

    def test_reposition_context_is_authenticated_and_structured(self):
        unauthenticated = ac.handle(
            self._request(
                "POST",
                "/api/editor/reposition/context",
                {"root_path": "/project1", "positions": []},
                authenticated=False,
            ),
            {},
        )
        self.assertEqual(unauthenticated["statusCode"], 401)

        expected = {"fingerprint": "a" * 64, "nodes": []}
        with mock.patch.object(
            ac.reposition_service, "get_reposition_context", return_value=expected
        ) as context:
            response = ac.handle(
                self._request(
                    "POST",
                    "/api/editor/reposition/context",
                    {
                        "root_path": "/project1/show",
                        "target_source": "provided_paths",
                        "include_docked": True,
                        "positions": [
                            {"path": "/project1/show/a", "x": 10, "y": 20}
                        ],
                    },
                ),
                {},
            )
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(json.loads(response["data"])["data"], expected)
        context.assert_called_once()

    def test_workspace_routes_dispatch_and_never_open_graph_undo(self):
        receipt = {"workspace_id": "workspace_opaque_123456789", "status": "scheduled"}
        with mock.patch.object(
            ac.workspace_service, "open_workspace", return_value=receipt
        ) as open_workspace:
            response = ac.handle(
                self._request(
                    "POST",
                    "/api/editor/workspaces",
                    {
                        "network_path": "/project1/show",
                        "viewer_path": "/project1/show/out1",
                        "viewer_mode": "top_output",
                        "split_ratio": 0.62,
                        "lease_seconds": 300,
                        "idempotency_key": "open_1234567890123456",
                    },
                ),
                {},
            )
        self.assertEqual(response["statusCode"], 200)
        open_workspace.assert_called_once()
        self.assertIsNone(ac._undo_label("POST", "/api/editor/workspaces", {}))
        self.assertIsNone(
            ac._undo_label(
                "POST",
                "/api/editor/workspaces/workspace_opaque_123456789/restore",
                {},
            )
        )

    def test_reposition_context_is_excluded_but_apply_has_useful_label(self):
        self.assertIsNone(
            ac._undo_label("POST", "/api/editor/reposition/context", {})
        )
        self.assertEqual(
            ac._undo_label(
                "POST",
                "/api/editor/reposition",
                {"root_path": "/project1/show"},
            ),
            "MCP arrange_network explicit /project1/show",
        )

    def test_reposition_failure_keeps_bounded_rollback_details(self):
        report = {
            "mode": "explicit",
            "status": "failed",
            "rollback": {"attempted": True, "succeeded": True, "errors": []},
        }
        payload = ac._error_payload(
            ac.reposition_service.RepositionError(
                "reposition_apply_failed", "apply failed", report
            )
        )
        self.assertEqual(payload["error"]["code"], "reposition_apply_failed")
        self.assertEqual(payload["error"]["details"], report)

    def test_new_route_payloads_are_bounded_before_service_dispatch(self):
        oversized = {"padding": "x" * (32 * 1024)}
        with mock.patch.object(ac.workspace_service, "open_workspace") as open_workspace:
            response = ac.handle(
                self._request("POST", "/api/editor/workspaces", oversized), {},
            )
        self.assertEqual(response["statusCode"], 413)
        self.assertIn("payload_too_large", response["data"])
        self.assertIn("bounded route limit", response["data"])
        open_workspace.assert_not_called()

    def test_exec_stays_forbidden_while_structured_routes_are_enabled(self):
        response = ac.handle(
            self._request("POST", "/api/exec", {"script": "print(1)"}), {},
        )
        self.assertEqual(response["statusCode"], 403)


if __name__ == "__main__":
    unittest.main()
