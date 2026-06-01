"""Unit tests for the bridge service layer: parameter validation + connect guards.

Exercises api_service.update_parameters / create_node and batch_service.connect
off-TD using lightweight fakes for TD node objects. These lock in the fixes for
two silent-failure bugs:

  * setting an unknown parameter name (e.g. `gain` on a levelTOP) used to be
    silently dropped; it now raises (update) or warns (create).
  * wiring two operators in different containers used to silently no-op; it now
    raises with an actionable message.

Stdlib only. Run: `python3 -m unittest discover -s td/tests` (or `npm run test:bridge`).
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

from mcp.services import analysis_service, api_service, batch_service  # noqa: E402


# --- Lightweight fakes for TD node objects -------------------------------------
class FakePar:
    def __init__(self, name, val=None):
        self.name = name
        self.val = val

    def eval(self):
        return self.val


class FakeParCollection:
    """getattr(self, name, None) -> FakePar for known names, None otherwise."""

    def __init__(self, names):
        for n in names:
            setattr(self, n, FakePar(n))


class FakeConnector:
    def __init__(self):
        self.connected_to = None

    def connect(self, other):
        self.connected_to = other


class FakeNode:
    def __init__(self, path, par_names=(), parent_path="/project1", n_in=1, n_out=1):
        self.path = path
        self.name = path.rsplit("/", 1)[-1]
        self.OPType = "fakeTOP"
        self.par = FakeParCollection(par_names)
        self.inputs = []
        self.outputs = []
        self.inputConnectors = [FakeConnector() for _ in range(n_in)]
        self.outputConnectors = [FakeConnector() for _ in range(n_out)]
        self._parent_path = parent_path

    def pars(self):
        return [v for v in vars(self.par).values() if isinstance(v, FakePar)]

    def parent(self):
        return types.SimpleNamespace(path=self._parent_path)


class UpdateParametersTests(unittest.TestCase):
    def test_rejects_unknown_param_atomically(self):
        node = FakeNode("/project1/lvl", ["brightness1"])
        with mock.patch.object(api_service, "op", lambda p: node):
            with self.assertRaises(ValueError) as cm:
                api_service.update_parameters("/project1/lvl", {"gain": 0.5, "brightness1": 0.9})
        self.assertIn("gain", str(cm.exception))
        # Atomic: a valid sibling param in the same call is NOT applied either.
        self.assertIsNone(node.par.brightness1.val)

    def test_applies_known_params(self):
        node = FakeNode("/project1/lvl", ["brightness1", "opacity"])
        with mock.patch.object(api_service, "op", lambda p: node):
            detail = api_service.update_parameters(
                "/project1/lvl", {"brightness1": 0.85, "opacity": 0.5}
            )
        self.assertEqual(node.par.brightness1.val, 0.85)
        self.assertEqual(node.par.opacity.val, 0.5)
        self.assertEqual(detail["path"], "/project1/lvl")

    def test_missing_node_raises(self):
        with mock.patch.object(api_service, "op", lambda p: None):
            with self.assertRaises(LookupError):
                api_service.update_parameters("/nope", {"x": 1})


class CreateNodeWarningTests(unittest.TestCase):
    def test_failed_params_become_warnings_not_silent(self):
        node = FakeNode("/project1/lvl", ["brightness1"])
        parent = mock.MagicMock(name="parent")
        parent.create.return_value = node
        with mock.patch.object(api_service, "op", lambda p: parent), mock.patch.object(
            api_service, "_resolve_type", lambda t: object
        ):
            ref = api_service.create_node(
                "/project1", "fakeTOP", "lvl", {"gain": 1, "brightness1": 0.5}
            )
        # Node is still created; the bad param surfaces as a warning, not silence.
        self.assertEqual(ref["path"], "/project1/lvl")
        self.assertIn("gain", ref.get("parameter_warnings", []))
        # The valid param still applied.
        self.assertEqual(node.par.brightness1.val, 0.5)

    def test_no_warnings_when_all_params_valid(self):
        node = FakeNode("/project1/lvl", ["brightness1"])
        parent = mock.MagicMock(name="parent")
        parent.create.return_value = node
        with mock.patch.object(api_service, "op", lambda p: parent), mock.patch.object(
            api_service, "_resolve_type", lambda t: object
        ):
            ref = api_service.create_node("/project1", "fakeTOP", "lvl", {"brightness1": 0.5})
        self.assertNotIn("parameter_warnings", ref)


class ConnectGuardTests(unittest.TestCase):
    def _patch_op(self, nodes):
        return mock.patch.object(batch_service, "op", lambda p: nodes.get(p))

    def test_rejects_cross_container(self):
        src = FakeNode("/project1/a/x", parent_path="/project1/a")
        dst = FakeNode("/project1/b/y", parent_path="/project1/b")
        with self._patch_op({"/project1/a/x": src, "/project1/b/y": dst}):
            with self.assertRaises(ValueError) as cm:
                batch_service.connect("/project1/a/x", "/project1/b/y")
        self.assertIn("across containers", str(cm.exception))
        # No phantom wire was made.
        self.assertIsNone(dst.inputConnectors[0].connected_to)

    def test_same_parent_wires(self):
        src = FakeNode("/project1/x", parent_path="/project1")
        dst = FakeNode("/project1/y", parent_path="/project1")
        with self._patch_op({"/project1/x": src, "/project1/y": dst}):
            batch_service.connect("/project1/x", "/project1/y")
        self.assertIs(dst.inputConnectors[0].connected_to, src.outputConnectors[0])

    def test_bad_connector_index_raises(self):
        src = FakeNode("/project1/x", parent_path="/project1")
        dst = FakeNode("/project1/y", parent_path="/project1", n_in=1)
        with self._patch_op({"/project1/x": src, "/project1/y": dst}):
            with self.assertRaises(IndexError):
                batch_service.connect("/project1/x", "/project1/y", target_input=3)

    def test_missing_node_raises(self):
        with self._patch_op({}):
            with self.assertRaises(LookupError):
                batch_service.connect("/a", "/b")


class _PerfNode:
    def __init__(self, path, cook_time=0.0, cook_count=0):
        self.path = path
        self.cookTime = cook_time
        self.cookCount = cook_count


class _PerfRoot:
    """Returns direct children at depth=1, all descendants otherwise — like a TD COMP."""

    def __init__(self, direct, nested):
        self._direct = direct
        self._nested = nested

    def findChildren(self, depth=None):
        return self._direct if depth == 1 else self._nested


class PerformanceRecursiveTests(unittest.TestCase):
    def _run(self, recursive):
        direct = [_PerfNode("/p/a", 1.0)]
        nested = [_PerfNode("/p/a", 1.0), _PerfNode("/p/sys/inner", 2.0)]
        root = _PerfRoot(direct, nested)
        with mock.patch.object(analysis_service, "op", lambda path: root):
            return analysis_service.performance("/p", recursive=recursive)

    def test_shallow_measures_only_direct_children(self):
        result = self._run(recursive=False)
        self.assertEqual([n["path"] for n in result["nodes"]], ["/p/a"])
        self.assertEqual(result["total_cook_time_ms"], 1.0)

    def test_recursive_measures_nested_nodes_too(self):
        result = self._run(recursive=True)
        self.assertEqual(sorted(n["path"] for n in result["nodes"]), ["/p/a", "/p/sys/inner"])
        # Nested node's cook time is now counted in the total.
        self.assertEqual(result["total_cook_time_ms"], 3.0)


class _HealthApp:
    version = "2023.12000"
    build = "2023.12000"
    fps = 60
    droppedFrames = 3
    gpuMemory = 512
    gpuMemoryTotal = 8192


class _HealthProject:
    name = "watchdog.toe"


class _HealthWebServer:
    cookTime = 0.25
    cookCount = 42
    cookFrame = 1234


class _MissingAttrs:
    def __getattr__(self, _name):
        raise RuntimeError("attribute unavailable")


class HealthTests(unittest.TestCase):
    def test_health_reports_uptime_heartbeat_and_optional_performance(self):
        with mock.patch.object(api_service, "app", _HealthApp()), mock.patch.object(
            api_service, "project", _HealthProject()
        ):
            result = api_service.get_health(_HealthWebServer())

        self.assertEqual(result["state"], "ok")
        self.assertRegex(result["timestamp"], r"^\d{4}-\d{2}-\d{2}T")
        self.assertGreaterEqual(result["uptime_seconds"], 0)
        self.assertFalse(result["heartbeat"]["stale"])
        self.assertEqual(result["heartbeat"]["age_seconds"], 0)
        self.assertEqual(result["touchdesigner"]["td_version"], "2023.12000")
        self.assertEqual(result["touchdesigner"]["project"], "watchdog.toe")
        self.assertTrue(result["performance"]["available"])
        self.assertEqual(result["performance"]["cook_time_ms"], 0.25)
        self.assertEqual(result["performance"]["cook_count"], 42)
        self.assertEqual(result["performance"]["cook_frame"], 1234)
        self.assertEqual(result["performance"]["dropped_frames"], 3)
        self.assertEqual(result["performance"]["gpu_memory_mb"], 512)
        self.assertEqual(result["performance"]["gpu_memory_total_mb"], 8192)

    def test_health_degrades_when_td_attrs_are_missing(self):
        with mock.patch.object(api_service, "app", _MissingAttrs()), mock.patch.object(
            api_service, "project", _MissingAttrs()
        ):
            result = api_service.get_health(object())

        self.assertEqual(result["state"], "degraded")
        self.assertIn("touchdesigner", result["degraded_signals"])
        self.assertIn("performance", result["degraded_signals"])
        self.assertFalse(result["performance"]["available"])
        self.assertIsNone(result["performance"]["cook_time_ms"])
        self.assertIsNone(result["performance"]["cook_count"])
        self.assertIsNone(result["performance"]["dropped_frames"])
        self.assertIsNone(result["performance"]["gpu_memory_mb"])
        self.assertFalse(result["heartbeat"]["stale"])


if __name__ == "__main__":
    unittest.main()
