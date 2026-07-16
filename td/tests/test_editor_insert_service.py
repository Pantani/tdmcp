"""Offline contract tests for atomic editor insertion."""

import json
import os
import sys
import types
import unittest


_HERE = os.path.dirname(os.path.abspath(__file__))
_MODULES = os.path.abspath(os.path.join(_HERE, "..", "modules"))
if _MODULES not in sys.path:
    sys.path.insert(0, _MODULES)

from mcp.services import editor_insert_service as service  # noqa: E402


class _Parameter:
    def __init__(self, value=0):
        self._val = value

    @property
    def val(self):
        return self._val

    @val.setter
    def val(self, value):
        if isinstance(value, str) and value.startswith("reject-secret-"):
            raise RuntimeError("rejected value: %s" % value)
        self._val = value


class _Connector:
    def __init__(self, owner, index, is_input):
        self.owner = owner
        self.index = index
        self.is_input = is_input
        self.connections = []
        self.fail_source_name = None

    def connect(self, output):
        if not self.is_input:
            raise RuntimeError("connect must be called on an input connector")
        if self.fail_source_name == getattr(output.owner, "name", None):
            self.fail_source_name = None
            raise RuntimeError("induced connector failure")
        self.disconnect()
        self.connections.append(output)
        output.connections.append(self)

    def disconnect(self):
        if self.is_input:
            for output in list(self.connections):
                if self in output.connections:
                    output.connections.remove(self)
            self.connections = []
            return
        for input_connector in list(self.connections):
            input_connector.disconnect()


class _Node:
    def __init__(self, parent, op_type, name, inputs=1, outputs=1):
        self._parent = parent
        self.OPType = op_type
        self.name = name
        self.nodeX = 0
        self.nodeY = 0
        self.viewer = True
        self.par = types.SimpleNamespace(gain=_Parameter(1.0), label=_Parameter(""))
        self.inputConnectors = [
            _Connector(self, index, True) for index in range(inputs)
        ]
        self.outputConnectors = [
            _Connector(self, index, False) for index in range(outputs)
        ]
        self.fail_destroy = False

    @property
    def path(self):
        return "%s/%s" % (self._parent.path.rstrip("/"), self.name)

    def parent(self):
        return self._parent

    def destroy(self):
        if self.fail_destroy:
            raise RuntimeError("induced destroy failure")
        for connector in self.inputConnectors + self.outputConnectors:
            connector.disconnect()
        self._parent.children.remove(self)


class _Owner:
    def __init__(self, path="/project1/network"):
        self.path = path
        self.children = []
        self.selectedChildren = []
        self.currentChild = None
        self.create_calls = 0
        self.fail_created_destroy = False

    def add(self, op_type, name, x, y, inputs=1, outputs=1):
        node = _Node(self, op_type, name, inputs, outputs)
        node.nodeX = x
        node.nodeY = y
        self.children.append(node)
        return node

    def create(self, op_class, name=None):
        self.create_calls += 1
        op_type = op_class.__name__
        actual_name = name or "%s%d" % (op_type.removesuffix("TOP"), self.create_calls)
        inputs, outputs = (0, 1) if op_type == "constantTOP" else (1, 1)
        node = self.add(op_type, actual_name, 0, 0, inputs, outputs)
        node.fail_destroy = self.fail_created_destroy
        return node

    def op(self, name):
        return next((child for child in self.children if child.name == name), None)


class _Panes(list):
    def __init__(self, pane):
        super().__init__([pane] if pane is not None else [])
        self.current = pane


class _TOP:
    pass


class _CHOP:
    pass


class nullTOP(_TOP):
    pass


class levelTOP(_TOP):
    pass


class constantTOP(_TOP):
    pass


class nullCHOP(_CHOP):
    pass


class _Runtime:
    TOP = _TOP
    CHOP = _CHOP
    nullTOP = nullTOP
    levelTOP = levelTOP
    constantTOP = constantTOP
    nullCHOP = nullCHOP

    def __init__(
        self, owner, pane_type="PaneType.NETWORKEDITOR", ui=True, perform=False
    ):
        pane = types.SimpleNamespace(type=pane_type, owner=owner) if ui else None
        self.ui = (
            types.SimpleNamespace(panes=_Panes(pane), performMode=perform)
            if ui
            else None
        )
        self.project = types.SimpleNamespace(performMode=perform)
        self.owner = owner

    def op(self, path):
        if path == self.owner.path:
            return self.owner
        return next((node for node in self.owner.children if node.path == path), None)


