"""Unit tests for the system_info bridge module.

Mirrors ``test_transport_service.py``: install a stub ``td`` module with fake
``gpu``/``app``/``project`` and drive ``system_service.get_system_info()`` off-TD,
asserting the snapshot shape AND that each section degrades to a sentinel rather
than failing the whole endpoint when an attribute is missing.

Run from the repo root: ``python3 -m unittest discover -s td/tests``.
"""

import os
import sys
import types
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_MODULES = os.path.abspath(os.path.join(_HERE, "..", "modules"))
if _MODULES not in sys.path:
    sys.path.insert(0, _MODULES)

# system_service does ``import td`` INSIDE get_system_info(); reach the shared
# stub under sys.modules["td"] (sibling tests setdefault() it) and patch on it.
_td_stub = types.ModuleType("td")
sys.modules.setdefault("td", _td_stub)
_TD = sys.modules["td"]

from mcp.services import system_service as ss  # noqa: E402


class _FakeGpu:
    def __init__(self, name="RTX 4090", driver="550.00", memory=24576):
        self.name = name
        self.driver = driver
        self.memory = memory


class _FakeMonitor:
    def __init__(self, width=1920, height=1080, refresh=60, primary=False, left=0, top=0):
        self.width = width
        self.height = height
        self.refreshRate = refresh
        self.isPrimary = primary
        self.left = left
        self.top = top


class _FakeApp:
    def __init__(self, monitors=None, gpu_name="RTX 4090"):
        self.monitors = monitors if monitors is not None else []
        self.gpuName = gpu_name


class _FakeProject:
    def __init__(self, perform_mode=False):
        self.performMode = perform_mode


class _TdPatch:
    """Swap ``td.gpu``, ``td.app``, ``td.ui``, ``td.project`` for a test's lifetime."""

    def __init__(self, gpu=None, app=None, ui=None, project=None):
        self.gpu = gpu
        self.app = app
        self.ui = ui
        self.project = project

    def __enter__(self):
        self._saved = (
            getattr(_TD, "gpu", None),
            getattr(_TD, "app", None),
            getattr(_TD, "ui", None),
            getattr(_TD, "project", None),
        )
        # Remove attrs first so getattr-with-default branches actually fire when
        # the test wants the section unavailable.
        for name in ("gpu", "app", "ui", "project"):
            if hasattr(_TD, name):
                delattr(_TD, name)
        if self.gpu is not None:
            _TD.gpu = self.gpu
        if self.app is not None:
            _TD.app = self.app
        if self.ui is not None:
            _TD.ui = self.ui
        if self.project is not None:
            _TD.project = self.project
        return self

    def __exit__(self, *a):
        for name in ("gpu", "app", "ui", "project"):
            if hasattr(_TD, name):
                delattr(_TD, name)
        saved_gpu, saved_app, saved_ui, saved_project = self._saved
        if saved_gpu is not None:
            _TD.gpu = saved_gpu
        if saved_app is not None:
            _TD.app = saved_app
        if saved_ui is not None:
            _TD.ui = saved_ui
        if saved_project is not None:
            _TD.project = saved_project


class SystemInfoTests(unittest.TestCase):
    def test_all_sections_default(self):
        with _TdPatch(
            gpu=_FakeGpu(),
            app=_FakeApp(monitors=[_FakeMonitor(primary=True), _FakeMonitor(width=2560)]),
            project=_FakeProject(perform_mode=False),
        ):
            out = ss.get_system_info()
        self.assertEqual(set(out.keys()), {"gpu", "monitors", "performMode"})
        self.assertEqual(out["gpu"]["name"], "RTX 4090")
        self.assertEqual(out["gpu"]["memory"], 24576)
        self.assertEqual(len(out["monitors"]), 2)
        self.assertTrue(out["monitors"][0]["isPrimary"])
        self.assertEqual(out["monitors"][1]["width"], 2560)
        self.assertEqual(out["performMode"], False)

    def test_include_subset_only_gpu(self):
        with _TdPatch(gpu=_FakeGpu(), app=_FakeApp(), project=_FakeProject()):
            out = ss.get_system_info(include=["gpu"])
        self.assertEqual(set(out.keys()), {"gpu"})

    def test_include_unknown_section_ignored(self):
        with _TdPatch(gpu=_FakeGpu(), app=_FakeApp(), project=_FakeProject()):
            out = ss.get_system_info(include=["gpu", "warp_drive"])
        self.assertEqual(set(out.keys()), {"gpu"})

    def test_gpu_missing_falls_back_to_app_gpuName(self):
        with _TdPatch(app=_FakeApp(gpu_name="M2 Max"), project=_FakeProject()):
            out = ss.get_system_info(include=["gpu"])
        self.assertEqual(out["gpu"]["name"], "M2 Max")
        self.assertIsNone(out["gpu"]["driver"])
        self.assertIsNone(out["gpu"]["memory"])

    def test_gpu_missing_no_app_returns_nulls_no_error(self):
        with _TdPatch():
            out = ss.get_system_info(include=["gpu"])
        # No td.gpu and no td.app — every field None, but the section is NOT an error.
        self.assertIn("gpu", out)
        self.assertNotIn("error", out["gpu"])
        self.assertIsNone(out["gpu"]["name"])

    def test_monitors_missing_returns_error_sentinel(self):
        with _TdPatch():  # no td.app
            out = ss.get_system_info(include=["monitors"])
        self.assertIsInstance(out["monitors"], dict)
        self.assertIn("error", out["monitors"])

    def test_monitors_empty_list_is_not_an_error(self):
        with _TdPatch(app=_FakeApp(monitors=[])):
            out = ss.get_system_info(include=["monitors"])
        self.assertEqual(out["monitors"], [])

    def test_perform_mode_missing_returns_none(self):
        with _TdPatch():  # no td.project
            out = ss.get_system_info(include=["performMode"])
        self.assertIsNone(out["performMode"])

    def test_perform_mode_true(self):
        with _TdPatch(project=_FakeProject(perform_mode=True)):
            out = ss.get_system_info(include=["performMode"])
        self.assertEqual(out["performMode"], True)

    def test_perform_mode_prefers_ui_when_project_flag_is_missing(self):
        with _TdPatch(
            ui=types.SimpleNamespace(performMode=True),
            project=types.SimpleNamespace(),
        ):
            out = ss.get_system_info(include=["performMode"])
        self.assertEqual(out["performMode"], True)

    def test_one_section_failing_does_not_kill_others(self):
        # td.app.monitors raises -> monitors error sentinel; gpu still returns.
        class _ExplodingApp:
            gpuName = "RTX 3090"

            @property
            def monitors(self):
                raise RuntimeError("boom")

        with _TdPatch(app=_ExplodingApp(), project=_FakeProject()):
            out = ss.get_system_info()
        self.assertIn("error", out["monitors"])
        self.assertEqual(out["gpu"]["name"], "RTX 3090")
        self.assertEqual(out["performMode"], False)


