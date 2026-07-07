"""Unit tests for the tdmcp bridge HTTP router.

The bridge normally runs inside TouchDesigner, where `td`, `op`, `app` and the
operator classes are injected globals. To exercise the router's pure logic —
auth, the arbitrary-code gate, request parsing, path decoding and route
dispatch — off-TD, we install a stub `td` module before importing the package
and replace the service layer with recorders for dispatch assertions.

Run from the repo root: `python3 -m unittest discover -s td/tests`
(or `npm run test:bridge`). No third-party dependencies — stdlib only.
"""

import json
import os
import sys
import time
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

    def test_disabled_by_default_without_token_or_explicit_opt_in(self):
        _clear_exec_env()
        _clear_token_env()
        self.assertFalse(ac._exec_allowed())

    def test_token_enables_exec_by_default_for_authenticated_bridge(self):
        _clear_exec_env()
        os.environ["TDMCP_BRIDGE_TOKEN"] = "s3cret"
        self.assertTrue(ac._exec_allowed())

    def test_disabled_values(self):
        for value in ("0", "false", "FALSE", "no", "off", " Off ", "", "anything"):
            os.environ["TDMCP_BRIDGE_ALLOW_EXEC"] = value
            self.assertFalse(ac._exec_allowed(), value)

    def test_enabled_values(self):
        for value in ("1", "true", "yes", "on", " On "):
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


def _clear_quarantine_env():
    os.environ.pop("TDMCP_PROJECT_RAG_QUARANTINE", None)


class QuarantineLoadGateTests(unittest.TestCase):
    """`POST /api/project/load` is default-DENY: opening a .toe/.tox replaces the
    running project, so only a bridge explicitly marked as a throwaway quarantine
    instance (TDMCP_PROJECT_RAG_QUARANTINE) may honor it — regardless of
    TDMCP_BRIDGE_ALLOW_EXEC."""

    def setUp(self):
        _clear_quarantine_env()

    def tearDown(self):
        _clear_quarantine_env()

    def test_disabled_by_default(self):
        self.assertFalse(ac._quarantine_load_enabled())

    def test_enabled_values(self):
        for value in ("1", "true", "YES", "on", " On "):
            os.environ["TDMCP_PROJECT_RAG_QUARANTINE"] = value
            self.assertTrue(ac._quarantine_load_enabled(), value)

    def test_disabled_values(self):
        for value in ("0", "false", "no", "off", "", "maybe"):
            os.environ["TDMCP_PROJECT_RAG_QUARANTINE"] = value
            self.assertFalse(ac._quarantine_load_enabled(), value)

    def test_route_blocks_load_when_not_quarantine(self):
        # Even with exec enabled, a non-quarantine bridge refuses the load route.
        with self.assertRaises(PermissionError):
            ac._route("POST", "/api/project/load", {}, {"path": "/x.toe"})

    def test_route_dispatches_load_when_quarantine(self):
        os.environ["TDMCP_PROJECT_RAG_QUARANTINE"] = "1"
        saved = ac.project_load_service
        ac.project_load_service = mock.MagicMock(name="project_load_service")
        try:
            ac._route("POST", "/api/project/load", {}, {"path": "/x.toe", "timeout_ms": 5000})
            ac.project_load_service.load.assert_called_once_with("/x.toe", 5000)
        finally:
            ac.project_load_service = saved


