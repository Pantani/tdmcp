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
from datetime import datetime, timedelta, timezone
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

from mcp.services import (  # noqa: E402
    analysis_service,
    api_service,
    batch_service,
    editor_service,
    preview_service,
)


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
        self.nodeX = 0.0
        self.nodeY = 0.0
        self.nodeWidth = 130.0
        self.nodeHeight = 90.0
        self.viewer = False

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
        parent.op.return_value = None  # no name collision: fresh create
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
        parent.op.return_value = None  # no name collision: fresh create
        parent.create.return_value = node
        with mock.patch.object(api_service, "op", lambda p: parent), mock.patch.object(
            api_service, "_resolve_type", lambda t: object
        ):
            ref = api_service.create_node("/project1", "fakeTOP", "lvl", {"brightness1": 0.5})
        self.assertNotIn("parameter_warnings", ref)
        self.assertNotIn("already_existed", ref)


class CreateNodePlacementTests(unittest.TestCase):
    def _create(self, node, parent, **kwargs):
        parent.op.return_value = None
        parent.create.return_value = node
        with mock.patch.object(api_service, "op", lambda _p: parent), mock.patch.object(
            api_service, "_resolve_type", lambda _t: object
        ):
            return api_service.create_node("/project1", "fakeTOP", "placed", **kwargs)

    def test_legacy_omission_preserves_touchdesigner_drop_position(self):
        node = FakeNode("/project1/placed")
        node.nodeX, node.nodeY, node.viewer = 37.0, -19.0, True
        ref = self._create(node, mock.MagicMock(name="parent"))
        self.assertEqual((node.nodeX, node.nodeY, node.viewer), (37.0, -19.0, True))
        self.assertEqual((ref["nodeX"], ref["nodeY"], ref["viewer"]), (37.0, -19.0, True))

    def test_explicit_placement_and_viewer_are_exact(self):
        node = FakeNode("/project1/placed")
        ref = self._create(
            node,
            mock.MagicMock(name="parent"),
            placement="explicit",
            node_x=420,
            node_y=-240,
            viewer=True,
        )
        self.assertEqual((node.nodeX, node.nodeY, node.viewer), (420.0, -240.0, True))
        self.assertEqual((ref["nodeX"], ref["nodeY"], ref["viewer"]), (420.0, -240.0, True))

    def test_auto_placement_uses_first_free_deterministic_grid_cell(self):
        occupied = FakeNode("/project1/existing")
        node = FakeNode("/project1/placed")
        parent = mock.MagicMock(name="parent")
        parent.children = [occupied, node]
        self._create(node, parent, placement="auto")
        self.assertEqual((node.nodeX, node.nodeY), (0.0, -200.0))

    def test_explicit_coordinates_require_explicit_policy(self):
        with self.assertRaisesRegex(ValueError, "placement='explicit'"):
            api_service.create_node("/project1", "fakeTOP", node_x=1, node_y=2)

    def test_direct_rest_values_reject_non_finite_coordinates_and_string_viewer(self):
        for kwargs in (
            {"placement": "explicit", "node_x": float("inf"), "node_y": 0},
            {"placement": "explicit", "node_x": 0, "node_y": 0, "viewer": "false"},
        ):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                api_service.create_node("/project1", "fakeTOP", **kwargs)

    def test_reused_node_keeps_existing_editor_state(self):
        existing = FakeNode("/project1/placed")
        existing.OPType = "fakeTOP"
        existing.nodeX, existing.nodeY, existing.viewer = 12.0, -34.0, True
        parent = mock.MagicMock(name="parent")
        parent.op.return_value = existing
        with mock.patch.object(api_service, "op", lambda _p: parent), mock.patch.object(
            api_service, "_resolve_type", lambda _t: object
        ):
            ref = api_service.create_node(
                "/project1",
                "fakeTOP",
                "placed",
                placement="explicit",
                node_x=999,
                node_y=999,
                viewer=False,
            )
        self.assertTrue(ref["already_existed"])
        self.assertEqual((existing.nodeX, existing.nodeY, existing.viewer), (12.0, -34.0, True))


