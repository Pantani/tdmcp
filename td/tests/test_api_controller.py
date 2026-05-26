"""Unit tests for the tdmcp bridge HTTP router.

The bridge normally runs inside TouchDesigner, where `td`, `op`, `app` and the
operator classes are injected globals. To exercise the router's pure logic —
auth, the arbitrary-code gate, request parsing, path decoding and route
dispatch — off-TD, we install a stub `td` module before importing the package
and replace the service layer with recorders for dispatch assertions.

Run from the repo root: `python3 -m unittest discover -s td/tests`
(or `npm run test:bridge`). No third-party dependencies — stdlib only.
"""

import os
import sys
import types
import unittest
from unittest import mock

# --- Make the bridge importable without TouchDesigner --------------------------
_HERE = os.path.dirname(os.path.abspath(__file__))
_MODULES = os.path.abspath(os.path.join(_HERE, "..", "modules"))
if _MODULES not in sys.path:
    sys.path.insert(0, _MODULES)

# `mcp.services.*` bind `op/app/project` from `td` at import time; a stub suffices.
_td_stub = types.ModuleType("td")
_td_stub.op = mock.MagicMock(name="op")
_td_stub.app = mock.MagicMock(name="app")
_td_stub.project = mock.MagicMock(name="project")
sys.modules.setdefault("td", _td_stub)

from mcp.controllers import api_controller as ac  # noqa: E402


def _clear_exec_env():
    os.environ.pop("TDMCP_BRIDGE_ALLOW_EXEC", None)


def _clear_token_env():
    os.environ.pop("TDMCP_BRIDGE_TOKEN", None)


class AuthTests(unittest.TestCase):
    def tearDown(self):
        _clear_token_env()

    def test_no_token_means_auth_off(self):
        _clear_token_env()
        # Should not raise even with no Authorization header.
        ac._check_auth({"method": "GET"})

    def test_valid_bearer_token_passes(self):
        os.environ["TDMCP_BRIDGE_TOKEN"] = "s3cret"
        ac._check_auth({"Authorization": "Bearer s3cret"})

    def test_invalid_token_raises(self):
        os.environ["TDMCP_BRIDGE_TOKEN"] = "s3cret"
        with self.assertRaises(PermissionError):
            ac._check_auth({"Authorization": "Bearer wrong"})

    def test_missing_header_raises_when_token_required(self):
        os.environ["TDMCP_BRIDGE_TOKEN"] = "s3cret"
        with self.assertRaises(PermissionError):
            ac._check_auth({"method": "GET"})

    def test_header_lookup_is_case_insensitive_and_nested(self):
        os.environ["TDMCP_BRIDGE_TOKEN"] = "s3cret"
        # Header nested under a 'headers' dict with odd casing — must still match.
        ac._check_auth({"headers": {"authorization": "Bearer s3cret"}})


class ExecGateTests(unittest.TestCase):
    def tearDown(self):
        _clear_exec_env()
        _clear_token_env()

    def test_allowed_by_default(self):
        _clear_exec_env()
        self.assertTrue(ac._exec_allowed())

    def test_disabled_values(self):
        for value in ("0", "false", "FALSE", "no", "off", " Off "):
            os.environ["TDMCP_BRIDGE_ALLOW_EXEC"] = value
            self.assertFalse(ac._exec_allowed(), value)

    def test_enabled_values(self):
        for value in ("1", "true", "yes", "on", "", "anything"):
            os.environ["TDMCP_BRIDGE_ALLOW_EXEC"] = value
            self.assertTrue(ac._exec_allowed(), value)

    def test_route_blocks_exec_when_disabled(self):
        os.environ["TDMCP_BRIDGE_ALLOW_EXEC"] = "0"
        with self.assertRaises(PermissionError):
            ac._route("POST", "/api/exec", {}, {"script": "print(1)"})

    def test_route_blocks_node_method_when_disabled(self):
        os.environ["TDMCP_BRIDGE_ALLOW_EXEC"] = "0"
        with self.assertRaises(PermissionError):
            ac._route("POST", "/api/nodes/project1/geo1/method", {}, {"method": "cook"})