class RoutingTests(unittest.TestCase):
    """Dispatch logic, with the service layer swapped for recorders."""

    def setUp(self):
        _clear_exec_env()
        self._saved = {
            "api": ac.api_service,
            "batch": ac.batch_service,
            "analysis": ac.analysis_service,
            "preview": ac.preview_service,
            "editor": ac.editor_service,
        }
        self._saved["watch"] = ac.watch_service
        ac.api_service = mock.MagicMock(name="api_service")
        ac.batch_service = mock.MagicMock(name="batch_service")
        ac.analysis_service = mock.MagicMock(name="analysis_service")
        ac.preview_service = mock.MagicMock(name="preview_service")
        ac.editor_service = mock.MagicMock(name="editor_service")
        ac.watch_service = mock.MagicMock(name="watch_service")

    def tearDown(self):
        ac.api_service = self._saved["api"]
        ac.batch_service = self._saved["batch"]
        ac.analysis_service = self._saved["analysis"]
        ac.preview_service = self._saved["preview"]
        ac.editor_service = self._saved["editor"]
        ac.watch_service = self._saved["watch"]

    def test_get_info(self):
        ac._route("GET", "/api/info", {}, {})
        ac.api_service.get_info.assert_called_once_with()

    def test_get_health(self):
        webserver = object()
        ac._route("GET", "/api/health", {}, {}, webserver)
        ac.api_service.get_health.assert_called_once_with(webserver)

    def test_create_node(self):
        ac._route("POST", "/api/nodes", {}, {"parent_path": "/project1", "type": "noiseTOP"})
        ac.api_service.create_node.assert_called_once()
        self.assertEqual(ac.api_service.create_node.call_args.args[0], "/project1")
        self.assertEqual(ac.api_service.create_node.call_args.args[1], "noiseTOP")

    def test_list_nodes_uses_parent_query(self):
        ac._route("GET", "/api/nodes", {"parent": ["/project1"]}, {})
        ac.api_service.get_nodes.assert_called_once_with("/project1")

    def test_exec_dispatch_when_allowed(self):
        os.environ["TDMCP_BRIDGE_ALLOW_EXEC"] = "1"
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
        ac.api_service.delete_node.assert_called_once_with("/project1/noise1", "delete")

    def test_node_delete_bypass_mode(self):
        ac._route("DELETE", "/api/nodes/project1/noise1", {"mode": ["bypass"]}, {})
        ac.api_service.delete_node.assert_called_once_with("/project1/noise1", "bypass")

    def test_node_method_dispatch(self):
        os.environ["TDMCP_BRIDGE_ALLOW_EXEC"] = "1"
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

    def test_preview_sample_grid_dispatch(self):
        ac._route("GET", "/api/preview/project1/out1", {"sample_grid": ["8"]}, {})
        ac.preview_service.sample_grid.assert_called_once_with("/project1/out1", 8)
        ac.preview_service.capture.assert_not_called()

    def test_preview_post_advanced_dispatch(self):
        body = {
            "width": 320,
            "height": 180,
            "pre_pulses": [{"path": "/project1/fb", "par": "Reset"}],
            "delay_frames": 6,
        }
        ac._route("POST", "/api/preview/project1/out1", {}, body)
        ac.preview_service.capture_advanced.assert_called_once_with(
            "/project1/out1",
            width=320,
            height=180,
            pre_pulses=[{"path": "/project1/fb", "par": "Reset"}],
            delay_frames=6,
            sample_grid_n=None,
        )

    def test_preview_job_collect_dispatch(self):
        ac._route("GET", "/api/preview_job/abc123", {}, {})
        ac.preview_service.collect_preview_job.assert_called_once_with("abc123")

    def test_editor_focus_dispatch(self):
        ac._route("POST", "/api/editor/focus", {}, {"paths": ["/project1/noise1"], "animate": True})
        ac.editor_service.focus.assert_called_once_with(["/project1/noise1"], True)

    def test_watch_register_dispatch(self):
        # Registration routes straight to watch_service; the onFrameEnd poller (not
        # a DAT installed here) is what later emits the events.
        ac._route("POST", "/api/params/watch", {}, {"path": "/project1/level1", "pars": ["opacity"]})
        ac.watch_service.register.assert_called_once_with("/project1/level1", ["opacity"])

    def test_watch_register_survives_exec_disabled(self):
        os.environ["TDMCP_BRIDGE_ALLOW_EXEC"] = "0"
        ac._route("POST", "/api/params/watch", {}, {"path": "/project1/level1"})
        ac.watch_service.register.assert_called_once_with("/project1/level1", None)

    def test_watch_unregister_dispatch(self):
        ac._route("DELETE", "/api/params/watch", {}, {"path": "/project1/level1"})
        ac.watch_service.unregister.assert_called_once_with("/project1/level1", None)

    def test_watch_list_dispatch(self):
        ac._route("GET", "/api/params/watch", {}, {})
        ac.watch_service.list_watches.assert_called_once_with()

    def test_watch_register_missing_path_raises(self):
        with self.assertRaises(ValueError) as cm:
            ac._route("POST", "/api/params/watch", {}, {})
        self.assertIn("path", str(cm.exception))

    def test_network_topology_dispatch(self):
        ac._route("GET", "/api/network/project1/topology", {"recursive": ["true"]}, {})
        ac.analysis_service.topology.assert_called_once_with("/project1", recursive=True)

    def test_unknown_route_raises(self):
        with self.assertRaises(ValueError):
            ac._route("GET", "/api/does-not-exist", {}, {})

    def test_create_node_missing_fields_raises_descriptive(self):
        with self.assertRaises(ValueError) as cm:
            ac._route("POST", "/api/nodes", {}, {})
        self.assertIn("parent_path", str(cm.exception))
        self.assertIn("type", str(cm.exception))

    def test_exec_missing_script_raises_descriptive(self):
        os.environ["TDMCP_BRIDGE_ALLOW_EXEC"] = "1"
        with self.assertRaises(ValueError) as cm:
            ac._route("POST", "/api/exec", {}, {})
        self.assertIn("script", str(cm.exception))


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

    def test_find_header_accepts_list_value(self):
        # A repeated/multi-value header may arrive as a list; take the first str.
        self.assertEqual(ac._find_header({"Origin": ["http://x", "http://y"]}, "origin"), "http://x")
        self.assertIsNone(ac._find_header({"Origin": []}, "origin"))
        self.assertIsNone(ac._find_header({"Origin": [123]}, "origin"))


