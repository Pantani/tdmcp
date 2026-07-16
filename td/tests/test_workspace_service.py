"""Focused offline tests for bounded artist-workspace pane jobs."""

import json
import os
import sys
import types
import unittest
from enum import Enum


_HERE = os.path.dirname(os.path.abspath(__file__))
_MODULES = os.path.abspath(os.path.join(_HERE, "..", "modules"))
if _MODULES not in sys.path:
    sys.path.insert(0, _MODULES)

from mcp.services import workspace_service as service  # noqa: E402


class Clock:
    def __init__(self):
        self.value = 10.0

    def __call__(self):
        return self.value


class Node:
    def __init__(self, path, family="COMP", parent=None, panel=False):
        self.path = path
        self.OPType = "containerCOMP" if family == "COMP" else "nullTOP"
        self.isCOMP = family == "COMP"
        self.isTOP = family == "TOP"
        self._parent = parent
        self.children = []
        self.currentChild = None
        self._selected = False
        self.panel = types.SimpleNamespace() if panel else None
        if parent is not None:
            parent.children.append(self)

    def parent(self):
        return self._parent

    @property
    def selectedChildren(self):
        return [child for child in self.children if child.selected]

    @property
    def selected(self):
        return self._selected

    @selected.setter
    def selected(self, value):
        self._selected = bool(value)

    @property
    def current(self):
        return self._parent is not None and self._parent.currentChild is self

    @current.setter
    def current(self, value):
        if value and self._parent is not None:
            self._parent.currentChild = self


class Panes(list):
    def __init__(self):
        super().__init__()
        self.current = None


class PaneType(Enum):
    NETWORKEDITOR = "NETWORKEDITOR"
    PARAMETERS = "PARAMETERS"
    TOPVIEWER = "TOPVIEWER"
    PANEL = "PANEL"


class Pane:
    def __init__(self, runtime, pane_id, name, pane_type, owner):
        self.runtime = runtime
        self.id = pane_id
        self.name = name
        self.type = pane_type
        self._owner = owner
        self.link = None
        self._ratio = 1.0
        self.maximize = False
        self.open = True
        self.x = 10.0
        self.y = 20.0
        self.zoom = 1.0
        self.peer = None
        self.invalidated = False

    @property
    def owner(self):
        return self._owner

    @owner.setter
    def owner(self, value):
        if self.runtime.fail_owner_assignment and self.type in (PaneType.TOPVIEWER, PaneType.PANEL):
            self.runtime.fail_owner_assignment = False
            raise RuntimeError("induced owner failure")
        if self.type == PaneType.TOPVIEWER and getattr(value, "isTOP", False):
            raise TypeError("COMP object expected")
        if self.type == PaneType.PANEL and not getattr(value, "isCOMP", False):
            raise TypeError("COMP object expected")
        self._owner = value

    @property
    def ratio(self):
        return self._ratio

    @ratio.setter
    def ratio(self, value):
        if self.runtime.fail_ratio and self.id == 1 and self.peer is not None:
            self.runtime.fail_ratio = False
            raise RuntimeError("induced ratio failure")
        self._ratio = float(value)
        if self.peer is not None:
            self.peer._ratio = 1.0 - self._ratio

    def splitRight(self):
        created = Pane(
            self.runtime,
            self.runtime.next_pane_id,
            "split%d" % self.runtime.next_pane_id,
            PaneType.NETWORKEDITOR,
            self.owner,
        )
        self.runtime.next_pane_id += 1
        self._ratio = 0.5
        created._ratio = 0.5
        self.peer = created
        created.peer = self
        self.runtime.panes.append(created)
        self.runtime.panes.current = created
        self.runtime.last_split_proxy = created
        return created

    def changeType(self, pane_type):
        if self.runtime.fail_change_type:
            self.runtime.fail_change_type = False
            raise RuntimeError("induced changeType failure")
        replacement = Pane(self.runtime, self.id, self.name, pane_type, self.owner)
        replacement._ratio = self._ratio
        replacement.peer = self.peer
        if self.peer is not None:
            self.peer.peer = replacement
        replacement.x, replacement.y, replacement.zoom = self.x, self.y, self.zoom
        index = self.runtime.panes.index(self)
        self.runtime.panes[index] = replacement
        if self.runtime.panes.current is self:
            self.runtime.panes.current = replacement
        self.invalidated = True
        self.runtime.changed_proxy = replacement
        return replacement

    def close(self):
        self.runtime.pending_close.append((self.id, self.name))

    def home(self, zoom=True):
        self.runtime.home_calls += 1