def _connect(source, target, input_index=0, output_index=0):
    target.inputConnectors[input_index].connect(source.outputConnectors[output_index])


def _edges(owner):
    found = []
    for target in owner.children:
        for input_connector in target.inputConnectors:
            for output_connector in input_connector.connections:
                found.append(
                    (
                        output_connector.owner.path,
                        output_connector.index,
                        target.path,
                        input_connector.index,
                    )
                )
    return sorted(found)


class _Fixture:
    def __init__(self, fanout=False, multi_input=False, clock=None):
        self.owner = _Owner()
        if multi_input:
            self.source_a = self.owner.add("nullTOP", "source_a", 0, 120)
            self.selected = self.owner.add("nullTOP", "source_b", 0, -120)
            self.target = self.owner.add("compositeTOP", "target", 560, 0, inputs=2)
            _connect(self.source_a, self.target, input_index=0)
            _connect(self.selected, self.target, input_index=1)
        else:
            self.source = self.owner.add("nullTOP", "source", 0, 0)
            self.selected = self.owner.add("nullTOP", "old", 240, 0)
            self.target = self.owner.add(
                "nullTOP", "target_a" if fanout else "target", 520, 0
            )
            _connect(self.source, self.selected)
            _connect(self.selected, self.target)
            if fanout:
                self.target_b = self.owner.add("nullTOP", "target_b", 560, -120)
                _connect(self.selected, self.target_b)
        self.owner.selectedChildren = [self.selected]
        self.owner.currentChild = self.selected
        self.runtime = _Runtime(self.owner)
        self.service = service.EditorInsertService(self.runtime, clock=clock)

    def payload(self, **changes):
        payload = {
            "type": "levelTOP",
            "name": "inserted",
            "parameters": {"gain": 0.5},
            "expected_context": {
                "owner_path": self.owner.path,
                "selected_path": self.selected.path,
                "current_path": self.selected.path,
            },
            "idempotency_key": "wave7-insert-key-0001",
        }
        payload.update(changes)
        return payload


