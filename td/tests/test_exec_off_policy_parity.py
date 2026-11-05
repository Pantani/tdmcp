"""Holds the exec-off msw mock to the real bridge router.

`tests/smoke/bridgeExecOff.test.ts` sweeps Layer 1/2 tools against a TypeScript
port of the `TDMCP_BRIDGE_ALLOW_EXEC=0` gates (`tests/helpers/execOffBridge.ts`).
A port can drift, so both sides read `tests/fixtures/exec-off-policy.json`: the
vitest suite runs the fixture through the port, and this module runs the same
fixture through the real `api_controller`. Neither side needs TouchDesigner.
"""

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

_td_stub = types.ModuleType("td")
_td_stub.op = mock.MagicMock(name="op")
_td_stub.app = mock.MagicMock(name="app")
_td_stub.project = mock.MagicMock(name="project")
sys.modules.setdefault("td", _td_stub)

from mcp.controllers import api_controller as ac  # noqa: E402

_FIXTURE = os.path.abspath(
    os.path.join(_HERE, "..", "..", "tests", "fixtures", "exec-off-policy.json")
)
with open(_FIXTURE, encoding="utf-8") as handle:
    POLICY = json.load(handle)


class _ExecOffCase(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.dict(os.environ, {"TDMCP_BRIDGE_ALLOW_EXEC": "0"})
        patcher.start()
        self.addCleanup(patcher.stop)


class ExecOffVocabularyParityTests(_ExecOffCase):
    def test_policy_constants_match_the_router(self):
        self.assertEqual(
            sorted(POLICY["executableOperatorFragments"]),
            sorted(ac._EXECUTABLE_OPERATOR_FRAGMENTS),
        )
        self.assertEqual(
            sorted(POLICY["codeParameterPrefixes"]), sorted(ac._CODE_PARAMETER_PREFIXES)
        )
        self.assertEqual(sorted(POLICY["codeParameterNames"]), sorted(ac._CODE_PARAMETER_NAMES))
        self.assertEqual(
            sorted(POLICY["datFileParameterNames"]), sorted(ac._DAT_FILE_PARAMETER_NAMES)
        )
        self.assertEqual(
            {key: sorted(value) for key, value in POLICY["typeSpecificCodeParameters"].items()},
            {key: sorted(value) for key, value in ac._TYPE_SPECIFIC_CODE_PARAMETERS.items()},
        )

    def test_generic_node_code_cases(self):
        for case in POLICY["genericNodeCodeCases"]:
            with self.subTest(case=case):
                self.assertEqual(
                    ac._generic_node_code_sources(case["type"], case.get("parameters")),
                    case["sources"],
                )

    def test_custom_params_cases(self):
        for case in POLICY["customParamsCases"]:
            with self.subTest(case=case):
                self.assertEqual(
                    ac._custom_params_contains_caller_code(case["body"]), case["contains"]
                )


class ExecOffRouteParityTests(_ExecOffCase):
    def test_refused_routes_refuse_with_the_mocked_message(self):
        for route in POLICY["refusedRoutes"]:
            with self.subTest(route=route):
                with self.assertRaises(PermissionError) as caught:
                    ac._route(route["method"], route["path"], {}, route["body"])
                self.assertEqual(str(caught.exception), POLICY["messages"][route["gate"]])

    def test_current_bridge_routes_exist_and_survive_exec_off(self):
        services = {
            name: mock.MagicMock(name=name)
            for name in vars(ac)
            if name.endswith("_service") or name.endswith("_services")
        }
        with mock.patch.multiple(ac, **services):
            for route in POLICY["currentBridgeRoutes"]:
                with self.subTest(route=route):
                    try:
                        ac._route(
                            route["method"],
                            route["path"],
                            route.get("query", {}),
                            route.get("body", {}),
                        )
                    except PermissionError as exc:
                        self.fail("route refused under exec-off: %s" % exc)
                    except ValueError as exc:
                        if str(exc).startswith("Unsupported "):
                            self.fail("mock serves a route the bridge lacks: %s" % exc)


if __name__ == "__main__":
    unittest.main()
