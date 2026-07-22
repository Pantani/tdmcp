"""Focused authenticated controller tests for visual parameter routes."""

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

_td = sys.modules.setdefault("td", types.ModuleType("td"))
for _name in ("op", "app", "project"):
    if not hasattr(_td, _name):
        setattr(_td, _name, mock.MagicMock(name=_name))

from mcp.controllers import api_controller as controller  # noqa: E402


class VisualParameterRouteTests(unittest.TestCase):
    def tearDown(self):
        os.environ.pop("TDMCP_BRIDGE_TOKEN", None)
        os.environ.pop("TDMCP_BRIDGE_ALLOW_EXEC", None)

    @staticmethod
    def request(path, body, token=None):
        request = {
            "method": "POST",
            "uri": path,
            "data": json.dumps(body),
            "Host": "127.0.0.1:9980",
        }
        if token is not None:
            request["Authorization"] = "Bearer " + token
        return request

    def test_visual_routes_inherit_bearer_auth_and_survive_exec_zero(self):
        os.environ["TDMCP_BRIDGE_TOKEN"] = "secret"
        os.environ["TDMCP_BRIDGE_ALLOW_EXEC"] = "0"
        body = {
            "scope_path": "/project1",
            "output_top_path": "/project1/out1",
            "targets": [],
        }
        unauthorized = controller.handle(
            self.request("/api/editor/visual-parameters/inspect", body), {}
        )
        self.assertEqual(unauthorized["statusCode"], 401)
        with mock.patch.object(
            controller.visual_parameter_tuning_service,
            "inspect_visual_parameters",
            return_value={"fingerprint": "a" * 64},
        ) as inspect:
            authorized = controller.handle(
                self.request(
                    "/api/editor/visual-parameters/inspect", body, token="secret"
                ),
                {},
            )
        self.assertEqual(authorized["statusCode"], 200)
        inspect.assert_called_once_with(body)

    def test_inspect_is_outside_undo_and_commit_restore_have_specific_labels(self):
        inspect = controller._undo_label(
            "POST", "/api/editor/visual-parameters/inspect", {}
        )
        commit = controller._undo_label(
            "POST",
            "/api/editor/visual-parameters/commit",
            {"scope_path": "/project1"},
        )
        with mock.patch.object(
            controller.visual_parameter_tuning_service,
            "restore_undo_label",
            return_value="MCP restore enhance_build visual parameters /project1",
        ):
            restore = controller._undo_label(
                "POST",
                "/api/editor/visual-parameters/restore",
                {"restore_token": "r" * 43},
            )
        self.assertIsNone(inspect)
        self.assertEqual(commit, "MCP enhance_build visual parameters /project1")
        self.assertEqual(
            restore, "MCP restore enhance_build visual parameters /project1"
        )

    def test_visual_interaction_copy_is_server_derived(self):
        target = {
            "expected_fingerprint": "a" * 64,
            "proposal_digest": "b" * 64,
            "changes": [{"target_id": "t1", "value": 0.75}],
        }
        descriptor = {
            "target_fingerprint": "c" * 64,
            "title": "Apply visual critique changes?",
            "prompt": "server-derived exact values",
        }
        with mock.patch.object(
            controller.visual_parameter_tuning_service,
            "build_interaction_request",
            return_value=descriptor,
        ), mock.patch.object(
            controller.interaction_service,
            "create_interaction",
            return_value={"state": "pending"},
        ) as create:
            result = controller._route(
                "POST",
                "/api/interactions",
                {},
                {"kind": "visual_parameter_apply", "target": target},
            )
        self.assertEqual(result["state"], "pending")
        self.assertEqual(create.call_args.kwargs["choices"], ("Apply", "Keep"))
        self.assertEqual(create.call_args.kwargs["prompt"], descriptor["prompt"])

    def test_visual_body_limit_is_64_kib(self):
        self.assertEqual(
            controller._bounded_body_limit(
                "POST", "/api/editor/visual-parameters/commit"
            ),
            64 * 1024,
        )


if __name__ == "__main__":
    unittest.main()