class CreateNodeIdempotencyTests(unittest.TestCase):
    def test_same_name_and_type_reuses_without_recreating(self):
        existing = FakeNode("/project1/lvl", ["brightness1"])
        existing.OPType = "levelTOP"
        parent = mock.MagicMock(name="parent")
        parent.op.return_value = existing  # name already taken by a levelTOP
        with mock.patch.object(api_service, "op", lambda p: parent), mock.patch.object(
            api_service, "_resolve_type", lambda t: object
        ):
            ref = api_service.create_node("/project1", "levelTOP", "lvl", {"brightness1": 0.5})
        self.assertTrue(ref.get("already_existed"))
        self.assertEqual(ref["path"], "/project1/lvl")
        parent.create.assert_not_called()  # reused, never re-created
        # Idempotent: parameters still converge onto the existing node.
        self.assertEqual(existing.par.brightness1.val, 0.5)

    def test_same_name_different_type_is_explicit_error(self):
        existing = FakeNode("/project1/lvl")
        existing.OPType = "levelTOP"
        parent = mock.MagicMock(name="parent")
        parent.op.return_value = existing
        with mock.patch.object(api_service, "op", lambda p: parent), mock.patch.object(
            api_service, "_resolve_type", lambda t: object
        ):
            with self.assertRaises(ValueError) as cm:
                api_service.create_node("/project1", "noiseTOP", "lvl")
        msg = str(cm.exception)
        self.assertIn("collision", msg)
        self.assertIn("levelTOP", msg)
        parent.create.assert_not_called()


class _MenuPar:
    """A fake fixed-Menu parameter for menu-validation tests."""

    def __init__(self, name, menu_names, val=None):
        self.name = name
        self.style = "Menu"
        self.menuNames = menu_names
        self.menuLabels = menu_names
        self.val = val

    def eval(self):
        return self.val


class MenuValidationTests(unittest.TestCase):
    def _node_with_menu(self):
        node = FakeNode("/project1/comp", [])
        node.par.extend = _MenuPar("extend", ["hold", "cycle", "mirror"])
        return node

    def test_invalid_menu_value_raises_with_valid_options(self):
        node = self._node_with_menu()
        with mock.patch.object(api_service, "op", lambda p: node):
            with self.assertRaises(ValueError) as cm:
                api_service.update_parameters("/project1/comp", {"extend": "bogus"})
        msg = str(cm.exception)
        self.assertIn("extend", msg)
        self.assertIn("hold", msg)  # valid options are listed
        self.assertIn("cycle", msg)
        # The invalid value was NOT silently coerced onto the par.
        self.assertIsNone(node.par.extend.val)

    def test_valid_menu_value_applies(self):
        node = self._node_with_menu()
        with mock.patch.object(api_service, "op", lambda p: node):
            api_service.update_parameters("/project1/comp", {"extend": "cycle"})
        self.assertEqual(node.par.extend.val, "cycle")

    def test_menu_error_helper_ignores_strmenu(self):
        # StrMenu accepts arbitrary strings, so it must never be rejected.
        par = _MenuPar("file", ["a", "b"])
        par.style = "StrMenu"
        self.assertIsNone(api_service.menu_value_error(par, "anything"))

    def test_create_surfaces_invalid_menu_as_warning(self):
        node = self._node_with_menu()
        parent = mock.MagicMock(name="parent")
        parent.op.return_value = None
        parent.create.return_value = node
        with mock.patch.object(api_service, "op", lambda p: parent), mock.patch.object(
            api_service, "_resolve_type", lambda t: object
        ):
            ref = api_service.create_node("/project1", "fakeTOP", "comp", {"extend": "bogus"})
        self.assertIn("extend", ref.get("parameter_warnings", []))