class OriginTests(unittest.TestCase):
    """The Origin guard blocks browser-driven CSRF / DNS-rebinding."""

    def test_no_origin_is_allowed(self):
        ac._check_origin({"method": "GET"})  # the Node client sends no Origin

    def test_loopback_origins_allowed(self):
        for origin in (
            "http://127.0.0.1:9980",
            "http://localhost",
            "https://localhost:3000",
            "http://[::1]:9980",
        ):
            ac._check_origin({"Origin": origin})  # must not raise

    def test_cross_origin_rejected(self):
        for origin in ("http://evil.com", "https://attacker.example:8443", "http://192.168.1.5"):
            with self.assertRaises(PermissionError, msg=origin):
                ac._check_origin({"Origin": origin})

    def test_opaque_null_origin_rejected(self):
        with self.assertRaises(PermissionError):
            ac._check_origin({"Origin": "null"})

    def test_origin_lookup_is_case_insensitive_and_nested(self):
        with self.assertRaises(PermissionError):
            ac._check_origin({"headers": {"origin": "http://evil.com"}})

    def test_handle_rejects_cross_origin_with_403(self):
        resp = ac.handle({"method": "GET", "uri": "/api/info", "Origin": "http://evil.com"}, {})
        self.assertEqual(resp["statusCode"], 403)
        self.assertIn("cross-origin", resp["data"])

    def test_handle_rejects_list_valued_cross_origin(self):
        # Some TD builds surface a header as a list; it must not slip the guard.
        resp = ac.handle({"method": "GET", "uri": "/api/info", "Origin": ["http://evil.com"]}, {})
        self.assertEqual(resp["statusCode"], 403)
        self.assertIn("cross-origin", resp["data"])