class EditorInsertServiceTest(unittest.TestCase):
    def test_single_chain_uses_explicit_layout_viewer_and_structured_edges(self):
        fixture = _Fixture()
        report = fixture.service.insert(fixture.payload())

        self.assertEqual(report["status"], "applied")
        self.assertEqual(report["node"]["path"], fixture.owner.path + "/inserted")
        self.assertEqual((report["node"]["nodeX"], report["node"]["nodeY"]), (380, 0))
        self.assertFalse(report["node"]["viewer"])
        self.assertEqual(fixture.owner.op("inserted").par.gain.val, 0.5)
        self.assertEqual(report["rollback"], {"attempted": False, "succeeded": True})
        self.assertEqual(
            _edges(fixture.owner),
            sorted(
                [
                    (fixture.source.path, 0, fixture.selected.path, 0),
                    (fixture.selected.path, 0, fixture.owner.path + "/inserted", 0),
                    (fixture.owner.path + "/inserted", 0, fixture.target.path, 0),
                ]
            ),
        )

    def test_fanout_replaces_only_the_stable_first_edge(self):
        fixture = _Fixture(fanout=True)
        report = fixture.service.insert(fixture.payload())
        inserted_path = report["node"]["path"]

        self.assertIn(
            (fixture.selected.path, 0, fixture.target_b.path, 0), _edges(fixture.owner)
        )
        self.assertIn((inserted_path, 0, fixture.target.path, 0), _edges(fixture.owner))
        self.assertNotIn(
            (fixture.selected.path, 0, fixture.target.path, 0), _edges(fixture.owner)
        )
        self.assertEqual(len(report["before"]["edges"]), 2)
        self.assertEqual(len(report["after"]["edges"]), 3)

    def test_multi_input_preserves_the_sibling_input(self):
        fixture = _Fixture(multi_input=True)
        before_input_zero = fixture.target.inputConnectors[0].connections[0]
        report = fixture.service.insert(fixture.payload())

        self.assertIs(
            fixture.target.inputConnectors[0].connections[0], before_input_zero
        )
        self.assertEqual(
            fixture.target.inputConnectors[1].connections[0].owner.path,
            report["node"]["path"],
        )

    def test_collision_search_uses_a_deterministic_non_overlapping_slot(self):
        fixture = _Fixture()
        fixture.owner.add("nullTOP", "blocker", 380, 0)
        report = fixture.service.insert(fixture.payload())

        self.assertEqual((report["node"]["nodeX"], report["node"]["nodeY"]), (380, 120))

    def test_exact_replay_does_not_create_again_and_conflicting_key_fails(self):
        fixture = _Fixture()
        first = fixture.service.insert(fixture.payload())
        create_calls = fixture.owner.create_calls
        replay = fixture.service.insert(fixture.payload())

        self.assertEqual(replay["status"], "replayed")
        self.assertEqual(replay["node"], first["node"])
        self.assertEqual(fixture.owner.create_calls, create_calls)
        with self.assertRaises(service.EditorInsertError) as caught:
            fixture.service.insert(fixture.payload(type="nullTOP"))
        self.assertEqual(caught.exception.code, "idempotency_conflict")

    def test_receipt_expires_after_bounded_ttl(self):
        now = [10.0]
        fixture = _Fixture(clock=lambda: now[0])
        fixture.service.insert(fixture.payload(name=None))
        now[0] += 301.0
        second = fixture.service.insert(fixture.payload(name=None))

        self.assertEqual(second["status"], "applied")
        self.assertEqual(fixture.owner.create_calls, 2)

    def test_stale_ambiguous_and_ui_states_fail_before_creation(self):
        stale = _Fixture()
        stale.owner.currentChild = stale.target
        with self.assertRaises(service.EditorInsertError) as caught:
            stale.service.insert(stale.payload())
        self.assertEqual(caught.exception.code, "stale_editor_context")
        self.assertEqual(stale.owner.create_calls, 0)

        ambiguous = _Fixture()
        ambiguous.owner.selectedChildren.append(ambiguous.target)
        with self.assertRaises(service.EditorInsertError) as caught:
            ambiguous.service.insert(ambiguous.payload())
        self.assertEqual(caught.exception.code, "ambiguous_selection")
        self.assertEqual(ambiguous.owner.create_calls, 0)

        empty = _Fixture()
        empty.owner.selectedChildren = []
        with self.assertRaises(service.EditorInsertError) as caught:
            empty.service.insert(empty.payload())
        self.assertEqual(caught.exception.code, "no_selection")

        wrong_pane = _Fixture()
        wrong_pane.service = service.EditorInsertService(
            _Runtime(wrong_pane.owner, pane_type="PaneType.PARAMETERS")
        )
        with self.assertRaises(service.EditorInsertError) as caught:
            wrong_pane.service.insert(wrong_pane.payload())
        self.assertEqual(caught.exception.code, "no_active_network_editor")

        headless = _Fixture()
        headless.service = service.EditorInsertService(
            _Runtime(headless.owner, ui=False)
        )
        with self.assertRaises(service.EditorInsertError) as caught:
            headless.service.insert(headless.payload())
        self.assertEqual(caught.exception.code, "ui_unavailable")

        perform = _Fixture()
        perform.service = service.EditorInsertService(
            _Runtime(perform.owner, perform=True)
        )
        with self.assertRaises(service.EditorInsertError) as caught:
            perform.service.insert(perform.payload())
        self.assertEqual(caught.exception.code, "perform_mode")

    def test_type_family_shape_and_parameter_failures_are_typed_and_compensated(self):
        fixture = _Fixture()
        with self.assertRaises(service.EditorInsertError) as caught:
            fixture.service.insert(fixture.payload(type="missingTOP"))
        self.assertEqual(caught.exception.code, "unsupported_operator_type")
        self.assertEqual(fixture.owner.create_calls, 0)

        family = _Fixture()
        with self.assertRaises(service.EditorInsertError) as caught:
            family.service.insert(family.payload(type="nullCHOP"))
        self.assertEqual(caught.exception.code, "unsupported_family")
        self.assertEqual(family.owner.create_calls, 0)

        multiple_outputs = _Fixture()
        multiple_outputs.selected.outputConnectors.append(
            _Connector(multiple_outputs.selected, 1, False)
        )
        second_target = multiple_outputs.owner.add(
            "nullTOP", "second_target", 520, -160
        )
        _connect(multiple_outputs.selected, second_target, output_index=1)
        with self.assertRaises(service.EditorInsertError) as caught:
            multiple_outputs.service.insert(multiple_outputs.payload())
        self.assertEqual(caught.exception.code, "unsupported_connector_shape")
        self.assertEqual(multiple_outputs.owner.create_calls, 0)

        shape = _Fixture()
        before = _edges(shape.owner)
        with self.assertRaises(service.EditorInsertError) as caught:
            shape.service.insert(shape.payload(type="constantTOP"))
        self.assertEqual(caught.exception.code, "placement_failed")
        self.assertTrue(caught.exception.report["rollback"]["succeeded"])
        self.assertEqual(_edges(shape.owner), before)
        self.assertIsNone(shape.owner.op("inserted"))

        parameter = _Fixture()
        before = _edges(parameter.owner)
        with self.assertRaises(service.EditorInsertError) as caught:
            parameter.service.insert(parameter.payload(parameters={"missing": 1}))
        self.assertEqual(caught.exception.code, "placement_failed")
        self.assertEqual(_edges(parameter.owner), before)

    def test_reverse_connector_proxy_uses_structural_identity(self):
        fixture = _Fixture()
        chosen = service._chosen_downstream(fixture.selected)
        original = chosen[1]
        proxy = types.SimpleNamespace(
            owner=original.owner,
            index=original.index,
            isInput=False,
        )
        chosen[2].connections = [proxy]

        self.assertIs(service._validate_downstream_target(fixture.owner, chosen), fixture.target)

        proxy.index = original.index + 1
        with self.assertRaises(service.EditorInsertError) as caught:
            service._validate_downstream_target(fixture.owner, chosen)
        self.assertEqual(caught.exception.code, "unsupported_connector_shape")

    def test_mid_rewire_failure_restores_exact_graph_and_replays_the_failure(self):
        fixture = _Fixture()
        before = _edges(fixture.owner)
        fixture.target.inputConnectors[0].fail_source_name = "inserted"
        with self.assertRaises(service.EditorInsertError) as caught:
            fixture.service.insert(fixture.payload())

        self.assertEqual(caught.exception.code, "rewire_failed")
        self.assertTrue(caught.exception.report["rollback"]["succeeded"])
        self.assertEqual(_edges(fixture.owner), before)
        self.assertIsNone(fixture.owner.op("inserted"))
        create_calls = fixture.owner.create_calls
        with self.assertRaises(service.EditorInsertError) as replayed:
            fixture.service.insert(fixture.payload())
        self.assertTrue(replayed.exception.report["replayed"])
        self.assertEqual(fixture.owner.create_calls, create_calls)

    def test_multi_input_rollback_preserves_the_unaffected_input(self):
        fixture = _Fixture(multi_input=True)
        input_zero = fixture.target.inputConnectors[0].connections[0]
        before = _edges(fixture.owner)
        fixture.target.inputConnectors[1].fail_source_name = "inserted"
        with self.assertRaises(service.EditorInsertError) as caught:
            fixture.service.insert(fixture.payload())

        self.assertEqual(caught.exception.code, "rewire_failed")
        self.assertIs(fixture.target.inputConnectors[0].connections[0], input_zero)
        self.assertEqual(_edges(fixture.owner), before)

    def test_receipts_are_capped_and_do_not_retain_parameter_values(self):
        fixture = _Fixture()
        fixture.service.insert(
            fixture.payload(parameters={"label": "sensitive-project-value"})
        )
        self.assertNotIn(
            "sensitive-project-value",
            json.dumps(fixture.service._receipts, sort_keys=True),
        )

        failed = _Fixture()
        with self.assertRaises(service.EditorInsertError) as caught:
            failed.service.insert(
                failed.payload(parameters={"label": "reject-secret-project-value"})
            )
        self.assertNotIn("reject-secret-project-value", str(caught.exception))
        self.assertNotIn(
            "reject-secret-project-value",
            json.dumps(failed.service._receipts, sort_keys=True),
        )

        for index in range(129):
            fixture.service._store(
                "receipt-%03d" % index,
                "digest-%03d" % index,
                {"status": "applied", "node": {"path": "/n"}},
                float(index),
            )
        self.assertEqual(len(fixture.service._receipts), 128)
        self.assertNotIn("receipt-000", fixture.service._receipts)

    def test_unconfirmed_compensation_is_rollback_failed(self):
        fixture = _Fixture()
        fixture.owner.fail_created_destroy = True
        fixture.target.inputConnectors[0].fail_source_name = "inserted"
        with self.assertRaises(service.EditorInsertError) as caught:
            fixture.service.insert(fixture.payload())

        self.assertEqual(caught.exception.code, "rollback_failed")
        self.assertFalse(caught.exception.report["rollback"]["succeeded"])


if __name__ == "__main__":
    unittest.main()