class _FakeRoot:
    def __init__(self, initial=False):
        self._store = {"tdmcp_perform_mode": initial} if initial is not None else {}

    def fetch(self, key, default):
        return self._store.get(key, default)

    def store(self, key, value):
        self._store[key] = value


class _FakeUi:
    def __init__(self):
        self.performMode = False


class _PerformModeTdPatch:
    """Independent patcher for set_perform_mode tests (sets op/ui/project)."""

    def __init__(self, op=None, ui=None, project=None, no_ui_attr=False):
        self.op = op
        self.ui = ui
        self.project = project
        self.no_ui_attr = no_ui_attr

    def __enter__(self):
        self._saved = {n: getattr(_TD, n, None) for n in ("op", "ui", "project")}
        for n in ("op", "ui", "project"):
            if hasattr(_TD, n):
                delattr(_TD, n)
        if self.op is not None:
            _TD.op = self.op
        if self.ui is not None:
            _TD.ui = self.ui
        if self.project is not None:
            _TD.project = self.project
        return self

    def __exit__(self, *a):
        for n in ("op", "ui", "project"):
            if hasattr(_TD, n):
                delattr(_TD, n)
        for n, v in self._saved.items():
            if v is not None:
                setattr(_TD, n, v)


class SetPerformModeTests(unittest.TestCase):
    def test_stores_flag_and_sets_ui_and_project(self):
        root = _FakeRoot(initial=False)
        ui = _FakeUi()

        class _Proj:
            performMode = False

        proj = _Proj()
        with _PerformModeTdPatch(op=lambda _p: root, ui=ui, project=proj):
            out = ss.set_perform_mode(True)
        self.assertTrue(out["enabled"])
        self.assertFalse(out["was"])
        self.assertTrue(out["stored"])
        self.assertTrue(out["ui_perform_mode_set"])
        self.assertTrue(out["project_perform_mode_set"])
        self.assertEqual(out["warnings"], [])
        self.assertTrue(ui.performMode)
        self.assertTrue(proj.performMode)

    def test_idempotent_was_field(self):
        root = _FakeRoot(initial=True)
        ui = _FakeUi()
        with _PerformModeTdPatch(op=lambda _p: root, ui=ui):
            out = ss.set_perform_mode(True)
        self.assertTrue(out["was"])
        self.assertTrue(out["stored"])

    def test_no_ui_performmode_warns(self):
        root = _FakeRoot()

        class _UiNoPerform:
            pass  # no performMode attr

        with _PerformModeTdPatch(op=lambda _p: root, ui=_UiNoPerform()):
            out = ss.set_perform_mode(True)
        self.assertFalse(out["ui_perform_mode_set"])
        self.assertTrue(any("ui.performMode not found" in w for w in out["warnings"]))

    def test_project_missing_no_exception(self):
        root = _FakeRoot()
        ui = _FakeUi()
        with _PerformModeTdPatch(op=lambda _p: root, ui=ui):
            out = ss.set_perform_mode(False)
        self.assertFalse(out["project_perform_mode_set"])
        # `stored` mirrors the write in both directions — writing False must
        # still report stored=True (the old `bool(fetch)` path returned False
        # here and misrepresented a successful disable as a failed write).
        self.assertTrue(out["stored"])
        # No project warning expected — silent degradation when attr is absent.

    def test_no_td_op_warns_no_throw(self):
        ui = _FakeUi()
        with _PerformModeTdPatch(ui=ui):  # no op
            out = ss.set_perform_mode(True)
        self.assertFalse(out["stored"])
        self.assertTrue(any("td.op unavailable" in w for w in out["warnings"]))
        # ui still got set even with no op.
        self.assertTrue(out["ui_perform_mode_set"])


if __name__ == "__main__":
    unittest.main()