class HostTests(unittest.TestCase):
    """The Host guard closes the DNS-rebinding gap when auth is off."""

    def tearDown(self):
        _clear_token_env()

    def test_no_host_is_allowed(self):
        _clear_token_env()
        ac._check_host({"method": "GET"})  # missing Host header must not raise

    def test_loopback_hosts_allowed(self):
        _clear_token_env()
        for host in ("127.0.0.1:9980", "localhost", "localhost:9980", "[::1]:9980"):
            ac._check_host({"Host": host})  # must not raise

    def test_non_loopback_host_rejected_when_auth_off(self):
        _clear_token_env()
        for host in ("evil.com", "evil.com:9980", "192.168.1.5:9980"):
            with self.assertRaises(PermissionError, msg=host):
                ac._check_host({"Host": host})

    def test_userinfo_smuggled_loopback_host_rejected(self):
        # A forged Host that parses to a loopback hostname only because of
        # userinfo/path syntax must NOT slip the guard.
        _clear_token_env()
        for host in (
            "evil.com@127.0.0.1",
            "127.0.0.1/evil",
            "127.0.0.1@evil.com",
            "127.0.0.1:9980/x",
            "127.0.0.1\r\nHost: evil.com",
            "127.0.0.1\tevil",
        ):
            with self.assertRaises(PermissionError, msg=host):
                ac._check_host({"Host": host})

    def test_non_loopback_host_allowed_when_token_set(self):
        # Authenticated remote use is documented; the token is the gate, so a
        # LAN/remote Host must pass once a token is configured.
        os.environ["TDMCP_BRIDGE_TOKEN"] = "s3cret"
        ac._check_host({"Host": "192.168.1.5:9980"})  # must not raise

    def test_host_lookup_is_case_insensitive_and_nested(self):
        _clear_token_env()
        with self.assertRaises(PermissionError):
            ac._check_host({"headers": {"host": "evil.com"}})

    def test_handle_rejects_non_loopback_host_with_403(self):
        _clear_token_env()
        resp = ac.handle(
            {"method": "GET", "uri": "/api/info", "Host": "evil.com"}, {}
        )
        self.assertEqual(resp["statusCode"], 403)
        self.assertIn("Host", resp["data"])


def _clear_lan_env():
    os.environ.pop("TDMCP_BRIDGE_ALLOW_LAN", None)


