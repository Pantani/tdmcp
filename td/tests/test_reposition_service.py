"""Offline contract tests for bounded exact operator placement."""

import json
import os
import sys
import types
import unittest


_HERE = os.path.dirname(os.path.abspath(__file__))
_MODULES = os.path.abspath(os.path.join(_HERE, "..", "modules"))
if _MODULES not in sys.path:
    sys.path.insert(0, _MODULES)

from mcp.services import reposition_service as service  # noqa: E402


class _Graph:
    def __init__(self):
        self.nodes = {}
        self.events = []
        self.next_id = 1

    def add(self, node):
        self.nodes[node.path] = node


class _Node:
    def __init__(self, graph, name, parent=None, x=0, y=0):
        self.graph = graph
        self.name = name
        self._parent = parent
        self.children = []
        self.docked = []
        self.id = graph.next_id
        graph.next_id += 1
        self._nodeX = x
        self._nodeY = y
        self.fail_values = {"nodeX": set(), "nodeY": set()}
        if parent is not None:
            parent.children.append(self)
        graph.add(self)

    @property
    def path(self):
        if self._parent is None:
            return "/" + self.name if self.name else "/"
        return self._parent.path.rstrip("/") + "/" + self.name

    def parent(self):
        return self._parent

    def _set(self, attribute, value):
        self.graph.events.append(("set", self.path, attribute, value))
        if value in self.fail_values[attribute]:
            raise RuntimeError("induced setter failure")
        setattr(self, "_" + attribute, value)

    @property
    def nodeX(self):
        return self._nodeX

    @nodeX.setter
    def nodeX(self, value):
        self._set("nodeX", value)

    @property
    def nodeY(self):
        return self._nodeY

    @nodeY.setter
    def nodeY(self, value):
        self._set("nodeY", value)


class _Panes(list):
    def __init__(self, pane):
        super().__init__([pane] if pane is not None else [])
        self.current = pane


class _Runtime:
    def __init__(self, graph, root, ui=True, perform=False, pane_type="PaneType.NETWORKEDITOR"):
        self.graph = graph
        self.project = types.SimpleNamespace(performMode=perform)
        pane = types.SimpleNamespace(type=pane_type, owner=root) if ui else None
        self.ui = (
            types.SimpleNamespace(panes=_Panes(pane), performMode=perform) if ui else None
        )

    def op(self, path):
        return self.graph.nodes.get(path)


class _Fixture:
    def __init__(self, ui=True, perform=False, clock=None):
        self.graph = _Graph()
        self.project = _Node(self.graph, "project1")
        self.root = _Node(self.graph, "show", self.project)
        self.host = _Node(self.graph, "host", self.root, 0, 0)
        self.explicit_child = _Node(self.graph, "pixel", self.root, 40, -90)
        self.carried = _Node(self.graph, "callbacks", self.root, 40, -180)
        self.other = _Node(self.graph, "other", self.root, -200, 80)
        self.host.docked = [self.explicit_child, self.carried]
        self.root.selectedChildren = [self.host, self.explicit_child]
        self.root.currentChild = self.host
        self.runtime = _Runtime(self.graph, self.root, ui=ui, perform=perform)
        self.service = service.RepositionService(self.runtime, clock=clock)

    def context_payload(self, include_docked=True, target_source="provided_paths"):
        return {
            "root_path": self.root.path,
            "target_source": target_source,
            "include_docked": include_docked,
            "positions": [
                {"path": self.host.path, "x": 200, "y": -120},
                {"path": self.explicit_child.path, "x": 430, "y": -220},
            ],
        }

    def apply_payload(self, key="wave10-reposition-key-0001", **context_changes):
        context_payload = self.context_payload(**context_changes)
        context = self.service.context(context_payload)
        return dict(
            context_payload,
            fingerprint=context["fingerprint"],
            editor_context=context["editor_context"],
            idempotency_key=key,
        )


