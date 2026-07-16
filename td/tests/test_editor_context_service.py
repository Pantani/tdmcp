"""Offline tests for compact and honest editor context reporting."""

import os
import sys
import types
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_MODULES = os.path.abspath(os.path.join(_HERE, "..", "modules"))
if _MODULES not in sys.path:
    sys.path.insert(0, _MODULES)

_td_stub = types.ModuleType("td")
sys.modules.setdefault("td", _td_stub)
_TD = sys.modules["td"]

from mcp.services import editor_context_service as ecs  # noqa: E402


class _Op:
    def __init__(self, path):
        self.path = path


class _Owner(_Op):
    def __init__(self, path, current=None, selected=None):
        super().__init__(path)
        self.currentChild = current
        self.selectedChildren = selected or []


class _Pane:
    def __init__(self, pane_type, name, owner=None, x=0, y=0, zoom=1.0):
        self.type = pane_type
        self.name = name
        self.owner = owner
        self.x = x
        self.y = y
        self.zoom = zoom


class _Panes(list):
    def __init__(self, values, current_marker=...):
        super().__init__(values)
        if current_marker is not ...:
            self.current = current_marker


class _Project:
    name = "show.toe"
    folder = "/show"
    saveVersion = "2025.30000"
    saveBuild = 30000

    def __init__(self, perform_mode=False):
        self.performMode = perform_mode


class _App:
    build = 32820
    version = "2025.32820"


class _TdPatch:
    def __init__(self, ui_marker=..., project=None):
        self.ui_marker = ui_marker
        self.project = project or _Project()

    def __enter__(self):
        names = ("ui", "project", "app")
        self.saved = {name: getattr(_TD, name, None) for name in names}
        for name in names:
            if hasattr(_TD, name):
                delattr(_TD, name)
        if self.ui_marker is not ...:
            _TD.ui = self.ui_marker
        _TD.project = self.project
        _TD.app = _App()

    def __exit__(self, *args):
        for name in ("ui", "project", "app"):
            if hasattr(_TD, name):
                delattr(_TD, name)
        for name, value in self.saved.items():
            if value is not None:
                setattr(_TD, name, value)


class EditorContextServiceTest(unittest.TestCase):
    def test_reports_active_network_editor_selection_rollover_and_viewport(self):
        selected = [_Op("/project1/noise1"), _Op("/project1/level1")]
        owner = _Owner("/project1", current=selected[1], selected=selected)
        network = _Pane("PaneType.NETWORKEDITOR", "pane1", owner, 120, -80, 0.75)
        other = _Pane("PaneType.PARAMETERS", "pane2", selected[0])
        rollover_par = types.SimpleNamespace(name="period", owner=selected[0])
        ui = types.SimpleNamespace(
            panes=_Panes([network, other], current_marker=network),
            rolloverOp=selected[0],
            rolloverPar=rollover_par,
        )
        with _TdPatch(ui):
            report = ecs.get_editor_context()

        self.assertTrue(report["ui_available"])
        self.assertEqual(report["touchdesigner"]["build"], 32820)
        self.assertEqual(report["project"]["name"], "show.toe")
        self.assertTrue(report["panes"][0]["active"])
        active = report["active_network_editor"]
        self.assertEqual(active["owner"], "/project1")
        self.assertEqual(active["current"], "/project1/level1")
        self.assertEqual(active["selected"], [node.path for node in selected])
        self.assertEqual(active["rollover_operator"], "/project1/noise1")
        self.assertEqual(
            active["rollover_parameter"],
            {"name": "period", "owner": "/project1/noise1"},
        )
        self.assertEqual(active["viewport"], {"x": 120, "y": -80, "zoom": 0.75})

    def test_headless_report_omits_ui_context_honestly(self):
        with _TdPatch(ui_marker=...):
            report = ecs.get_editor_context()
        self.assertFalse(report["ui_available"])
        self.assertEqual(report["panes"], [])
        self.assertIsNone(report["active_network_editor"])
        self.assertIn("headless", report["warnings"][0].lower())

    def test_perform_mode_is_reported_even_without_ui(self):
        with _TdPatch(ui_marker=..., project=_Project(perform_mode=True)):
            report = ecs.get_editor_context()
        self.assertTrue(report["perform_mode"])

    def test_perform_mode_prefers_ui_when_project_flag_is_unavailable(self):
        project = _Project()
        del project.performMode
        ui = types.SimpleNamespace(
            performMode=True,
            panes=_Panes([]),
            rolloverOp=None,
            rolloverPar=None,
        )
        with _TdPatch(ui_marker=ui, project=project):
            report = ecs.get_editor_context()
        self.assertTrue(report["perform_mode"])
        self.assertFalse(report["ui_available"])

    def test_perform_mode_does_not_leak_stale_editor_context_when_ui_exists(self):
        owner = _Owner("/project1", current=_Op("/project1/noise1"))
        pane = _Pane("PaneType.NETWORKEDITOR", "pane1", owner)
        ui = types.SimpleNamespace(
            panes=_Panes([pane], current_marker=pane),
            rolloverOp=_Op("/project1/noise1"),
            rolloverPar=None,
        )
        with _TdPatch(ui_marker=ui, project=_Project(perform_mode=True)):
            report = ecs.get_editor_context()
        self.assertTrue(report["perform_mode"])
        self.assertFalse(report["ui_available"])
        self.assertEqual(report["panes"], [])
        self.assertIsNone(report["active_network_editor"])
        self.assertTrue(any("Perform Mode" in warning for warning in report["warnings"]))

    def test_does_not_guess_active_pane_when_collection_has_no_current(self):
        network = _Pane("PaneType.NETWORKEDITOR", "pane1", _Owner("/project1"))
        ui = types.SimpleNamespace(panes=_Panes([network]), rolloverOp=None, rolloverPar=None)
        with _TdPatch(ui):
            report = ecs.get_editor_context()
        self.assertIsNone(report["active_network_editor"])
        self.assertFalse(report["panes"][0]["active"])
        self.assertTrue(any("explicit active pane" in item for item in report["warnings"]))

    def test_active_non_network_pane_does_not_infer_an_editor(self):
        pane = _Pane("PaneType.PARAMETERS", "parameters")
        ui = types.SimpleNamespace(
            panes=_Panes([pane], current_marker=pane), rolloverOp=None, rolloverPar=None
        )
        with _TdPatch(ui):
            report = ecs.get_editor_context()
        self.assertIsNone(report["active_network_editor"])
        self.assertTrue(any("not a Network Editor" in item for item in report["warnings"]))

    def test_panes_and_selection_are_bounded(self):
        selected = [_Op("/project1/n%d" % index) for index in range(80)]
        owner = _Owner("/project1", selected=selected)
        active = _Pane("PaneType.NETWORKEDITOR", "pane0", owner)
        panes = [active] + [_Pane("PaneType.PARAMETERS", "p%d" % i) for i in range(40)]
        ui = types.SimpleNamespace(
            panes=_Panes(panes, current_marker=active), rolloverOp=None, rolloverPar=None
        )
        with _TdPatch(ui):
            report = ecs.get_editor_context()
        self.assertEqual(len(report["panes"]), 32)
        self.assertEqual(len(report["active_network_editor"]["selected"]), 64)


if __name__ == "__main__":
    unittest.main()