class AddressScopeTests(unittest.TestCase):
    """P2-1: loopback-only address scope. Off-host peers are rejected at the
    earliest point unless TDMCP_BRIDGE_ALLOW_LAN opts into LAN exposure."""

    def tearDown(self):
        _clear_lan_env()
        _clear_token_env()

    def test_lan_exposure_disabled_by_default(self):
        _clear_lan_env()
        self.assertFalse(ac._lan_exposure_enabled())

    def test_lan_exposure_enabled_values(self):
        for value in ("1", "true", "yes", "on", " On "):
            os.environ["TDMCP_BRIDGE_ALLOW_LAN"] = value
            self.assertTrue(ac._lan_exposure_enabled(), value)

    def test_lan_exposure_disabled_values(self):
        for value in ("0", "false", "no", "off", "", "anything"):
            os.environ["TDMCP_BRIDGE_ALLOW_LAN"] = value
            self.assertFalse(ac._lan_exposure_enabled(), value)

    def test_no_peer_address_is_allowed(self):
        # Older builds surface no peer address; header guards apply instead.
        _clear_lan_env()
        ac._check_address_scope({"method": "GET"})  # must not raise

    def test_loopback_peers_allowed(self):
        _clear_lan_env()
        for addr in ("127.0.0.1", "::1", "[::1]", "::ffff:127.0.0.1", "localhost"):
            ac._check_address_scope({"clientAddress": addr})  # must not raise

    def test_loopback_peer_with_port_allowed(self):
        _clear_lan_env()
        for addr in ("127.0.0.1:53512", "::1"):
            ac._check_address_scope({"clientAddress": addr})

    def test_off_host_peer_rejected(self):
        _clear_lan_env()
        for addr in ("192.168.1.5", "10.0.0.9", "203.0.113.7", "::ffff:8.8.8.8"):
            with self.assertRaises(PermissionError, msg=addr):
                ac._check_address_scope({"clientAddress": addr})

    def test_off_host_peer_rejected_even_with_token(self):
        # Address scope is independent of the bearer token: binding all interfaces
        # without an explicit LAN opt-in is refused regardless of auth.
        _clear_lan_env()
        os.environ["TDMCP_BRIDGE_TOKEN"] = "s3cret"
        with self.assertRaises(PermissionError):
            ac._check_address_scope({"clientAddress": "192.168.1.5"})

    def test_off_host_peer_allowed_when_lan_opted_in(self):
        os.environ["TDMCP_BRIDGE_ALLOW_LAN"] = "1"
        ac._check_address_scope({"clientAddress": "192.168.1.5"})  # must not raise

    def test_peer_address_lookup_is_nested(self):
        _clear_lan_env()
        with self.assertRaises(PermissionError):
            ac._check_address_scope({"meta": {"remote_address": "192.168.1.5"}})

    def test_handle_rejects_off_host_peer_with_403(self):
        _clear_lan_env()
        resp = ac.handle(
            {"method": "GET", "uri": "/api/info", "clientAddress": "192.168.1.5"}, {}
        )
        self.assertEqual(resp["statusCode"], 403)
        self.assertIn("off-host", resp["data"])

    def test_normalize_address_forms(self):
        self.assertEqual(ac._normalize_address("::ffff:127.0.0.1"), "127.0.0.1")
        self.assertEqual(ac._normalize_address("[::1]"), "::1")
        self.assertEqual(ac._normalize_address("[::1]:9980"), "::1")
        self.assertEqual(ac._normalize_address("fe80::1%en0"), "fe80::1")
        self.assertEqual(ac._normalize_address("127.0.0.1:9980"), "127.0.0.1")
        self.assertIsNone(ac._normalize_address(""))
        self.assertIsNone(ac._normalize_address(None))

    def test_bracketed_ipv6_loopback_with_port_allowed(self):
        # A bracketed IPv6 loopback with a port (`[::1]:9980`) must normalize to
        # the bare loopback host, not be rejected by a naive strip("[]").
        _clear_lan_env()
        for addr in ("[::1]", "[::1]:9980"):
            ac._check_address_scope({"clientAddress": addr})  # must not raise

    def test_alias_key_off_host_still_rejected(self):
        # A non-loopback address supplied under an ALIAS key (remoteAddress) is a
        # real peer address, not a bypass: off-host input is still rejected when
        # TDMCP_BRIDGE_ALLOW_LAN is unset.
        _clear_lan_env()
        for key in ("remoteAddress", "peerAddress", "remote_address"):
            with self.assertRaises(PermissionError, msg=key):
                ac._check_address_scope({key: "192.168.1.5"})

    def test_header_map_clientaddress_not_trusted(self):
        # HTTP header maps are attacker-controlled. A spoofed loopback address under
        # headers/header/fields must NOT be treated as the peer address — otherwise a
        # remote client could inject `clientAddress: 127.0.0.1` to bypass the gate.
        for container in ("headers", "header", "fields"):
            self.assertIsNone(
                ac._client_address({container: {"clientAddress": "127.0.0.1"}}),
                msg=container,
            )


class HandleTests(unittest.TestCase):
    def tearDown(self):
        _clear_exec_env()
        _clear_token_env()

    def _resp(self):
        return {}

    def test_ok_envelope(self):
        _clear_token_env()
        with mock.patch.object(ac, "_route", return_value={"hello": "world"}):
            resp = ac.handle(
                {"method": "GET", "uri": "/api/info", "Host": "127.0.0.1:9980"}, self._resp()
            )
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

    def test_exec_disabled_surfaces_as_403_with_message(self):
        os.environ["TDMCP_BRIDGE_ALLOW_EXEC"] = "0"
        resp = ac.handle(
            {"method": "POST", "uri": "/api/exec", "data": '{"script": "1"}'}, self._resp()
        )
        self.assertEqual(resp["statusCode"], 403)
        self.assertIn("disabled", resp["data"])

    def test_missing_required_field_surfaces_as_400_with_name(self):
        # A POST with valid JSON but a missing field gets a descriptive 400,
        # not a bare KeyError message of just the key name.
        resp = ac.handle({"method": "POST", "uri": "/api/nodes", "data": "{}"}, self._resp())
        self.assertEqual(resp["statusCode"], 400)
        self.assertIn("parent_path", resp["data"])
        self.assertIn("Missing required field", resp["data"])