class SampleGridTests(unittest.TestCase):
    def test_finite_or_none_sanitizes_nan_and_inf(self):
        self.assertEqual(preview_service._finite_or_none(0.5), 0.5)
        self.assertIsNone(preview_service._finite_or_none(float("nan")))
        self.assertIsNone(preview_service._finite_or_none(float("inf")))
        self.assertIsNone(preview_service._finite_or_none("x"))

    def test_grid_indices_span_the_axis(self):
        self.assertEqual(preview_service._grid_indices(2, 4), [1, 3])
        self.assertEqual(preview_service._grid_indices(4, 0), [0, 0, 0, 0])
        # Never runs off the end.
        self.assertTrue(all(0 <= i < 8 for i in preview_service._grid_indices(8, 8)))

    def test_channel_stats_ignore_none_and_average(self):
        samples = [[[0.0, 0.0, 0.0, 1.0], [1.0, 0.5, 0.0, None]]]
        stats = preview_service._channel_stats(samples)
        self.assertEqual(stats["r"], {"min": 0.0, "max": 1.0, "mean": 0.5})
        self.assertEqual(stats["a"], {"min": 1.0, "max": 1.0, "mean": 1.0})  # None ignored

    def test_sample_grid_reads_top_and_sanitizes(self):
        # A 2x2 RGBA image with an Inf that must sanitize to null.
        arr = [
            [[0.0, 0.0, 0.0, 1.0], [1.0, 1.0, 1.0, 1.0]],
            [[float("inf"), 0.0, 0.0, 1.0], [0.5, 0.5, 0.5, 1.0]],
        ]
        node = mock.MagicMock(name="top")
        node.family = "TOP"
        node.path = "/project1/noise1"
        node.numpyArray.return_value = arr
        with mock.patch.object(preview_service, "op", lambda p: node):
            result = preview_service.sample_grid("/project1/noise1", 2)
        self.assertEqual(result["grid"], 2)
        self.assertEqual(result["width"], 2)
        self.assertEqual(result["height"], 2)
        self.assertIsNone(result["samples"][1][0][0])  # Inf → null
        self.assertIn("r", result["stats"])

    def test_sample_grid_rejects_non_top(self):
        node = mock.MagicMock(name="chop")
        node.family = "CHOP"
        with mock.patch.object(preview_service, "op", lambda p: node):
            with self.assertRaises(ValueError):
                preview_service.sample_grid("/project1/chop1", 4)


class DeleteModeTests(unittest.TestCase):
    def test_default_mode_fails_closed_to_keep(self):
        node = mock.MagicMock(name="node")
        with mock.patch.object(api_service, "op", lambda p: node):
            result = api_service.delete_node("/project1/x")
        node.destroy.assert_not_called()
        self.assertEqual(result["decision"], "Keep")
        self.assertFalse(result["applied"])

    def test_resolved_delete_destroys(self):
        node = mock.MagicMock(name="node")
        with mock.patch.object(api_service, "op", lambda p: node):
            result = api_service.delete_node("/project1/x", decision="Delete")
        node.destroy.assert_called_once()
        self.assertEqual(result["deleted"], "/project1/x")

    def test_explicit_yolo_destroys_and_is_auditable(self):
        node = mock.MagicMock(name="node")
        with mock.patch.object(api_service, "op", lambda p: node):
            result = api_service.delete_node(
                "/project1/x", confirmation_policy="yolo"
            )
        node.destroy.assert_called_once()
        self.assertEqual(result["confirmation_policy"], "yolo")

    def test_bypass_mode_sets_flag_and_does_not_destroy(self):
        node = mock.MagicMock(name="node")
        with mock.patch.object(api_service, "op", lambda p: node):
            result = api_service.delete_node("/project1/x", "bypass")
        self.assertTrue(node.bypass)
        node.destroy.assert_not_called()
        self.assertEqual(result["bypassed"], "/project1/x")
        self.assertEqual(result["mode"], "bypass")

    def test_unknown_mode_raises(self):
        node = mock.MagicMock(name="node")
        with mock.patch.object(api_service, "op", lambda p: node):
            with self.assertRaises(ValueError):
                api_service.delete_node("/project1/x", "nuke")

    def test_missing_node_raises(self):
        with mock.patch.object(api_service, "op", lambda p: None):
            with self.assertRaises(LookupError):
                api_service.delete_node("/nope", "bypass")