class Runtime:
    def __init__(self, perform=False, active_network=True):
        self.project = types.SimpleNamespace(performMode=perform)
        self.panes = Panes()
        self.ui = types.SimpleNamespace(panes=self.panes, performMode=perform)
        self.pending_close = []
        self.next_pane_id = 2
        self.last_split_proxy = None
        self.changed_proxy = None
        self.fail_change_type = False
        self.fail_owner_assignment = False
        self.fail_ratio = False
        self.home_calls = 0
        self.defer_close_once = False
        self.pending_viewport = None

        self.project1 = Node("/project1")
        self.network = Node("/project1/network", parent=self.project1)
        self.before = Node("/project1/network/before", "TOP", self.network)
        self.output = Node("/project1/network/out1", "TOP", self.network)
        self.panel = Node("/project1/panel", "COMP", self.project1, panel=True)
        self.other_root = Node("/project2")
        self.other_panel = Node("/project2/panel", "COMP", self.other_root, panel=True)
        self.before.selected = True
        self.before.current = True
        self.nodes = {
            node.path: node
            for node in (
                self.project1,
                self.network,
                self.before,
                self.output,
                self.panel,
                self.other_root,
                self.other_panel,
            )
        }
        pane_type = PaneType.NETWORKEDITOR if active_network else PaneType.PARAMETERS
        source = Pane(self, 1, "network", pane_type, self.project1)
        self.panes.append(source)
        self.panes.current = source

    def op(self, path):
        return self.nodes.get(path)

    def _flush_pending_viewport(self):
        if self.pending_viewport is not None:
            source = next(pane for pane in self.panes if pane.id == 1)
            source.x, source.y, source.zoom = self.pending_viewport
            self.pending_viewport = None

    def _remove_pending_panes(self, pending):
        removed = [pane for pane in self.panes if (pane.id, pane.name) in pending]
        for pane in removed:
            if pane.peer is not None:
                pane.peer.peer = None
                pane.peer._ratio = 1.0
            self.panes.remove(pane)
        return removed

    def flush_closes(self):
        self._flush_pending_viewport()
        if self.pending_close and self.defer_close_once:
            self.defer_close_once = False
            return
        pending = set(self.pending_close)
        self.pending_close = []
        if not pending:
            return
        removed = self._remove_pending_panes(pending)
        if self.panes.current in removed:
            self.panes.current = self.panes[0] if self.panes else None

    def add_unrelated_panes(self, count):
        for index in range(count):
            pane = Pane(
                self,
                self.next_pane_id,
                "unrelated%d" % index,
                PaneType.PARAMETERS,
                self.panel,
            )
            self.next_pane_id += 1
            self.panes.append(pane)


class Scheduler:
    def __init__(self, runtime, clock):
        self.runtime = runtime
        self.clock = clock
        self.frames = []
        self.leases = []
        self.fail = False

    def __call__(self, callback, delay_frames=1, delay_ms=None, wall_time=False):
        if self.fail:
            raise RuntimeError("scheduler unavailable")
        if delay_ms is None:
            self.frames.append(callback)
        else:
            self.leases.append((delay_ms, wall_time, callback))

    def frame(self):
        self.runtime.flush_closes()
        callback = self.frames.pop(0)
        callback()

    def lease(self):
        index = max(range(len(self.leases)), key=lambda item: self.leases[item][0])
        delay_ms, wall_time, callback = self.leases.pop(index)
        self.clock.value += delay_ms / 1000.0
        self.assert_wall_time = wall_time
        callback()


def open_payload(**overrides):
    payload = {
        "network_path": "/project1/network",
        "viewer_path": "/project1/network/out1",
        "viewer_mode": "top_output",
        "split_ratio": 0.62,
        "lease_seconds": 30,
        "idempotency_key": "workspace-open-key-0001",
    }
    payload.update(overrides)
    return payload


def assert_json_only(test, value):
    test.assertIsInstance(json.dumps(value, allow_nan=False), str)


