"""Focused offline tests for bounded action-aware Network Editor follow."""

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
_td_stub.op = lambda _path: None
_TD = sys.modules.setdefault("td", _td_stub)
if not hasattr(_TD, "op"):
    _TD.op = lambda _path: None

from mcp.services import editor_service  # noqa: E402


class Parent:
    def __init__(self, path):
        self.path = path
        self.children = []
        self.currentChild = None

    @property
    def selectedChildren(self):
        return [node for node in self.children if node.selected]


class Node:
    def __init__(self, path, parent):
        self.path = path
        self._parent = parent
        self.selected = False
        self._current = False
        parent.children.append(self)

    def parent(self):
        return self._parent

    @property
    def current(self):
        return self._current

    @current.setter
    def current(self, value):
        self._current = bool(value)
        if value:
            self._parent.currentChild = self


class Pane:
    type = "NETWORKEDITOR"

    def __init__(self, name, owner):
        self.name = name
        self.owner = owner
        self.x = 10.0
        self.y = 20.0
        self.zoom = 1.0
        self.home_calls = []

    def homeSelected(self, zoom=True):
        self.home_calls.append(("selection", zoom))
        self.x = 100.0
        self.y = 200.0
        if zoom:
            self.zoom = 0.5

    def home(self, zoom=True):
        self.home_calls.append(("owner", zoom))
        if zoom:
            self.zoom = 0.25


class Panes(list):
    def __init__(self, panes, current=None):
        super().__init__(panes)
        self.current = current


class UI:
    def __init__(self, panes, current=None, perform=False):
        self.panes = Panes(panes, current=current)
        self.performMode = perform