class RoutingTests(unittest.TestCase):
    """Dispatch logic, with the service layer swapped for recorders."""

    def setUp(self):
        _clear_exec_env()
        self._saved = {
            "api": ac.api_service,
            "batch": ac.batch_service,
            "analysis": ac.analysis_service,
            "preview": ac.preview_service,
        }
        ac.api_service = mock.MagicMock(name="api_service")
        ac.batch_service = mock.MagicMock(name="batch_service")
        ac.analysis_service = mock.MagicMock(name="analysis_service")
        ac.preview_service = mock.MagicMock(name="preview_service")

    def tearDown(self):
        ac.api_service = self._saved["api"]
        ac.batch_service = self._saved["batch"]
        ac.analysis_service = self._saved["analysis"]
        ac.preview_service = self._saved["preview"]

    def test_get_info(self):
        ac._route("GET", "/api/info", {}, {})
        ac.api_service.get_info.assert_called_once_with()

    def test_create_node(self):
        ac._route("POST", "/api/nodes", {}, {"parent_path": "/project1", "type": "noiseTOP"})
        ac.api_service.create_node.assert_called_once()
        self.assertEqual(ac.api_service.create_node.call_args.args[0], "/project1")
        self.assertEqual(ac.api_service.create_node.call_args.args[1], "noiseTOP")

    def test_list_nodes_uses_parent_query(self):
        ac._route("GET", "/api/nodes", {"parent": ["/project1"]}, {})
        ac.api_service.get_nodes.assert_called_once_with("/project1")

    def test_exec_dispatch_when_allowed(self):
        ac._route("POST", "/api/exec", {}, {"script": "x=1", "return_output": False})
        ac.api_service.exec_script.assert_called_once_with("x=1", False)

    def test_batch_dispatch(self):
        ops = [{"action": "create", "parent_path": "/p", "type": "noiseTOP"}]
        ac._route("POST", "/api/batch", {}, {"operations": ops})
        ac.batch_service.run.assert_called_once_with(ops)

    def test_node_get_patch_delete(self):
        ac._route("GET", "/api/nodes/project1/noise1", {}, {})
        ac.api_service.get_node.assert_called_once_with("/project1/noise1")

        ac._route("PATCH", "/api/nodes/project1/noise1", {}, {"parameters": {"period": 4}})
        ac.api_service.update_parameters.assert_called_once_with("/project1/noise1", {"period": 4})

        ac._route("DELETE", "/api/nodes/project1/noise1", {}, {})
        ac.api_service.delete_node.assert_called_once_with("/project1/noise1")

    def test_node_method_dispatch(self):
        ac._route(
            "POST",
            "/api/nodes/project1/geo1/method",
            {},
            {"method": "cook", "args": [1], "kwargs": {"force": True}},
        )
        ac.api_service.call_method.assert_called_once_with("/project1/geo1", "cook", [1], {"force": True})

    def test_node_errors_dispatch(self):
        ac._route("GET", "/api/nodes/project1/geo1/errors", {}, {})
        ac.api_service.get_node_errors.assert_called_once_with("/project1/geo1", recursive=False)

    def test_preview_dispatch_with_dimensions(self):
        ac._route("GET", "/api/preview/project1/out1", {"width": ["800"], "height": ["600"]}, {})
        ac.preview_service.capture.assert_called_once_with("/project1/out1", 800, 600)

    def test_network_topology_dispatch(self):
        ac._route("GET", "/api/network/project1/topology", {"recursive": ["true"]}, {})
        ac.analysis_service.topology.assert_called_once_with("/project1", recursive=True)

    def test_unknown_route_raises(self):
        with self.assertRaises(ValueError):
            ac._route("GET", "/api/does-not-exist", {}, {})


class ParsingTests(unittest.TestCase):
    def test_parse_body_variants(self):
        self.assertEqual(ac._parse_body({"data": ""}), {})
        self.assertEqual(ac._parse_body({"data": None}), {})
        self.assertEqual(ac._parse_body({"data": '{"a": 1}'}), {"a": 1})
        self.assertEqual(ac._parse_body({"data": b'{"b": 2}'}), {"b": 2})
        self.assertEqual(ac._parse_body({"data": {"c": 3}}), {"c": 3})

    def test_node_path_rejoins_and_restores_leading_slash(self):
        self.assertEqual(ac._node_path(["project1", "noise1"]), "/project1/noise1")
        # Percent-encoded segment decodes back to a slash-bearing path.
        self.assertEqual(ac._node_path(["project1%2Fgeo1"]), "/project1/geo1")

    def test_qs_returns_first_or_default(self):
        self.assertEqual(ac._qs({"k": ["v1", "v2"]}, "k"), "v1")
        self.assertEqual(ac._qs({}, "missing", "fallback"), "fallback")

    def test_find_header_top_level_and_default(self):
        self.assertEqual(ac._find_header({"X-Token": "abc"}, "x-token"), "abc")
        self.assertIsNone(ac._find_header({"other": "v"}, "x-token"))


class HandleTests(unittest.TestCase):
    def tearDown(self):
        _clear_exec_env()
        _clear_token_env()

    def _resp(self):
        return {}

    def test_ok_envelope(self):
        with mock.patch.object(ac, "_route", return_value={"hello": "world"}):
            resp = ac.handle({"method": "GET", "uri": "/api/info"}, self._resp())
        self.assertEqual(resp["statusCode"], 200)
        self.assertIn('"ok": true', resp["data"])
        self.assertIn("world", resp["data"])

    def test_auth_failure_is_401(self):
        os.environ["TDMCP_BRIDGE_TOKEN"] = "s3cret"
        resp = ac.handle({"method": "GET", "uri": "/api/info"}, self._resp())
        self.assertEqual(resp["statusCode"], 401)
        self.assertIn('"ok": false', resp["data"])

    def test_error_is_400(self):
        with mock.patch.object(ac, "_route", side_effect=ValueError("boom")):
            resp = ac.handle({"method": "GET", "uri": "/api/info"}, self._resp())
        self.assertEqual(resp["statusCode"], 400)
        self.assertIn("boom", resp["data"])

    def test_exec_disabled_surfaces_as_401_with_message(self):
        os.environ["TDMCP_BRIDGE_ALLOW_EXEC"] = "0"
        resp = ac.handle(
            {"method": "POST", "uri": "/api/exec", "data": '{"script": "1"}'}, self._resp()
        )
        self.assertEqual(resp["statusCode"], 401)
        self.assertIn("disabled", resp["data"])


if __name__ == "__main__":
    unittest.main()