class BackpressureTests(unittest.TestCase):
    def setUp(self):
        ac._BACKPRESSURE["cooldown_until"] = 0.0

    def tearDown(self):
        ac._BACKPRESSURE["cooldown_until"] = 0.0
        os.environ.pop("TDMCP_SLOW_THRESHOLD_MS", None)
        os.environ.pop("TDMCP_COOLDOWN_MS", None)

    def _resp(self):
        return {}

    def test_slow_request_arms_cooldown_and_next_request_gets_503(self):
        os.environ["TDMCP_SLOW_THRESHOLD_MS"] = "1"  # anything cooks "slow"
        os.environ["TDMCP_COOLDOWN_MS"] = "5000"

        def _slow_route(*_a, **_k):
            time.sleep(0.005)  # 5ms > 1ms threshold
            return {"ok": 1}

        with mock.patch.object(ac, "_route", _slow_route):
            first = ac.handle({"method": "GET", "uri": "/api/info"}, self._resp())
        self.assertEqual(first["statusCode"], 200)
        # The next request is shed with 503 + retry_after.
        second = ac.handle({"method": "GET", "uri": "/api/info"}, self._resp())
        self.assertEqual(second["statusCode"], 503)
        payload = json.loads(second["data"])
        self.assertEqual(payload["error"]["code"], "backpressure")
        self.assertGreaterEqual(payload["error"]["retry_after"], 1)

    def test_fast_requests_never_trip_the_gate(self):
        with mock.patch.object(ac, "_route", return_value={"ok": 1}):
            r1 = ac.handle({"method": "GET", "uri": "/api/info"}, self._resp())
            r2 = ac.handle({"method": "GET", "uri": "/api/info"}, self._resp())
        self.assertEqual(r1["statusCode"], 200)
        self.assertEqual(r2["statusCode"], 200)


class UndoBlockTests(unittest.TestCase):
    def tearDown(self):
        _clear_exec_env()
        _clear_token_env()

    def _resp(self):
        return {}

    def test_mutating_request_is_wrapped_in_a_single_undo_block(self):
        ui = mock.MagicMock(name="ui")
        with mock.patch.object(ac, "_get_ui", return_value=ui), mock.patch.object(
            ac, "_route", return_value={"path": "/project1/noise1"}
        ):
            ac.handle(
                {"method": "POST", "uri": "/api/nodes", "data": '{"parent_path":"/p","type":"noiseTOP"}'},
                self._resp(),
            )
        ui.undo.startBlock.assert_called_once()
        (label,), _ = ui.undo.startBlock.call_args
        self.assertTrue(label.startswith("MCP POST /api/nodes"))
        ui.undo.endBlock.assert_called_once()

    def test_endblock_runs_even_when_the_route_raises(self):
        ui = mock.MagicMock(name="ui")
        with mock.patch.object(ac, "_get_ui", return_value=ui), mock.patch.object(
            ac, "_route", side_effect=ValueError("boom")
        ):
            resp = ac.handle({"method": "DELETE", "uri": "/api/nodes/p/x"}, self._resp())
        self.assertEqual(resp["statusCode"], 400)
        ui.undo.startBlock.assert_called_once()
        ui.undo.endBlock.assert_called_once()  # finally guarantees the block closes

    def test_read_only_get_is_not_wrapped(self):
        ui = mock.MagicMock(name="ui")
        with mock.patch.object(ac, "_get_ui", return_value=ui), mock.patch.object(
            ac, "_route", return_value={"ok": 1}
        ):
            ac.handle({"method": "GET", "uri": "/api/info"}, self._resp())
        ui.undo.startBlock.assert_not_called()

    def test_missing_ui_does_not_break_a_mutating_request(self):
        with mock.patch.object(ac, "_get_ui", return_value=None), mock.patch.object(
            ac, "_route", return_value={"path": "/p/x"}
        ):
            resp = ac.handle(
                {"method": "POST", "uri": "/api/nodes", "data": '{"parent_path":"/p","type":"noiseTOP"}'},
                self._resp(),
            )
        self.assertEqual(resp["statusCode"], 200)

    def test_undo_label_classifies_reads_and_writes(self):
        self.assertIsNone(ac._undo_label("GET", "/api/nodes"))
        self.assertIsNone(ac._undo_label("POST", "/api/param_modes/batch"))
        self.assertIsNotNone(ac._undo_label("POST", "/api/nodes"))
        self.assertIsNotNone(ac._undo_label("PATCH", "/api/nodes/p/x"))
        self.assertIsNotNone(ac._undo_label("DELETE", "/api/nodes/p/x"))