class WorkspaceServiceTests(unittest.TestCase):
    def setUp(self):
        service._reset_for_tests()
        self.clock = Clock()
        self.runtime = Runtime()
        self.scheduler = Scheduler(self.runtime, self.clock)
        service._configure_for_tests(self.runtime, self.scheduler, self.clock)

    def tearDown(self):
        service._reset_for_tests()

    def open_active(self, **overrides):
        scheduled = service.open_workspace(open_payload(**overrides))
        self.assertEqual(scheduled["status"], "scheduled")
        self.scheduler.frame()
        self.assertEqual(
            service.get_workspace_status(scheduled["workspace_id"])["status"],
            "scheduled",
        )
        self.scheduler.frame()
        self.assertEqual(
            service.get_workspace_status(scheduled["workspace_id"])["status"],
            "scheduled",
        )
        self.scheduler.frame()
        return service.get_workspace_status(scheduled["workspace_id"])

    def test_open_is_deferred_json_only_and_top_owner_uses_parent_comp(self):
        self.assertFalse(hasattr(self.runtime, "PaneType"))
        receipt = service.open_workspace(open_payload())
        self.assertEqual(receipt["status"], "scheduled")
        self.assertEqual(len(self.runtime.panes), 1)
        assert_json_only(self, receipt)

        self.scheduler.frame()
        self.assertEqual(
            service.get_workspace_status(receipt["workspace_id"])["status"],
            "scheduled",
        )
        self.assertIsNone(
            service.get_workspace_status(receipt["workspace_id"])["workspace"]
        )
        self.scheduler.frame()
        self.assertEqual(
            service.get_workspace_status(receipt["workspace_id"])["status"],
            "scheduled",
        )
        self.scheduler.frame()
        active = service.get_workspace_status(receipt["workspace_id"])
        self.assertEqual(active["status"], "active")
        self.assertEqual(len(self.runtime.panes), 2)
        self.assertEqual(self.runtime.changed_proxy.owner, self.runtime.network)
        self.assertIs(self.runtime.network.currentChild, self.runtime.output)
        self.assertAlmostEqual(self.runtime.panes[0].ratio, 0.62)
        self.assertAlmostEqual(self.runtime.changed_proxy.ratio, 0.38)
        self.assertTrue(self.runtime.last_split_proxy.invalidated)
        self.assertEqual(active["owned_pane"]["type"], "TOPVIEWER")
        self.assertIsNone(active["undo_label"])
        assert_json_only(self, active)
        assert_json_only(self, service._RECORDS[receipt["workspace_id"]])

    def test_open_waits_for_two_stable_next_frame_viewports_before_active(self):
        receipt = service.open_workspace(open_payload())
        self.scheduler.frame()
        same_frame = service.get_workspace_status(receipt["workspace_id"])
        self.assertEqual(same_frame["status"], "scheduled")
        self.assertIsNone(same_frame["workspace"])
        self.assertEqual(
            (self.runtime.panes[0].x, self.runtime.panes[0].y, self.runtime.panes[0].zoom),
            (10.0, 20.0, 1.0),
        )

        self.runtime.pending_viewport = (662.85719, -15.000002, 0.583333)
        self.scheduler.frame()
        first_stable = service.get_workspace_status(receipt["workspace_id"])
        self.assertEqual(first_stable["status"], "scheduled")
        self.scheduler.frame()
        active = service.get_workspace_status(receipt["workspace_id"])
        self.assertEqual(active["status"], "active")
        self.assertEqual(
            active["workspace"],
            service._RECORDS[receipt["workspace_id"]]["_workspace_snapshot"],
        )

    def test_open_does_not_start_a_network_editor_home_animation(self):
        source = self.runtime.panes[0]
        viewport_before = (source.x, source.y, source.zoom)

        self.open_active()

        self.assertEqual(self.runtime.home_calls, 0)
        self.assertEqual((source.x, source.y, source.zoom), viewport_before)

    def test_cancel_during_settle_cleans_the_applied_split(self):
        pending = service.open_workspace(open_payload())
        self.scheduler.frame()
        self.assertEqual(len(self.runtime.panes), 2)
        cancelled = service.cancel_workspace(
            pending["workspace_id"],
            {"idempotency_key": "workspace-cancel-settle-01"},
        )
        self.assertEqual(cancelled["status"], "cancel_scheduled")
        self.scheduler.frame()
        self.scheduler.frame()
        self.assertEqual(
            service.get_workspace_status(pending["workspace_id"])["status"],
            "cleanup_scheduled",
        )
        self.scheduler.frame()
        final = service.get_workspace_status(pending["workspace_id"])
        self.assertEqual(final["status"], "cancelled")
        self.assertTrue(final["cleanup"]["baseline_verified"])
        self.assertEqual(len(self.runtime.panes), 1)

    def test_restore_is_compare_and_swap_and_verifies_close_next_frame(self):
        active = self.open_active()
        workspace_id = active["workspace_id"]
        scheduled = service.restore_workspace(
            workspace_id, {"idempotency_key": "workspace-restore-key-01"}
        )
        self.assertEqual(scheduled["status"], "restore_scheduled")
        self.scheduler.frame()
        interim = service.get_workspace_status(workspace_id)
        self.assertEqual(interim["status"], "cleanup_scheduled")
        self.assertEqual(len(self.runtime.panes), 2)
        self.scheduler.frame()
        restored = service.get_workspace_status(workspace_id)
        self.assertEqual(restored["status"], "restored")
        self.assertEqual(len(self.runtime.panes), 1)
        self.assertEqual(restored["cleanup"], {
            "attempted": True,
            "owned_pane_closed": True,
            "source_restored": True,
            "baseline_verified": True,
        })
        self.assertIs(self.runtime.network.currentChild, self.runtime.before)
        self.assertEqual(self.runtime.network.selectedChildren, [self.runtime.before])
        self.assertEqual(self.runtime.panes.current.id, 1)

    def test_close_verification_retries_once_when_td_defers_an_extra_frame(self):
        active = self.open_active()
        workspace_id = active["workspace_id"]
        self.runtime.defer_close_once = True
        service.restore_workspace(
            workspace_id, {"idempotency_key": "workspace-restore-delay-01"}
        )
        self.scheduler.frame()
        self.scheduler.frame()
        first_verify = service.get_workspace_status(workspace_id)
        self.assertEqual(first_verify["status"], "cleanup_scheduled")
        self.assertFalse(first_verify["cleanup"]["baseline_verified"])
        self.scheduler.frame()
        restored = service.get_workspace_status(workspace_id)
        self.assertEqual(restored["status"], "restored")
        self.assertTrue(restored["cleanup"]["baseline_verified"])

    def test_panel_mode_assigns_panel_comp_directly(self):
        active = self.open_active(
            viewer_path="/project1/panel",
            viewer_mode="panel_controls",
            idempotency_key="workspace-panel-key-001",
        )
        self.assertEqual(active["owned_pane"]["type"], "PANEL")
        self.assertIs(self.runtime.changed_proxy.owner, self.runtime.panel)
        self.assertIs(self.runtime.network.currentChild, self.runtime.before)

    def test_panel_mode_rejects_a_non_panel_comp_before_split(self):
        pending = service.open_workspace(
            open_payload(
                viewer_path="/project1/network",
                viewer_mode="panel_controls",
                idempotency_key="workspace-non-panel-001",
            )
        )
        self.scheduler.frame()
        result = service.get_workspace_status(pending["workspace_id"])
        self.assertEqual(result["status"], "suppressed")
        self.assertEqual(result["reason"], "wrong_target_family")
        self.assertEqual(len(self.runtime.panes), 1)

    def test_artist_change_conflicts_without_closing_or_rewriting(self):
        active = self.open_active()
        workspace_id = active["workspace_id"]
        self.runtime.changed_proxy.ratio = 0.44
        service.restore_workspace(
            workspace_id, {"idempotency_key": "workspace-conflict-key1"}
        )
        self.scheduler.frame()
        conflict = service.get_workspace_status(workspace_id)
        self.assertEqual(conflict["status"], "conflicted")
        self.assertEqual(conflict["reason"], "artist_layout_changed")
        self.assertEqual(len(self.runtime.panes), 2)
        self.assertAlmostEqual(self.runtime.changed_proxy.ratio, 0.44)

    def test_cancel_before_apply_invalidates_stale_callback(self):
        scheduled = service.open_workspace(open_payload())
        cancelled = service.cancel_workspace(
            scheduled["workspace_id"], {"idempotency_key": "workspace-cancel-key-001"}
        )
        self.assertEqual(cancelled["status"], "cancelled")
        self.scheduler.frame()
        self.assertEqual(len(self.runtime.panes), 1)
        self.assertEqual(
            service.get_workspace_status(scheduled["workspace_id"])["status"],
            "cancelled",
        )

    def test_active_cancel_uses_verified_restore(self):
        active = self.open_active()
        workspace_id = active["workspace_id"]
        result = service.cancel_workspace(
            workspace_id, {"idempotency_key": "workspace-cancel-key-002"}
        )
        self.assertEqual(result["status"], "cancel_scheduled")
        self.scheduler.frame()
        self.scheduler.frame()
        cancelled = service.get_workspace_status(workspace_id)
        self.assertEqual(cancelled["status"], "cancelled")
        self.assertEqual(cancelled["reason"], "client_cancelled")
        self.assertTrue(cancelled["cleanup"]["baseline_verified"])

    def test_lease_uses_wall_time_and_expires_only_after_verified_cleanup(self):
        active = self.open_active()
        workspace_id = active["workspace_id"]
        self.scheduler.lease()
        self.assertTrue(self.scheduler.assert_wall_time)
        self.assertEqual(service.get_workspace_status(workspace_id)["status"], "cleanup_scheduled")
        self.scheduler.frame()
        expired = service.get_workspace_status(workspace_id)
        self.assertEqual(expired["status"], "expired")
        self.assertEqual(expired["reason"], "lease_expired")
        self.assertTrue(expired["cleanup"]["baseline_verified"])

    def test_idempotency_deduplicates_and_conflicting_reuse_fails(self):
        first = service.open_workspace(open_payload())
        duplicate = service.open_workspace(open_payload())
        self.assertEqual(first["workspace_id"], duplicate["workspace_id"])
        self.assertTrue(duplicate["deduplicated"])
        self.assertEqual(len(self.scheduler.frames), 1)
        with self.assertRaisesRegex(service.WorkspaceError, "different input") as caught:
            service.open_workspace(open_payload(split_ratio=0.5))
        self.assertEqual(caught.exception.code, "idempotency_conflict")

    def test_rejected_lifecycle_tokens_do_not_escape_receipt_bounds(self):
        active = self.open_active()
        workspace_id = active["workspace_id"]
        service.restore_workspace(
            workspace_id, {"idempotency_key": "workspace-valid-restore-01"}
        )
        retained = len(service._IDEMPOTENCY)

        for index in range(32):
            with self.assertRaises(service.WorkspaceError) as raised:
                service.restore_workspace(
                    workspace_id,
                    {"idempotency_key": "workspace-rejected-%04d" % index},
                )
            self.assertEqual(raised.exception.code, "workspace_conflict")
        self.assertEqual(len(service._IDEMPOTENCY), retained)

        self.scheduler.frame()
        self.scheduler.frame()
        terminal_retained = len(service._IDEMPOTENCY)
        for index in range(32):
            receipt = service.restore_workspace(
                workspace_id,
                {"idempotency_key": "workspace-terminal-%04d" % index},
            )
            self.assertEqual(receipt["status"], "restored")
        self.assertEqual(len(service._IDEMPOTENCY), terminal_retained)

        self.clock.value += service.TERMINAL_RETENTION_SECONDS + 1
        with self.assertRaises(service.WorkspaceError):
            service.get_workspace_status(workspace_id)
        self.assertEqual(service._IDEMPOTENCY, {})

    def test_failures_after_split_close_only_the_captured_pane(self):
        for flag in ("fail_change_type", "fail_owner_assignment", "fail_ratio"):
            with self.subTest(flag=flag):
                service._reset_for_tests()
                runtime = Runtime()
                scheduler = Scheduler(runtime, self.clock)
                service._configure_for_tests(runtime, scheduler, self.clock)
                setattr(runtime, flag, True)
                pending = service.open_workspace(open_payload(idempotency_key="workspace-%s-key-01" % flag))
                scheduler.frame()
                interim = service.get_workspace_status(pending["workspace_id"])
                self.assertEqual(interim["status"], "cleanup_scheduled")
                self.assertEqual(len(runtime.panes), 2)
                scheduler.frame()
                failed = service.get_workspace_status(pending["workspace_id"])
                self.assertEqual(failed["status"], "failed")
                self.assertTrue(failed["cleanup"]["owned_pane_closed"])
                self.assertTrue(failed["cleanup"]["baseline_verified"])
                self.assertEqual([(pane.id, pane.name) for pane in runtime.panes], [(1, "network")])

    def test_pane_cap_is_checked_before_split(self):
        self.runtime.add_unrelated_panes(service.MAX_PANES - 1)
        self.assertEqual(len(self.runtime.panes), service.MAX_PANES)
        pending = service.open_workspace(open_payload())
        self.scheduler.frame()
        result = service.get_workspace_status(pending["workspace_id"])
        self.assertEqual(result["status"], "suppressed")
        self.assertEqual(result["reason"], "pane_limit")
        self.assertEqual(len(self.runtime.panes), service.MAX_PANES)
        self.assertIsNone(self.runtime.last_split_proxy)

    def test_overdue_scheduled_job_expires_without_callback_and_releases_capacity(self):
        first = service.open_workspace(open_payload())
        self.clock.value += service.APPLY_TTL_SECONDS + 0.1
        expired = service.get_workspace_status(first["workspace_id"])
        self.assertEqual(expired["status"], "suppressed")
        self.assertEqual(expired["reason"], "apply_timeout")

        second = service.open_workspace(
            open_payload(idempotency_key="workspace-open-after-timeout")
        )
        self.assertEqual(second["status"], "scheduled")
        self.scheduler.frame()
        self.assertEqual(len(self.runtime.panes), 1)

    def test_retained_state_uses_hashes_not_unrelated_pane_descriptors(self):
        self.runtime.add_unrelated_panes(1)
        active = self.open_active()
        internal = service._RECORDS[active["workspace_id"]]
        encoded = json.dumps(internal, sort_keys=True)
        self.assertNotIn('"panes"', encoded)
        self.assertNotIn("/project1/panel", encoded)
        self.assertEqual(internal["_baseline_snapshot"].keys(), {"pane_count", "fingerprint"})
        self.assertEqual(internal["_workspace_snapshot"].keys(), {"pane_count", "fingerprint"})

    def test_capacity_perform_and_missing_active_pane_fail_closed(self):
        first = service.open_workspace(open_payload())
        capacity = service.open_workspace(
            open_payload(idempotency_key="workspace-open-key-0002")
        )
        self.assertEqual(capacity["status"], "suppressed")
        self.assertEqual(capacity["reason"], "workspace_capacity")
        service.cancel_workspace(
            first["workspace_id"], {"idempotency_key": "workspace-cancel-key-003"}
        )

        service._reset_for_tests()
        perform = Runtime(perform=True)
        scheduler = Scheduler(perform, self.clock)
        service._configure_for_tests(perform, scheduler, self.clock)
        pending = service.open_workspace(open_payload())
        scheduler.frame()
        self.assertEqual(service.get_workspace_status(pending["workspace_id"])["reason"], "perform_mode")
        self.assertEqual(len(perform.panes), 1)

        service._reset_for_tests()
        other = Runtime(active_network=False)
        scheduler = Scheduler(other, self.clock)
        service._configure_for_tests(other, scheduler, self.clock)
        pending = service.open_workspace(open_payload())
        scheduler.frame()
        self.assertEqual(
            service.get_workspace_status(pending["workspace_id"])["reason"],
            "no_active_network_editor",
        )
        self.assertEqual(len(other.panes), 1)

    def test_invalid_inputs_and_runtime_targets_never_mutate(self):
        invalid = [
            open_payload(network_path="relative"),
            open_payload(split_ratio=float("nan")),
            open_payload(lease_seconds=29),
            open_payload(viewer_mode="parameters"),
            open_payload(extra=True),
        ]
        for payload in invalid:
            with self.assertRaises(service.WorkspaceError):
                service.open_workspace(payload)
        self.assertEqual(len(self.runtime.panes), 1)

        pending = service.open_workspace(
            open_payload(
                viewer_path="/project2/panel",
                viewer_mode="panel_controls",
                idempotency_key="workspace-cross-key-001",
            )
        )
        self.scheduler.frame()
        result = service.get_workspace_status(pending["workspace_id"])
        self.assertEqual(result["status"], "suppressed")
        self.assertEqual(result["reason"], "cross_project")
        self.assertEqual(len(self.runtime.panes), 1)

    def test_scheduler_failure_is_typed_and_status_is_td_free(self):
        self.scheduler.fail = True
        failed = service.open_workspace(open_payload())
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(failed["reason"], "scheduling_error")

        service._RUNTIME_OVERRIDE = object()
        status = service.get_workspace_status(failed["workspace_id"])
        self.assertEqual(status["status"], "failed")


if __name__ == "__main__":
    unittest.main()