class BatchDeleteSafetyTests(unittest.TestCase):
    def test_unconfirmed_batch_delete_is_keep_and_not_success(self):
        with mock.patch.object(
            batch_service.api_service,
            "delete_node",
            return_value={"decision": "Keep", "applied": False, "action_applied": "keep"},
        ) as delete:
            report = batch_service.run([{"action": "delete", "path": "/project1/x"}])
        entry = report["results"][0]
        self.assertFalse(entry["ok"])
        self.assertEqual(entry["data"]["decision"], "Keep")
        self.assertIn("standalone delete_td_node", entry["error"])
        delete.assert_called_once_with(
            "/project1/x", mode="delete", confirmation_policy="native"
        )

    def test_batch_bypass_is_explicit_and_reported_from_readback(self):
        result = {"decision": "Bypass", "applied": True, "action_applied": "bypass"}
        with mock.patch.object(
            batch_service.api_service, "delete_node", return_value=result
        ) as delete:
            report = batch_service.run(
                [{"action": "delete", "path": "/project1/x", "mode": "bypass"}]
            )
        self.assertTrue(report["results"][0]["ok"])
        delete.assert_called_once_with(
            "/project1/x", mode="bypass", confirmation_policy="explicit_mode"
        )

    def test_batch_yolo_delete_is_explicit_and_auditable(self):
        result = {"decision": "Delete", "applied": True, "confirmation_policy": "yolo"}
        with mock.patch.object(
            batch_service.api_service, "delete_node", return_value=result
        ) as delete:
            report = batch_service.run(
                [
                    {
                        "action": "delete",
                        "path": "/project1/x",
                        "confirmation_policy": "yolo",
                    }
                ]
            )
        self.assertTrue(report["results"][0]["ok"])
        self.assertEqual(report["results"][0]["data"]["confirmation_policy"], "yolo")
        delete.assert_called_once_with(
            "/project1/x", mode="delete", confirmation_policy="yolo"
        )


class EditorFocusTests(unittest.TestCase):
    def _pane(self):
        pane = mock.MagicMock(name="pane")
        pane.name = "pane1"
        pane.homeSelected = mock.MagicMock(name="homeSelected")
        return pane

    def test_focus_points_pane_selects_and_homes(self):
        node = mock.MagicMock(name="node")
        node.path = "/project1/noise1"
        parent = mock.MagicMock(name="parent")
        node.parent.return_value = parent
        pane = self._pane()
        ui = mock.MagicMock(name="ui")
        ui.panes = [pane]
        with mock.patch.object(editor_service, "op", lambda p: node), mock.patch.object(
            editor_service, "_get_ui", lambda: ui
        ):
            result = editor_service.focus(["/project1/noise1"], animate=True)
        self.assertEqual(result["focused"], ["/project1/noise1"])
        self.assertEqual(result["pane"], "pane1")
        self.assertIs(pane.owner, parent)
        self.assertTrue(node.selected)
        pane.homeSelected.assert_called_once_with(zoom=True)

    def test_focus_raises_when_no_operator_resolves(self):
        ui = mock.MagicMock(name="ui")
        ui.panes = [self._pane()]
        with mock.patch.object(editor_service, "op", lambda p: None), mock.patch.object(
            editor_service, "_get_ui", lambda: ui
        ):
            with self.assertRaises(ValueError):
                editor_service.focus(["/nope"])

    def test_focus_raises_when_no_network_editor_pane(self):
        node = mock.MagicMock(name="node")
        ui = mock.MagicMock(name="ui")
        ui.panes = []  # no pane exposes homeSelected
        with mock.patch.object(editor_service, "op", lambda p: node), mock.patch.object(
            editor_service, "_get_ui", lambda: ui
        ):
            with self.assertRaises(RuntimeError):
                editor_service.focus(["/project1/noise1"])