class FollowServiceTests(unittest.TestCase):
    def setUp(self):
        editor_service._reset_for_tests()
        self.env = mock.patch.dict(os.environ, {"TDMCP_EDITOR_FOLLOW_ENABLED": "1"})
        self.env.start()

        self.parent = Parent("/project1/group")
        self.other_parent = Parent("/project1/other")
        self.a = Node("/project1/group/a", self.parent)
        self.b = Node("/project1/group/b", self.parent)
        self.c = Node("/project1/other/c", self.other_parent)
        self.nodes = {
            self.parent.path: self.parent,
            self.other_parent.path: self.other_parent,
            self.a.path: self.a,
            self.b.path: self.b,
            self.c.path: self.c,
        }

    def tearDown(self):
        self.env.stop()
        editor_service._reset_for_tests()

    def patch_runtime(self, ui):
        return (
            mock.patch.object(editor_service, "op", lambda path: self.nodes.get(path)),
            mock.patch.object(editor_service, "_get_ui", lambda: ui),
        )

    def start_with_runtime(self, ui, paths, **kwargs):
        op_patch, ui_patch = self.patch_runtime(ui)
        with op_patch, ui_patch:
            return editor_service.start_follow(paths, _defer=False, **kwargs)

    def test_active_owner_wins_and_selection_is_exact(self):
        self.b.selected = True
        self.parent.currentChild = self.b
        existing = Pane("existing", self.parent)
        active = Pane("active", self.parent)
        ui = UI([existing, active], current=active)

        result = self.start_with_runtime(
            ui,
            [self.a.path, self.a.path],
            animate=False,
            framing="none",
            action="edit",
        )

        self.assertEqual(result["status"], "applied")
        self.assertEqual(result["pane"], "active")
        self.assertEqual(result["pane_strategy"], "owner_active")
        self.assertEqual(result["focused"], [self.a.path])
        self.assertEqual(result["final"]["current"], self.a.path)
        self.assertEqual(result["final"]["selected"], [self.a.path])
        self.assertFalse(self.b.selected)
        self.assertIsNone(result["undo_label"])

    def test_existing_owner_wins_over_unrelated_active_pane(self):
        matching = Pane("matching", self.parent)
        active = Pane("active", self.other_parent)
        ui = UI([matching, active], current=active)

        result = self.start_with_runtime(ui, [self.a.path], animate=False)

        self.assertEqual(result["status"], "applied")
        self.assertEqual(result["pane"], "matching")
        self.assertEqual(result["pane_strategy"], "owner_existing")

    def test_active_then_stable_first_compatible_fallbacks(self):
        unrelated = Parent("/project1/unrelated")
        first = Pane("first", unrelated)
        active = Pane("active", unrelated)
        ui = UI([first, active], current=active)
        result = self.start_with_runtime(ui, [self.a.path], animate=False)
        self.assertEqual(result["pane_strategy"], "active")
        self.assertEqual(result["pane"], "active")

        editor_service._reset_for_tests()
        first.owner = unrelated
        active.owner = unrelated
        ui = UI([first, active], current=None)
        result = self.start_with_runtime(ui, [self.a.path], animate=False)
        self.assertEqual(result["pane_strategy"], "first_compatible")
        self.assertEqual(result["pane"], "first")

    def test_pane_identity_survives_proxy_wrapper_rematerialization(self):
        first_wrapper = Pane("network1", self.parent)
        second_wrapper = Pane("network1", self.parent)
        ui = UI([second_wrapper], current=None)

        self.assertEqual(
            editor_service._pane_key(first_wrapper),
            editor_service._pane_key(second_wrapper),
        )
        self.assertIs(
            editor_service._available_pane(ui, editor_service._pane_key(first_wrapper)),
            second_wrapper,
        )

    def test_missing_and_mixed_parent_suppress_without_ui_change(self):
        pane = Pane("pane", self.parent)
        ui = UI([pane], current=pane)
        before = (pane.owner, pane.x, pane.y, pane.zoom)

        missing = self.start_with_runtime(ui, [self.a.path, "/missing"], animate=False)
        self.assertEqual(missing["status"], "suppressed")
        self.assertEqual(missing["suppression_reason"], "target_not_found")
        self.assertEqual(missing["missing_paths"], ["/missing"])
        self.assertEqual((pane.owner, pane.x, pane.y, pane.zoom), before)

        mixed = self.start_with_runtime(ui, [self.a.path, self.c.path], animate=False)
        self.assertEqual(mixed["status"], "suppressed")
        self.assertEqual(mixed["suppression_reason"], "different_parents")
        self.assertEqual((pane.owner, pane.x, pane.y, pane.zoom), before)

    def test_disabled_perform_headless_and_no_pane_are_typed_suppressions(self):
        pane = Pane("pane", self.parent)
        ui = UI([pane], current=pane)
        disabled = self.start_with_runtime(ui, [self.a.path], enabled=False)
        self.assertEqual(disabled["suppression_reason"], "follow_disabled")
        self.assertFalse(self.a.selected)

        perform = self.start_with_runtime(UI([pane], current=pane, perform=True), [self.a.path])
        self.assertEqual(perform["suppression_reason"], "perform_mode")

        headless = self.start_with_runtime(None, [self.a.path])
        self.assertEqual(headless["suppression_reason"], "ui_unavailable")

        no_pane = self.start_with_runtime(UI([], current=None), [self.a.path])
        self.assertEqual(no_pane["suppression_reason"], "no_network_editor")

    def test_global_disable_is_fail_closed(self):
        pane = Pane("pane", self.parent)
        with mock.patch.dict(os.environ, {"TDMCP_EDITOR_FOLLOW_ENABLED": "0"}):
            result = self.start_with_runtime(UI([pane], current=pane), [self.a.path])
        self.assertEqual(result["status"], "suppressed")
        self.assertEqual(result["suppression_reason"], "follow_disabled")

    def test_framing_modes_and_animation_claim_are_honest(self):
        pane = Pane("pane", self.parent)
        ui = UI([pane], current=pane)
        result = self.start_with_runtime(
            ui,
            [self.a.path, self.b.path],
            animate=True,
            framing="selection",
        )
        self.assertEqual(result["status"], "applied")
        self.assertEqual(result["framing"]["applied"], "selection")
        self.assertEqual(result["framing"]["animation"], "instant")
        self.assertEqual(result["warnings"], [])

        editor_service._reset_for_tests()
        pane = Pane("pane", self.parent)
        result = self.start_with_runtime(
            UI([pane], current=pane),
            [self.a.path],
            animate=False,
            framing="owner",
        )
        self.assertEqual(result["framing"], {
            "requested": "owner",
            "applied": "owner",
            "animation": "instant",
        })

    def test_scheduled_job_applies_on_callback_and_can_be_cancelled(self):
        pane = Pane("pane", self.parent)
        ui = UI([pane], current=pane)
        callbacks = []

        def run(_script, callback, delayFrames):
            self.assertEqual(delayFrames, 1)
            callbacks.append(callback)

        op_patch, ui_patch = self.patch_runtime(ui)
        with op_patch, ui_patch, mock.patch.object(editor_service.td, "run", run, create=True):
            scheduled = editor_service.start_follow([self.a.path], animate=True)
            self.assertEqual(scheduled["status"], "scheduled")
            self.assertEqual(scheduled["framing"]["animation"], "scheduled")
            callbacks.pop()()
            for _step in range(6):
                callbacks.pop(0)()
            applied = editor_service.get_follow_status(scheduled["operation_id"])
            self.assertEqual(applied["status"], "applied")
            self.assertEqual(applied["framing"]["animation"], "stepped")

            second = editor_service.start_follow([self.b.path], animate=True)
            cancelled = editor_service.cancel_follow(second["operation_id"])
            self.assertEqual(cancelled["status"], "cancelled")
            callbacks.pop()()
            self.assertEqual(
                editor_service.get_follow_status(second["operation_id"])["status"],
                "cancelled",
            )

    def test_new_generation_supersedes_stale_callback(self):
        pane = Pane("pane", self.parent)
        ui = UI([pane], current=pane)
        callbacks = []

        def run(_script, callback, delayFrames):
            callbacks.append(callback)

        op_patch, ui_patch = self.patch_runtime(ui)
        with op_patch, ui_patch, mock.patch.object(editor_service.td, "run", run, create=True):
            first = editor_service.start_follow([self.a.path], animate=True)
            second = editor_service.start_follow([self.b.path], animate=True)
            self.assertEqual(
                editor_service.get_follow_status(first["operation_id"])["suppression_reason"],
                "superseded",
            )
            callbacks[0]()
            self.assertFalse(self.a.selected)
            callbacks[1]()
            for _step in range(6):
                callbacks.pop()()
            self.assertTrue(self.b.selected)
            self.assertEqual(
                editor_service.get_follow_status(second["operation_id"])["status"],
                "applied",
            )

    def test_request_id_dedupe_conflict_ttl_and_capacity(self):
        pane = Pane("pane", self.parent)
        ui = UI([pane], current=pane)
        request_id = "opaque_request_1234"
        first = self.start_with_runtime(
            ui,
            [self.a.path],
            animate=False,
            request_id=request_id,
        )
        duplicate = self.start_with_runtime(
            ui,
            [self.a.path],
            animate=False,
            request_id=request_id,
        )
        self.assertEqual(duplicate["operation_id"], first["operation_id"])
        with self.assertRaises(ValueError):
            self.start_with_runtime(
                ui,
                [self.b.path],
                animate=False,
                request_id=request_id,
            )

        editor_service._reset_for_tests()
        callbacks = []
        op_patch, ui_patch = self.patch_runtime(ui)
        with op_patch, ui_patch, mock.patch.object(
            editor_service.td,
            "run",
            lambda _script, callback, delayFrames: callbacks.append(callback),
            create=True,
        ):
            pending = editor_service.start_follow([self.a.path], animate=True)
            editor_service._JOBS[pending["operation_id"]]["_expires_at"] = 0
            expired = editor_service.get_follow_status(pending["operation_id"])
            self.assertEqual(expired["status"], "expired")

            editor_service._reset_for_tests()
            with mock.patch.object(editor_service, "MAX_JOBS", 1):
                editor_service.start_follow([self.a.path], animate=True)
                full = editor_service.start_follow([self.b.path], animate=True)
            self.assertEqual(full["status"], "failed")

    def test_legacy_focus_adapter_preserves_success_and_errors(self):
        pane = Pane("pane", self.parent)
        ui = UI([pane], current=pane)
        op_patch, ui_patch = self.patch_runtime(ui)
        with op_patch, ui_patch:
            result = editor_service.focus([self.a.path], animate=False)
            self.assertEqual(result["focused"], [self.a.path])
            with self.assertRaises(ValueError):
                editor_service.focus(["/missing"], animate=False)
        with mock.patch.object(editor_service, "_get_ui", lambda: None):
            with self.assertRaises(RuntimeError):
                editor_service.focus([self.a.path], animate=False)

    def test_input_bounds_are_enforced(self):
        with self.assertRaises(ValueError):
            editor_service.start_follow([])
        with self.assertRaises(ValueError):
            editor_service.start_follow(["relative/path"])
        with self.assertRaises(ValueError):
            editor_service.start_follow(["/x"] * 65)
        with self.assertRaises(ValueError):
            editor_service.start_follow(["/x"], action="unknown")
        with self.assertRaises(ValueError):
            editor_service.start_follow(["/x"], request_id="too-short")


if __name__ == "__main__":
    unittest.main()
