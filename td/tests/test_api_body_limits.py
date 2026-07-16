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

from mcp.controllers import api_controller  # noqa: E402


class ApiBodyLimitTests(unittest.TestCase):
    def test_every_json_mutation_gets_a_default_cap(self):
        for method, path in (
            ("POST", "/api/exec"),
            ("POST", "/api/batch"),
            ("POST", "/api/nodes"),
            ("POST", "/api/perform"),
            ("PATCH", "/api/nodes/project1/example"),
            ("DELETE", "/api/nodes/project1/example"),
        ):
            with self.subTest(method=method, path=path):
                self.assertEqual(
                    api_controller._bounded_body_limit(method, path),
                    api_controller.DEFAULT_MUTATION_BODY_LIMIT,
                )

    def test_read_routes_do_not_claim_to_bound_a_nonexistent_body(self):
        self.assertIsNone(api_controller._bounded_body_limit("GET", "/api/info"))

    def test_route_specific_caps_remain_smaller_than_the_default(self):
        self.assertEqual(
            api_controller._bounded_body_limit("POST", "/api/interactions"),
            32 * 1024,
        )
        self.assertEqual(
            api_controller._bounded_body_limit("POST", "/api/editor/reposition"),
            256 * 1024,
        )

    def test_default_cap_rejects_large_text_and_bytes_before_json_decode(self):
        oversized_text = "x" * (api_controller.DEFAULT_MUTATION_BODY_LIMIT + 1)
        oversized_bytes = oversized_text.encode("utf-8")
        for payload in (oversized_text, oversized_bytes):
            with self.subTest(kind=type(payload).__name__):
                with self.assertRaisesRegex(
                    api_controller._PayloadTooLarge, "bounded route limit"
                ):
                    api_controller._parse_body(
                        {"data": payload}, api_controller.DEFAULT_MUTATION_BODY_LIMIT
                    )

    def test_predecoded_object_is_subject_to_the_same_byte_cap(self):
        with self.assertRaises(api_controller._PayloadTooLarge):
            api_controller._parse_body(
                {"data": {"value": "é" * api_controller.DEFAULT_MUTATION_BODY_LIMIT}},
                api_controller.DEFAULT_MUTATION_BODY_LIMIT,
            )

    def test_handle_enforces_auth_before_size_and_returns_413_after_auth(self):
        oversized = "x" * (api_controller.DEFAULT_MUTATION_BODY_LIMIT + 1)
        os.environ["TDMCP_BRIDGE_TOKEN"] = "body-limit-test-token"
        try:
            unauthorized = api_controller.handle(
                {"method": "POST", "uri": "/api/batch", "data": oversized}, {}
            )
            self.assertEqual(unauthorized["statusCode"], 401)

            for method, path in (
                ("POST", "/api/exec"),
                ("POST", "/api/batch"),
                ("POST", "/api/nodes"),
                ("POST", "/api/perform"),
                ("PATCH", "/api/nodes/project1/example"),
                ("DELETE", "/api/nodes/project1/example"),
            ):
                with self.subTest(method=method, path=path):
                    response = api_controller.handle(
                        {
                            "method": method,
                            "uri": path,
                            "Authorization": "Bearer body-limit-test-token",
                            "data": oversized,
                        },
                        {},
                    )
                    self.assertEqual(response["statusCode"], 413)
                    self.assertIn('"code": "payload_too_large"', response["data"])
                    self.assertNotIn(oversized[:128], response["data"])
        finally:
            os.environ.pop("TDMCP_BRIDGE_TOKEN", None)


if __name__ == "__main__":
    unittest.main()