class DeferredCaptureTests(unittest.TestCase):
    def setUp(self):
        preview_service._PREVIEW_JOBS.clear()

    def tearDown(self):
        preview_service._PREVIEW_JOBS.clear()

    def _node_with_pulse(self):
        node = mock.MagicMock(name="node")
        node.par.Reset = mock.MagicMock(name="reset_par")
        return node

    def test_pre_pulses_validate_all_before_firing_any(self):
        good = self._node_with_pulse()
        nodes = {"/project1/fb": good}  # the second target is missing
        with mock.patch.object(preview_service, "op", lambda p: nodes.get(p)):
            with self.assertRaises(LookupError):
                preview_service.capture_advanced(
                    "/project1/out",
                    pre_pulses=[{"path": "/project1/fb", "par": "Reset"}, {"path": "/nope", "par": "Reset"}],
                )
        # All-or-nothing: the valid target was NOT pulsed because a sibling was invalid.
        good.par.Reset.pulse.assert_not_called()

    def test_immediate_capture_fires_pulses_then_captures(self):
        node = self._node_with_pulse()
        with mock.patch.object(preview_service, "op", lambda p: node), mock.patch.object(
            preview_service, "capture", return_value={"path": "/project1/out", "base64": "x"}
        ) as cap:
            result = preview_service.capture_advanced(
                "/project1/out", pre_pulses=[{"path": "/project1/fb", "par": "Reset"}]
            )
        node.par.Reset.pulse.assert_called_once()
        cap.assert_called_once()
        self.assertEqual(result["path"], "/project1/out")

    def test_deferred_job_becomes_ready_and_is_collected_once(self):
        # Default _schedule (no td.run off-TD) runs the callback immediately.
        with mock.patch.object(
            preview_service, "capture", return_value={"path": "/project1/out", "base64": "x"}
        ):
            scheduled = preview_service.capture_advanced("/project1/out", delay_frames=6)
        self.assertEqual(scheduled["status"], "capturing")
        self.assertIn("job_id", scheduled)
        self.assertGreater(scheduled["wait_ms"], 0)
        collected = preview_service.collect_preview_job(scheduled["job_id"])
        self.assertEqual(collected["status"], "ready")
        self.assertEqual(collected["preview"]["path"], "/project1/out")
        # One-shot: a second collect reports expired.
        again = preview_service.collect_preview_job(scheduled["job_id"])
        self.assertEqual(again["status"], "expired")

    def test_deferred_job_reports_pending_until_the_frame_arrives(self):
        with mock.patch.object(preview_service, "_schedule", lambda cb, frames: None):
            scheduled = preview_service.capture_advanced("/project1/out", delay_frames=6)
        collected = preview_service.collect_preview_job(scheduled["job_id"])
        self.assertEqual(collected["status"], "pending")

    def test_expired_job_is_pruned_by_ttl(self):
        with mock.patch.object(preview_service, "_schedule", lambda cb, frames: None):
            scheduled = preview_service.capture_advanced("/project1/out", delay_frames=6)
        # Age the job past its TTL, then collect → expired (and pruned).
        preview_service._PREVIEW_JOBS[scheduled["job_id"]]["created"] -= (
            preview_service._JOB_TTL_SECONDS + 1
        )
        collected = preview_service.collect_preview_job(scheduled["job_id"])
        self.assertEqual(collected["status"], "expired")
        self.assertNotIn(scheduled["job_id"], preview_service._PREVIEW_JOBS)


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
        api_service.mark_heartbeat()
        with mock.patch.object(api_service, "app", _HealthApp()), mock.patch.object(
            api_service, "project", _HealthProject()
        ):
            result = api_service.get_health(_HealthWebServer())

        self.assertEqual(result["state"], "ok")
        self.assertRegex(result["timestamp"], r"^\d{4}-\d{2}-\d{2}T")
        self.assertGreaterEqual(result["uptime_seconds"], 0)
        self.assertFalse(result["heartbeat"]["stale"])
        self.assertGreaterEqual(result["heartbeat"]["age_seconds"], 0)
        self.assertRegex(result["heartbeat"]["last_seen_at"], r"^\d{4}-\d{2}-\d{2}T")
        self.assertEqual(result["touchdesigner"]["td_version"], "2023.12000")
        self.assertEqual(result["touchdesigner"]["project"], "watchdog.toe")
        self.assertTrue(result["performance"]["available"])
        # TouchDesigner already reports cookTime in milliseconds and GPU memory in MB.
        self.assertEqual(result["performance"]["cook_time_ms"], 0.25)
        self.assertEqual(result["performance"]["cook_count"], 42)
        self.assertEqual(result["performance"]["cook_frame"], 1234)
        self.assertEqual(result["performance"]["dropped_frames"], 3)
        self.assertEqual(result["performance"]["gpu_memory_mb"], 512)
        self.assertEqual(result["performance"]["gpu_memory_total_mb"], 8192)

    def test_health_degrades_when_td_attrs_are_missing(self):
        api_service.mark_heartbeat()
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

    def test_health_marks_stale_when_frame_heartbeat_is_old(self):
        old = datetime.now(timezone.utc) - timedelta(
            seconds=api_service._HEARTBEAT_STALE_AFTER_SECONDS + 5
        )
        with mock.patch.object(api_service, "_LAST_HEARTBEAT_AT", old):
            result = api_service.get_health(_HealthWebServer())

        self.assertEqual(result["state"], "degraded")
        self.assertIn("heartbeat", result["degraded_signals"])
        self.assertTrue(result["heartbeat"]["stale"])
        self.assertGreater(
            result["heartbeat"]["age_seconds"], api_service._HEARTBEAT_STALE_AFTER_SECONDS
        )


if __name__ == "__main__":
    unittest.main()