class StructuredEndpointTests(unittest.TestCase):
    """The 0.6.0 structured routes dispatch correctly AND are NOT behind the exec
    gate — they must keep working with TDMCP_BRIDGE_ALLOW_EXEC=0. Exec is disabled
    for every test here, so a passing dispatch also proves exec-gate survival."""

    def setUp(self):
        os.environ["TDMCP_BRIDGE_ALLOW_EXEC"] = "0"  # the routes below must ignore this
        self._saved = {
            "connect": ac.connect_service,
            "log": ac.log_service,
            "param_text": ac.param_text_service,
            "api": ac.api_service,
            "transport": ac.transport_service,
            "system": ac.system_service,
            "project_analysis": ac.project_analysis_service,
            "custom_params": ac.custom_params_service,
        }
        ac.connect_service = mock.MagicMock(name="connect_service")
        ac.log_service = mock.MagicMock(name="log_service")
        ac.param_text_service = mock.MagicMock(name="param_text_service")
        ac.api_service = mock.MagicMock(name="api_service")
        ac.transport_service = mock.MagicMock(name="transport_service")
        ac.system_service = mock.MagicMock(name="system_service")
        ac.custom_params_service = mock.MagicMock(name="custom_params_service")

    def tearDown(self):
        ac.connect_service = self._saved["connect"]
        ac.log_service = self._saved["log"]
        ac.param_text_service = self._saved["param_text"]
        ac.api_service = self._saved["api"]
        ac.transport_service = self._saved["transport"]
        ac.system_service = self._saved["system"]
        ac.project_analysis_service = self._saved["project_analysis"]
        ac.custom_params_service = self._saved["custom_params"]
        _clear_exec_env()

    def test_connect_dispatches_with_exec_disabled(self):
        ac._route(
            "POST",
            "/api/connect",
            {},
            {"source_path": "/p/a", "target_path": "/p/b", "source_output": 1, "target_input": 2},
        )
        ac.connect_service.connect.assert_called_once_with("/p/a", "/p/b", 1, 2)

    def test_disconnect_dispatches_with_exec_disabled(self):
        ac._route(
            "POST",
            "/api/disconnect",
            {},
            {"to_path": "/p/b", "from_path": "/p/a", "to_input": 0},
        )
        ac.connect_service.disconnect.assert_called_once_with("/p/b", "/p/a", 0)

    def test_transport_dispatches_with_exec_disabled(self):
        ac._route(
            "POST",
            "/api/transport",
            {},
            {"action": "seek", "frame": 120},
        )
        ac.transport_service.control.assert_called_once_with(
            "seek", frame=120, rate=None, cue_name=None
        )

    def test_transport_missing_action_raises_descriptive(self):
        with self.assertRaises(ValueError) as cm:
            ac._route("POST", "/api/transport", {}, {})
        self.assertIn("action", str(cm.exception))

    def test_project_analysis_dispatches_with_exec_disabled(self):
        ac.project_analysis_service = mock.MagicMock(name="project_analysis_service")
        ac._route("GET", "/api/projects/project1/sys/analysis", {}, {})
        ac.project_analysis_service.analyze.assert_called_once_with(
            "/project1/sys", recursive=True
        )

    def test_project_analysis_recursive_false_query(self):
        ac.project_analysis_service = mock.MagicMock(name="project_analysis_service")
        ac._route(
            "GET", "/api/projects/project1/analysis", {"recursive": ["false"]}, {}
        )
        ac.project_analysis_service.analyze.assert_called_once_with(
            "/project1", recursive=False
        )

    def test_perform_dispatches_with_exec_disabled(self):
        ac._route("POST", "/api/perform", {}, {"enabled": True})
        ac.system_service.set_perform_mode.assert_called_once_with(True)

    def test_perform_dispatches_with_enabled_false(self):
        ac.system_service = mock.MagicMock(name="system_service")
        ac._route("POST", "/api/perform", {}, {"enabled": False})
        ac.system_service.set_perform_mode.assert_called_once_with(False)

    def test_perform_missing_enabled_raises_descriptive(self):
        with self.assertRaises(ValueError) as cm:
            ac._route("POST", "/api/perform", {}, {})
        self.assertIn("enabled", str(cm.exception))

    def test_perform_rejects_non_bool_string(self):
        # `_as_bool` accepts only canonical bool spellings; arbitrary strings
        # (and non-bool/non-string values) raise ValueError → 400, instead of
        # the old ``bool(value)`` path that silently treated any non-empty
        # string as True.
        with self.assertRaises(ValueError):
            ac._route("POST", "/api/perform", {}, {"enabled": "maybe"})
        with self.assertRaises(ValueError):
            ac._route("POST", "/api/perform", {}, {"enabled": 1.5})

    def test_system_dispatches_with_exec_disabled(self):
        ac._route("GET", "/api/system", {}, {})
        ac.system_service.get_system_info.assert_called_once_with(None)

    def test_system_include_query_parsed_to_list(self):
        ac._route("GET", "/api/system", {"include": ["gpu,monitors"]}, {})
        ac.system_service.get_system_info.assert_called_once_with(["gpu", "monitors"])

    def test_custom_params_dispatches_with_exec_disabled(self):
        ac._route("GET", "/api/nodes/project1/comp1/custom_params", {}, {})
        ac.custom_params_service.get_custom_params.assert_called_once_with("/project1/comp1")

    def test_custom_params_encoded_path_round_trips(self):
        ac._route(
            "GET",
            "/api/nodes/project1/sub/deep/comp/custom_params",
            {},
            {},
        )
        ac.custom_params_service.get_custom_params.assert_called_once_with(
            "/project1/sub/deep/comp"
        )

    def test_logs_dispatches_with_exec_disabled(self):
        ac._route("GET", "/api/logs", {"severity": ["error"], "max_lines": ["50"]}, {})
        ac.log_service.get_logs.assert_called_once()
        args = ac.log_service.get_logs.call_args.args
        self.assertEqual(args[0], "error")
        self.assertEqual(args[1], 50)

    def test_param_modes_read_dispatches_with_exec_disabled(self):
        ac._route(
            "GET",
            "/api/nodes/project1/noise1/params",
            {"modes": ["true"], "keys": ["tx,ty"]},
            {},
        )
        ac.param_text_service.read_param_modes.assert_called_once_with(
            "/project1/noise1", ["tx", "ty"], False
        )

    def test_param_mode_patch_dispatches_with_exec_disabled(self):
        ac._route(
            "PATCH",
            "/api/nodes/project1/noise1/params/tx/mode",
            {},
            {"mode": "expression", "expr": "absTime.seconds"},
        )
        ac.param_text_service.set_param_mode.assert_called_once_with(
            "/project1/noise1", "tx", "expression", "absTime.seconds", None
        )

    def test_dat_text_get_dispatches_with_exec_disabled(self):
        ac.param_text_service.is_dat.return_value = True
        ac._route("GET", "/api/nodes/project1/text1/text", {}, {})
        ac.param_text_service.get_dat_text.assert_called_once_with("/project1/text1")

    def test_dat_text_put_dispatches_with_exec_disabled(self):
        ac._route("PUT", "/api/nodes/project1/text1/text", {}, {"text": "hello"})
        ac.param_text_service.put_dat_text.assert_called_once_with("/project1/text1", "hello")

    def test_exec_is_still_blocked_in_this_mode(self):
        # Sanity: the gate IS active here, so the routes above pass because they are
        # ungated — not because exec happens to be enabled.
        with self.assertRaises(PermissionError):
            ac._route("POST", "/api/exec", {}, {"script": "1"})


if __name__ == "__main__":
    unittest.main()