class RepositionServiceTest(unittest.TestCase):
    def test_context_is_sorted_content_free_and_identity_sensitive(self):
        fixture = _Fixture(ui=False, perform=True)
        context = fixture.service.context(fixture.context_payload())

        self.assertEqual(context["requested_paths"], [fixture.host.path, fixture.explicit_child.path])
        self.assertEqual([item["path"] for item in context["nodes"]], sorted(
            [fixture.host.path, fixture.explicit_child.path, fixture.carried.path]
        ))
        self.assertIsNone(context["editor_context"])
        encoded = json.dumps(context)
        for forbidden in ("identity", "secret", "token", "DAT", "<__main__"):
            self.assertNotIn(forbidden, encoded)

        previous = context["fingerprint"]
        fixture.host.id += 100
        changed = fixture.service.context(fixture.context_payload())
        self.assertNotEqual(previous, changed["fingerprint"])

    def test_applies_explicit_child_precedence_and_direct_host_carry(self):
        fixture = _Fixture()
        report = fixture.service.reposition(fixture.apply_payload())

        self.assertEqual(report["status"], "applied")
        self.assertEqual((fixture.host.nodeX, fixture.host.nodeY), (200, -120))
        self.assertEqual((fixture.explicit_child.nodeX, fixture.explicit_child.nodeY), (430, -220))
        self.assertEqual((fixture.carried.nodeX, fixture.carried.nodeY), (240, -300))
        self.assertEqual(report["counts"], {
            "explicit": 2,
            "docked_carried": 1,
            "applied": 3,
            "unchanged": 0,
            "failed": 0,
        })
        by_path = {item["path"]: item for item in report["paths"]}
        self.assertEqual(by_path[fixture.explicit_child.path]["source"], "explicit")
        self.assertEqual(by_path[fixture.explicit_child.path]["host_path"], fixture.host.path)
        self.assertEqual(by_path[fixture.carried.path]["source"], "docked_carry")
        self.assertEqual(by_path[fixture.carried.path]["requested"], [240, -300])

    def test_include_docked_false_touches_only_explicit_paths(self):
        fixture = _Fixture()
        payload = fixture.apply_payload(include_docked=False)
        report = fixture.service.reposition(payload)

        self.assertEqual(report["counts"]["docked_carried"], 0)
        self.assertEqual((fixture.carried.nodeX, fixture.carried.nodeY), (40, -180))
        self.assertNotIn(fixture.carried.path, [item["path"] for item in report["paths"]])

    def test_noop_performs_no_setter_writes(self):
        fixture = _Fixture()
        payload = fixture.context_payload(include_docked=False)
        payload["positions"] = [
            {"path": fixture.host.path, "x": fixture.host.nodeX, "y": fixture.host.nodeY}
        ]
        context = fixture.service.context(payload)
        fixture.graph.events.clear()
        report = fixture.service.reposition(dict(
            payload,
            fingerprint=context["fingerprint"],
            editor_context=None,
            idempotency_key="wave10-reposition-noop-0001",
        ))

        self.assertEqual(report["status"], "unchanged")
        self.assertEqual(report["counts"]["applied"], 0)
        self.assertEqual(fixture.graph.events, [])

    def test_stale_geometry_rejects_before_any_write(self):
        fixture = _Fixture()
        payload = fixture.apply_payload()
        fixture.host._nodeX = 1
        fixture.graph.events.clear()

        with self.assertRaises(service.RepositionError) as raised:
            fixture.service.reposition(payload)
        self.assertEqual(raised.exception.code, "stale_reposition_context")
        self.assertEqual(fixture.graph.events, [])

    def test_partial_failure_rolls_back_every_position_and_returns_bounded_report(self):
        fixture = _Fixture()
        payload = fixture.apply_payload()
        fixture.explicit_child.fail_values["nodeY"].add(-220)

        with self.assertRaises(service.RepositionError) as raised:
            fixture.service.reposition(payload)

        self.assertEqual(raised.exception.code, "reposition_apply_failed")
        self.assertEqual((fixture.host.nodeX, fixture.host.nodeY), (0, 0))
        self.assertEqual((fixture.explicit_child.nodeX, fixture.explicit_child.nodeY), (40, -90))
        self.assertEqual((fixture.carried.nodeX, fixture.carried.nodeY), (40, -180))
        report = raised.exception.report
        self.assertTrue(report["rollback"]["succeeded"])
        self.assertTrue(all(item["rollback"] == "restored" for item in report["paths"]))
        self.assertNotIn("induced setter failure", json.dumps(report))

    def test_restore_failure_is_never_claimed_as_success(self):
        fixture = _Fixture()
        payload = fixture.apply_payload()
        fixture.explicit_child.fail_values["nodeY"].add(-220)
        fixture.host.fail_values["nodeX"].add(0)

        with self.assertRaises(service.RepositionError) as raised:
            fixture.service.reposition(payload)

        self.assertEqual(raised.exception.code, "reposition_rollback_failed")
        report = raised.exception.report
        self.assertFalse(report["rollback"]["succeeded"])
        self.assertEqual(report["rollback"]["errors"], [
            {"path": fixture.host.path, "message": "Exact position restoration failed."}
        ])
        self.assertNotEqual((fixture.host.nodeX, fixture.host.nodeY), (0, 0))

    def test_exact_retry_replays_once_and_conflicts_on_digest_or_live_state(self):
        fixture = _Fixture()
        payload = fixture.apply_payload()
        first = fixture.service.reposition(payload)
        fixture.graph.events.clear()
        fresh_context_payload = fixture.context_payload()
        fresh_context = fixture.service.context(fresh_context_payload)
        fresh_retry = dict(
            fresh_context_payload,
            fingerprint=fresh_context["fingerprint"],
            editor_context=fresh_context["editor_context"],
            idempotency_key=payload["idempotency_key"],
        )
        self.assertNotEqual(payload["fingerprint"], fresh_retry["fingerprint"])
        replay = fixture.service.reposition(fresh_retry)

        self.assertEqual(first["status"], "applied")
        self.assertEqual(replay["status"], "replayed")
        self.assertEqual(fixture.graph.events, [])

        changed_request = dict(fresh_retry, include_docked=False)
        with self.assertRaises(service.RepositionError) as raised:
            fixture.service.reposition(changed_request)
        self.assertEqual(raised.exception.code, "idempotency_conflict")

        fixture.host._nodeX += 1
        with self.assertRaises(service.RepositionError) as raised:
            fixture.service.reposition(payload)
        self.assertEqual(raised.exception.code, "idempotency_conflict")

    def test_receipts_expire_and_capacity_evicts_oldest(self):
        now = [0.0]
        fixture = _Fixture(clock=lambda: now[0])
        payload = fixture.apply_payload()
        fixture.service.reposition(payload)
        now[0] = 301.0
        context_payload = fixture.context_payload()
        context = fixture.service.context(context_payload)
        retry = dict(
            context_payload,
            fingerprint=context["fingerprint"],
            editor_context=None,
            idempotency_key=payload["idempotency_key"],
        )
        report = fixture.service.reposition(retry)
        self.assertEqual(report["status"], "unchanged")

        for index in range(129):
            key = "wave10-reposition-cap-%04d" % index
            fixture.service.reposition(dict(retry, idempotency_key=key))
        self.assertEqual(len(fixture.service._receipts), 128)
        self.assertNotIn("wave10-reposition-cap-0000", fixture.service._receipts)

    def test_active_selection_is_exact_compare_and_swap(self):
        fixture = _Fixture()
        payload = fixture.apply_payload(target_source="active_selection")
        report = fixture.service.reposition(payload)
        self.assertEqual(report["editor_context"], {
            "owner_path": fixture.root.path,
            "current_path": fixture.host.path,
            "selected_paths": sorted([fixture.host.path, fixture.explicit_child.path]),
        })

        fixture = _Fixture()
        payload = fixture.apply_payload(target_source="active_selection")
        fixture.root.currentChild = fixture.other
        fixture.graph.events.clear()
        with self.assertRaises(service.RepositionError) as raised:
            fixture.service.reposition(payload)
        self.assertEqual(raised.exception.code, "selection_mismatch")
        self.assertEqual(fixture.graph.events, [])

    def test_active_selection_fails_closed_without_usable_ui(self):
        cases = [
            (_Fixture(ui=False), "ui_unavailable"),
            (_Fixture(perform=True), "perform_mode"),
            (_Fixture(), "no_selection"),
        ]
        cases[-1][0].root.selectedChildren = []
        for fixture, code in cases:
            with self.subTest(code=code), self.assertRaises(service.RepositionError) as raised:
                fixture.service.context(
                    fixture.context_payload(target_source="active_selection")
                )
            self.assertEqual(raised.exception.code, code)

    def test_missing_cross_parent_and_invalid_inputs_fail_before_mutation(self):
        fixture = _Fixture()
        external_root = _Node(fixture.graph, "elsewhere", fixture.project)
        external = _Node(fixture.graph, "node", external_root)
        cases = [
            dict(fixture.context_payload(), root_path="/missing"),
            dict(fixture.context_payload(), positions=[
                {"path": external.path, "x": 0, "y": 0}
            ]),
            dict(fixture.context_payload(), positions=[
                {"path": fixture.host.path, "x": 1.5, "y": 0}
            ]),
            dict(fixture.context_payload(), positions=[
                {"path": fixture.host.path, "x": 1_000_001, "y": 0}
            ]),
        ]
        expected = [
            "reposition_root_not_found",
            "cross_parent_reposition",
            "invalid_reposition_input",
            "invalid_reposition_input",
        ]
        for payload, code in zip(cases, expected):
            fixture.graph.events.clear()
            with self.subTest(code=code), self.assertRaises(service.RepositionError) as raised:
                fixture.service.context(payload)
            self.assertEqual(raised.exception.code, code)
            self.assertEqual(fixture.graph.events, [])

    def test_ambiguous_cycle_and_unproven_nested_docking_fail_before_write(self):
        fixture = _Fixture()
        fixture.other.docked = [fixture.carried]
        payload = fixture.context_payload()
        payload["positions"].append({"path": fixture.other.path, "x": 10, "y": 10})
        payload["positions"] = sorted(payload["positions"], key=lambda item: item["path"])
        with self.assertRaises(service.RepositionError) as raised:
            fixture.service.context(payload)
        self.assertEqual(raised.exception.code, "ambiguous_dock_ownership")

        fixture = _Fixture()
        fixture.explicit_child.docked = [fixture.host]
        with self.assertRaises(service.RepositionError) as raised:
            fixture.service.context(fixture.context_payload())
        self.assertEqual(raised.exception.code, "unsupported_docking_shape")

        fixture = _Fixture()
        nested = _Node(fixture.graph, "nested", fixture.root)
        fixture.carried.docked = [nested]
        with self.assertRaises(service.RepositionError) as raised:
            fixture.service.context(fixture.context_payload())
        self.assertEqual(raised.exception.code, "unsupported_docking_shape")

    def test_carried_overflow_is_rejected_before_write(self):
        fixture = _Fixture()
        fixture.carried._nodeX = 1_000_000
        payload = fixture.context_payload()
        with self.assertRaises(service.RepositionError) as raised:
            fixture.service.context(payload)
        self.assertEqual(raised.exception.code, "invalid_reposition_input")
        self.assertEqual(fixture.graph.events, [])


if __name__ == "__main__":
    unittest.main()
