import copy
import os
import sys
import types
import unittest
from unittest import mock


_HERE = os.path.dirname(os.path.abspath(__file__))
_MODULES = os.path.abspath(os.path.join(_HERE, "..", "modules"))
if _MODULES not in sys.path:
    sys.path.insert(0, _MODULES)

from mcp.services import operation_plan_service as plan_service  # noqa: E402
from mcp.services import operation_td_adapter as adapter  # noqa: E402


PRINCIPAL = "oauth-client-operation-adapter"


class _Marker:
    type_name = ""


def _marker(name):
    return type(name, (_Marker,), {"type_name": name})


class FakePar:
    def __init__(self, owner, name, value=0.0, style="Float", mode="CONSTANT"):
        self.owner = owner
        self.name = name
        self._value = value
        self.style = style
        self.mode = mode
        self.readOnly = False
        self.menuNames = []
        self.menuLabels = []

    @property
    def val(self):
        return self._value

    @val.setter
    def val(self, value):
        self.owner._td.events.append("par:%s:%s" % (self.owner.path, self.name))
        self._value = copy.deepcopy(value)

    def eval(self):
        return copy.deepcopy(self._value)


class FakeParCollection:
    def __init__(self, owner):
        self._owner = owner
        self._values = {}

    def add(self, name, value=0.0, style="Float", mode="CONSTANT"):
        parameter = FakePar(self._owner, name, value, style, mode)
        self._values[name] = parameter
        return parameter

    def __getattr__(self, name):
        try:
            return self._values[name]
        except KeyError as exc:
            raise AttributeError(name) from exc


class FakeConnector:
    def __init__(self, owner, index, is_input):
        self.owner = owner
        self.index = index
        self.isInput = is_input
        self.connections = []

    def connect(self, output):
        if not self.isInput or output.isInput:
            raise RuntimeError("invalid connector direction")
        td = self.owner._td
        td.events.append("connect:%s:%s" % (output.owner.path, self.owner.path))
        if td.fail_connect and self.owner.path == "/project1/show/d":
            if td.conflict_on_connect:
                node = td.op("/project1/show/insert1")
                if node is not None:
                    node.par.opacity.val = 0.75
            raise RuntimeError("injected connect failure")
        self.disconnect()
        self.connections.append(output)
        output.connections.append(self)

    def disconnect(self):
        if not self.isInput:
            raise RuntimeError("only input disconnect is supported by the fake")
        for output in list(self.connections):
            if self in output.connections:
                output.connections.remove(self)
        self.connections = []


class FakeNode:
    def __init__(self, td, parent, name, type_name):
        self._td = td
        self._parent = parent
        self.name = name
        self.OPType = type_name
        self.type = type_name
        self.id = td.next_id()
        self.children = []
        self.par = FakeParCollection(self)
        self.nodeX = 0
        self.nodeY = 0
        self.nodeWidth = 160
        self.nodeHeight = 100
        self.viewer = False
        self.color = [0.0, 0.0, 0.0]
        self.comment = ""
        self.bypass = False
        self.display = False
        self.render = False
        self.selectedChildren = []
        self.currentChild = None
        self.text = ""
        input_count, output_count = _connector_counts(type_name)
        self.inputConnectors = [FakeConnector(self, index, True) for index in range(input_count)]
        self.outputConnectors = [
            FakeConnector(self, index, False) for index in range(output_count)
        ]
        if type_name in ("nullTOP", "nullCHOP", "nullSOP", "nullDAT"):
            self.par.add("opacity", 0.0)
        if type_name == "annotateCOMP":
            self._add_annotation_parameters()
        if parent is not None:
            parent.children.append(self)
        td._nodes[self.path] = self

    @property
    def path(self):
        if self._parent is None:
            return "/"
        prefix = self._parent.path.rstrip("/")
        return "%s/%s" % (prefix, self.name)

    def _add_annotation_parameters(self):
        self.par.add("Titletext", "", style="Str")
        self.par.add("Bodytext", "", style="Str")
        self.par.add("Backcolorr", 0.2)
        self.par.add("Backcolorg", 0.2)
        self.par.add("Backcolorb", 0.2)
        self.par.add("Backcoloralpha", 1.0)

    def op(self, name):
        return next((child for child in self.children if child.name == name), None)

    def create(self, operator_class, name=None):
        type_name = operator_class.type_name
        requested = name or "%s1" % type_name
        if self.op(requested) is not None:
            raise RuntimeError("name collision")
        return FakeNode(self._td, self, requested, type_name)

    def destroy(self):
        for child in list(self.children):
            child.destroy()
        for connector in list(self.inputConnectors):
            connector.disconnect()
        for output in list(self.outputConnectors):
            for input_connector in list(output.connections):
                input_connector.disconnect()
        old_path = self.path
        if self._parent is not None and self in self._parent.children:
            self._parent.children.remove(self)
        self._td._nodes.pop(old_path, None)
        self._td.events.append("destroy:%s" % old_path)


def _connector_counts(type_name):
    if type_name in ("baseCOMP", "annotateCOMP", "rootCOMP"):
        return 0, 0
    if type_name.startswith("constant"):
        return 0, 1
    return 1, 1


class FakePane:
    type = "NETWORKEDITOR"
    name = "pane1"

    def __init__(self, owner):
        self.owner = owner


class FakePanes(list):
    def __init__(self, pane):
        super().__init__([pane])
        self.current = pane


class FakeUndo:
    def __init__(self):
        self.globalState = True
        self.state = False
        self.fail_add_callback = False
        self.fail_end_block = False
        self._undo = []
        self._redo = []
        self._building = None

    @property
    def undoStack(self):
        return [record["label"] for record in self._undo]

    @property
    def redoStack(self):
        return [record["label"] for record in self._redo]

    def startBlock(self, label):
        if self.state:
            raise RuntimeError("busy")
        self.state = True
        self._building = {"label": label, "callback": None, "info": None}

    def addCallback(self, callback, info):
        if not self.state or self._building is None:
            raise RuntimeError("no block")
        if self.fail_add_callback:
            raise RuntimeError("injected callback failure")
        self._building["callback"] = callback
        self._building["info"] = info

    def endBlock(self):
        if not self.state or self._building is None:
            raise RuntimeError("no block")
        record = self._building
        self._building = None
        self.state = False
        if record["callback"] is not None:
            self._undo.insert(0, record)
            self._redo = []
        if self.fail_end_block:
            raise RuntimeError("injected end failure")

    def undo(self):
        record = self._undo.pop(0)
        self.state = True
        try:
            record["callback"](True, record["info"])
        finally:
            self.state = False
        self._redo.insert(0, record)

    def redo(self):
        record = self._redo.pop(0)
        self.state = True
        try:
            record["callback"](False, record["info"])
        finally:
            self.state = False
        self._undo.insert(0, record)


class FakeTD(types.SimpleNamespace):
    def __init__(self):
        super().__init__()
        self._nodes = {}
        self._next_id = 100
        self.events = []
        self.fail_connect = False
        self.conflict_on_connect = False
        for name in (
            "baseCOMP",
            "constantCHOP",
            "constantTOP",
            "nullCHOP",
            "nullDAT",
            "nullSOP",
            "nullTOP",
            "textDAT",
            "annotateCOMP",
        ):
            setattr(self, name, _marker(name))
        root = FakeNode(self, None, "", "rootCOMP")
        project1 = FakeNode(self, root, "project1", "baseCOMP")
        show = FakeNode(self, project1, "show", "baseCOMP")
        self.root = root
        self.project1 = project1
        self.show = show
        self.app = types.SimpleNamespace(build=32820, version="2025.30000")
        self.project = types.SimpleNamespace(
            name="fake-project",
            folder="/private/fake",
            performMode=False,
        )
        self.ui = types.SimpleNamespace(
            performMode=False,
            undo=FakeUndo(),
            panes=FakePanes(FakePane(show)),
        )
        self.a = self.add_node("a", "nullTOP", x=0, y=0)
        self.b = self.add_node("b", "nullTOP", x=300, y=0)
        self.c = self.add_node("c", "nullTOP", x=0, y=-200)
        self.d = self.add_node("d", "nullTOP", x=300, y=-200)
        self.a.par.add("gain", 0.0)
        self.show.currentChild = self.a
        self.show.selectedChildren = [self.a]
        self.b.inputConnectors[0].connect(self.a.outputConnectors[0])
        self.events = []

    def next_id(self):
        self._next_id += 1
        return self._next_id

    def op(self, path):
        return self._nodes.get(path)

    def add_node(self, name, type_name, x=0, y=0):
        node = FakeNode(self, self.show, name, type_name)
        node.nodeX = x
        node.nodeY = y
        return node


class FakeSnapshotAdapter(plan_service.ScalarSnapshotAdapter):
    def __init__(self, td):
        self.td = td

    def capture(self, canonical_plan, affected_paths, requested_operator_types):
        return adapter.capture_scalar_snapshot(
            self.td,
            canonical_plan,
            affected_paths,
            requested_operator_types,
        )


def operation_plan():
    return {
        "schema_version": 1,
        "label": "Wave 14 mixed transaction",
        "owner_path": "/project1/show",
        "expected_context": {
            "owner_path": "/project1/show",
            "current_path": "/project1/show/a",
            "selected_paths": ["/project1/show/a"],
        },
        "intents": [
            {
                "kind": "create_operator",
                "ref": "insert",
                "type": "nullTOP",
                "name": "insert1",
                "parent": {"path": "/project1/show"},
                "position": {"x": 180, "y": 120},
                "viewer": False,
            },
            {
                "kind": "set_constant_parameters",
                "target": {"ref": "insert"},
                "values": {"opacity": 0.5},
            },
            {
                "kind": "edit_metadata",
                "target": {"path": "/project1/show/a"},
                "position": {"x": 10, "y": 20},
                "comment": "bounded note",
            },
            {
                "kind": "disconnect",
                "source": {"path": "/project1/show/a"},
                "source_output": 0,
                "target": {"path": "/project1/show/b"},
                "target_input": 0,
            },
            {
                "kind": "connect",
                "source": {"path": "/project1/show/c"},
                "source_output": 0,
                "target": {"path": "/project1/show/d"},
                "target_input": 0,
            },
            {
                "kind": "create_annotation",
                "ref": "note",
                "name": "note1",
                "parent": {"path": "/project1/show"},
                "bounds": {"x": 520, "y": 120, "w": 240, "h": 120},
                "title": "Safe title",
                "body": "Safe body",
                "color": [0.1, 0.2, 0.3],
            },
        ],
    }


def single_created_node_plan():
    source = operation_plan()
    source["label"] = "Created intrinsic exact CAS"
    source["intents"] = [copy.deepcopy(source["intents"][0])]
    source["intents"][0]["position"] = {"x": 240, "y": 220}
    return source


def created_intrinsics_plan():
    source = operation_plan()
    source["label"] = "Created intrinsic journal coverage"
    source["intents"] = [
        {
            "kind": "create_operator",
            "ref": "group",
            "type": "baseCOMP",
            "name": "group1",
            "parent": {"path": "/project1/show"},
            "position": {"x": 240, "y": 220},
            "viewer": True,
        },
        {
            "kind": "create_operator",
            "ref": "text",
            "type": "textDAT",
            "name": "text1",
            "parent": {"ref": "group"},
            "position": {"x": 40, "y": -40},
            "viewer": False,
        },
        {
            "kind": "create_annotation",
            "ref": "note",
            "name": "note_intrinsics",
            "parent": {"path": "/project1/show"},
            "bounds": {"x": 520, "y": 120, "w": 240, "h": 120},
            "title": "Safe title",
            "body": "Safe body",
            "color": [0.1, 0.2, 0.3],
        },
    ]
    return source


def _prepared(td, source=None):
    source = source or operation_plan()
    snapshot = FakeSnapshotAdapter(td)
    service = plan_service.OperationPlanService(
        snapshot,
        secret=b"a" * 32,
        bridge_instance_id="bridge-instance-adapter",
    )
    preview = service.preview(source, PRINCIPAL)
    commit = {
        **source,
        "preview_token": preview["preview_token"],
        "idempotency_key": "wave14-adapter-key-01",
    }
    prepared, _, _ = service.prepare_commit(commit, PRINCIPAL)
    return prepared


def _assert_scalar(test, value):
    if value is None or type(value) in (bool, int, float, str):
        return
    if type(value) is list:
        for item in value:
            _assert_scalar(test, item)
        return
    if type(value) is dict:
        for key, item in value.items():
            test.assertIs(type(key), str)
            _assert_scalar(test, item)
        return
    test.fail("non-scalar journal value retained: %r" % (type(value),))


class OperationTdAdapterTests(unittest.TestCase):
    def setUp(self):
        adapter._JOURNALS.clear()
        self.td = FakeTD()

    def tearDown(self):
        adapter._JOURNALS.clear()

    def test_native_root_zero_is_a_valid_exact_identity(self):
        self.assertEqual(adapter._identity(types.SimpleNamespace(id=0)), 0)
        with self.assertRaises(adapter.OperationTdAdapterError):
            adapter._identity(types.SimpleNamespace(id=-1))
        adapter._JOURNALS.clear()

    def _with_fake_td(self):
        class FakeTdModule:
            def __enter__(inner_self):
                inner_self.previous = sys.modules.get("td")
                sys.modules["td"] = self.td

            def __exit__(inner_self, exc_type, exc, traceback):
                if inner_self.previous is None:
                    sys.modules.pop("td", None)
                else:
                    sys.modules["td"] = inner_self.previous

        return FakeTdModule()

    def test_snapshot_is_exact_scalar_and_context_bound(self):
        prepared = _prepared(self.td)
        _assert_scalar(self, prepared.snapshot)
        self.assertEqual(prepared.snapshot["context"]["owner_path"], "/project1/show")
        self.assertEqual(prepared.snapshot["context"]["selected_paths"], ["/project1/show/a"])
        rendered = repr(prepared.snapshot)
        self.assertNotIn("FakeNode", rendered)
        self.assertNotIn("FakePar", rendered)
        self.assertNotIn("FakeConnector", rendered)
        live_adapter = adapter.TouchDesignerOperationAdapter()
        self.assertEqual(live_adapter.__dict__, {})

    def test_mixed_commit_registers_one_scalar_journal_and_replays_without_labels_as_authority(self):
        prepared = _prepared(self.td)
        operation_id = "operation-wave14-adapter"
        label = "MCP operation Wave 14 adapter"
        outcome = adapter.execute_td_transaction(self.td, prepared, operation_id, label)
        plan_service.OperationPlanService._validate_outcome_semantics(
            outcome,
            operation_id,
            label,
        )
        self.assertEqual(outcome.status, "applied")
        self.assertEqual(self.td.ui.undo.undoStack, [label])
        self.assertEqual(adapter.observe_operation(operation_id, self.td), "applied")
        record = self.td.ui.undo._undo[0]
        _assert_scalar(self, record["info"])
        self.assertFalse(any(callable(value) for value in record["info"].values()))
        self.assertNotIn(label, repr(record["info"]))
        record["label"] = "artist-visible-label-changed"
        self.assertEqual(adapter.observe_operation(operation_id, self.td), "applied")

        first_identity = self.td.op("/project1/show/insert1").id
        with self._with_fake_td():
            self.td.ui.undo.undo()
        self.assertIsNone(self.td.op("/project1/show/insert1"))
        self.assertIsNone(self.td.op("/project1/show/note1"))
        self.assertEqual(self.td.a.nodeX, 0)
        self.assertEqual(self.td.a.comment, "")
        self.assertTrue(
            adapter._edge_present(
                self.td,
                "/project1/show/a",
                0,
                "/project1/show/b",
                0,
            )
        )
        self.assertEqual(adapter.observe_operation(operation_id, self.td), "undone")

        with self._with_fake_td():
            self.td.ui.undo.redo()
        second_identity = self.td.op("/project1/show/insert1").id
        self.assertNotEqual(first_identity, second_identity)
        self.assertEqual(adapter.observe_operation(operation_id, self.td), "redone")
        self.td.a.comment = "artist drift"
        self.assertEqual(adapter.observe_operation(operation_id, self.td), "drifted")
        self.td.a.comment = "bounded note"
        self.assertEqual(adapter.observe_operation(operation_id, self.td), "drifted")

    def test_journal_v2_captures_final_intrinsic_state_for_every_create(self):
        prepared = _prepared(self.td, created_intrinsics_plan())
        outcome = adapter.execute_td_transaction(
            self.td,
            prepared,
            "operation-created-intrinsics",
            "MCP operation created intrinsic coverage",
        )

        self.assertEqual(outcome.status, "applied")
        info = self.td.ui.undo._undo[0]["info"]
        self.assertEqual(info["schema_version"], 2)
        _assert_scalar(self, info)
        self.assertLessEqual(
            len(adapter._canonical_json(info)),
            adapter.MAX_JOURNAL_BYTES,
        )

        before = info["source_snapshot"]["created_intrinsics"]
        after = info["target_snapshot"]["created_intrinsics"]
        expected_paths = {
            "/project1/show/group1",
            "/project1/show/group1/text1",
            "/project1/show/note_intrinsics",
        }
        self.assertEqual(set(before), expected_paths)
        self.assertTrue(all(fact == {"exists": False} for fact in before.values()))
        self.assertEqual(set(after), expected_paths)

        group = after["/project1/show/group1"]
        self.assertEqual(
            group["node"],
            {
                "position": {"x": 240, "y": 220},
                "viewer": True,
                "color": [0.0, 0.0, 0.0],
                "comment": "",
                "children": ["/project1/show/group1/text1"],
            },
        )
        text = after["/project1/show/group1/text1"]
        self.assertEqual(text["node"]["position"], {"x": 40, "y": -40})
        self.assertEqual(text["text"], "")
        annotation = after["/project1/show/note_intrinsics"]
        self.assertEqual(annotation["node"]["position"], {"x": 520, "y": 120})
        self.assertEqual(annotation["annotation"]["width"], 240)
        self.assertEqual(annotation["annotation"]["height"], 120)
        self.assertEqual(
            annotation["annotation"]["parameters"]["Titletext"],
            "Safe title",
        )
        self.assertEqual(
            annotation["annotation"]["parameters"]["Bodytext"],
            "Safe body",
        )

    def test_created_position_drift_is_observed_and_blocks_guarded_undo(self):
        prepared = _prepared(self.td, single_created_node_plan())
        operation_id = "operation-created-position-drift"
        outcome = adapter.execute_td_transaction(
            self.td,
            prepared,
            operation_id,
            "MCP operation created position drift",
        )
        self.assertEqual(outcome.status, "applied")
        created = self.td.op("/project1/show/insert1")
        self.assertEqual((created.nodeX, created.nodeY), (240, 220))

        # Regression for the live A4 probe: recording-off artist drift from
        # x=240 to x=241 must invalidate both receipt observation and Undo CAS.
        created.nodeX = 241
        self.assertEqual(adapter.observe_operation(operation_id, self.td), "drifted")
        with self._with_fake_td():
            self.td.ui.undo.undo()
        self.assertIs(self.td.op("/project1/show/insert1"), created)
        self.assertEqual(created.nodeX, 241)
        self.assertEqual(adapter._JOURNALS[operation_id]["state"], "drifted")

    def test_every_created_intrinsic_family_invalidates_observation(self):
        def mutate_viewer(td):
            td.op("/project1/show/group1").viewer = False

        def mutate_color(td):
            td.op("/project1/show/group1").color = [0.2, 0.3, 0.4]

        def mutate_comment(td):
            td.op("/project1/show/group1").comment = "artist note"

        def mutate_children(td):
            FakeNode(td, td.op("/project1/show/group1"), "artist_child", "nullTOP")

        def mutate_text(td):
            td.op("/project1/show/group1/text1").text = "artist text"

        def mutate_annotation_size(td):
            td.op("/project1/show/note_intrinsics").nodeWidth = 241

        def mutate_annotation_text(td):
            td.op("/project1/show/note_intrinsics").par.Titletext.val = "Artist title"

        cases = {
            "viewer": mutate_viewer,
            "color": mutate_color,
            "comment": mutate_comment,
            "children": mutate_children,
            "text": mutate_text,
            "annotation_size": mutate_annotation_size,
            "annotation_text": mutate_annotation_text,
        }
        for index, (name, mutate) in enumerate(cases.items()):
            with self.subTest(field=name):
                td = FakeTD()
                prepared = _prepared(td, created_intrinsics_plan())
                operation_id = "operation-intrinsic-drift-%02d" % index
                outcome = adapter.execute_td_transaction(
                    td,
                    prepared,
                    operation_id,
                    "MCP operation intrinsic drift %s" % name,
                )
                self.assertEqual(outcome.status, "applied")
                self.assertEqual(adapter.observe_operation(operation_id, td), "applied")
                mutate(td)
                self.assertEqual(adapter.observe_operation(operation_id, td), "drifted")

    def test_hot_reloaded_callback_accepts_legacy_v1_journal_shape(self):
        prepared = _prepared(self.td, single_created_node_plan())
        operation_id = "operation-legacy-v1-hot-reload"
        outcome = adapter.execute_td_transaction(
            self.td,
            prepared,
            operation_id,
            "MCP operation legacy callback",
        )
        self.assertEqual(outcome.status, "applied")
        current = self.td.ui.undo._undo[0]["info"]
        legacy = {
            "schema_version": adapter.LEGACY_JOURNAL_SCHEMA_VERSION,
            "operation_id": current["operation_id"],
            "plan": copy.deepcopy(current["plan"]),
            "affected_paths": copy.deepcopy(current["affected_paths"]),
            "requested_types": copy.deepcopy(current["requested_types"]),
            "before": copy.deepcopy(current["source_snapshot"]),
            "after": copy.deepcopy(current["target_snapshot"]),
            "actions": copy.deepcopy(current["inverse_actions"]),
        }
        legacy["before"].pop("created_intrinsics")
        legacy["after"].pop("created_intrinsics")

        with self._with_fake_td():
            adapter.operation_journal_callback(True, legacy)
        self.assertIsNone(self.td.op("/project1/show/insert1"))
        self.assertEqual(adapter.observe_operation(operation_id, self.td), "undone")

        with self._with_fake_td():
            adapter.operation_journal_callback(False, legacy)
        recreated = self.td.op("/project1/show/insert1")
        self.assertIsNotNone(recreated)
        self.assertEqual((recreated.nodeX, recreated.nodeY), (240, 220))
        self.assertEqual(adapter.observe_operation(operation_id, self.td), "redone")

    def test_journal_v2_byte_cap_fails_closed_and_rolls_back(self):
        original_cap = adapter.MAX_JOURNAL_BYTES
        adapter.MAX_JOURNAL_BYTES = 1_024
        try:
            prepared = _prepared(self.td, created_intrinsics_plan())
            outcome = adapter.execute_td_transaction(
                self.td,
                prepared,
                "operation-v2-journal-cap",
                "MCP operation v2 journal cap",
            )
            self.assertEqual(outcome.status, "failed_rolled_back")
            self.assertEqual(outcome.error_code, "operation_capacity")
            self.assertIsNone(self.td.op("/project1/show/group1"))
            self.assertIsNone(self.td.op("/project1/show/note_intrinsics"))
            self.assertEqual(self.td.ui.undo.undoStack, [])
        finally:
            adapter.MAX_JOURNAL_BYTES = original_cap

    def test_post_write_snapshot_failure_restores_before_without_journal(self):
        prepared = _prepared(self.td, single_created_node_plan())
        original_capture = adapter._capture_prepared
        calls = {"count": 0}

        def fail_post_write(td, current_prepared):
            calls["count"] += 1
            if calls["count"] == 2:
                raise adapter.OperationTdAdapterError("verification_failed")
            return original_capture(td, current_prepared)

        with mock.patch.object(
            adapter,
            "_capture_prepared",
            side_effect=fail_post_write,
        ):
            outcome = adapter.execute_td_transaction(
                self.td,
                prepared,
                "operation-post-write-capture-failure",
                "MCP operation post-write capture failure",
            )

        self.assertEqual(outcome.status, "failed_rolled_back")
        self.assertEqual(outcome.error_code, "verification_failed")
        self.assertIsNone(self.td.op("/project1/show/insert1"))
        self.assertEqual(self.td.ui.undo.undoStack, [])
        self.assertTrue(self.td.ui.undo.globalState)

    def test_partial_apply_failure_rolls_back_in_reverse_order_without_journal(self):
        prepared = _prepared(self.td)
        self.td.fail_connect = True
        outcome = adapter.execute_td_transaction(
            self.td,
            prepared,
            "operation-wave14-failure",
            "MCP operation failure",
        )
        self.assertEqual(outcome.status, "failed_rolled_back")
        self.assertIsNone(self.td.op("/project1/show/insert1"))
        self.assertEqual(self.td.ui.undo.undoStack, [])
        restore_index = max(
            index
            for index, event in enumerate(self.td.events)
            if event == "par:/project1/show/insert1:opacity"
        )
        destroy_index = self.td.events.index("destroy:/project1/show/insert1")
        self.assertLess(restore_index, destroy_index)
        self.assertTrue(self.td.ui.undo.globalState)
        self.assertFalse(self.td.ui.undo.state)

    def test_rollback_conflict_preserves_diverged_created_node_and_reports_residue(self):
        prepared = _prepared(self.td)
        self.td.fail_connect = True
        self.td.conflict_on_connect = True
        outcome = adapter.execute_td_transaction(
            self.td,
            prepared,
            "operation-wave14-conflict",
            "MCP operation conflict",
        )
        self.assertEqual(outcome.status, "failed_rollback")
        self.assertIsNotNone(self.td.op("/project1/show/insert1"))
        self.assertEqual(self.td.op("/project1/show/insert1").par.opacity.eval(), 0.75)
        self.assertFalse(outcome.rollback.succeeded)
        self.assertEqual(self.td.ui.undo.undoStack, [])

    def test_drift_before_native_undo_is_a_fail_closed_noop(self):
        prepared = _prepared(self.td)
        operation_id = "operation-wave14-drift"
        outcome = adapter.execute_td_transaction(
            self.td,
            prepared,
            operation_id,
            "MCP operation drift",
        )
        self.assertEqual(outcome.status, "applied")
        self.td.a.comment = "artist changed affected field"
        with self._with_fake_td():
            self.td.ui.undo.undo()
        self.assertIsNotNone(self.td.op("/project1/show/insert1"))
        self.assertEqual(self.td.a.comment, "artist changed affected field")
        self.assertEqual(adapter.observe_operation(operation_id, self.td), "drifted")

    def test_perform_global_off_and_busy_fail_before_any_write(self):
        cases = ("perform", "global_off", "busy")
        for case in cases:
            with self.subTest(case=case):
                td = FakeTD()
                prepared = _prepared(td)
                if case == "perform":
                    td.ui.performMode = True
                elif case == "global_off":
                    td.ui.undo.globalState = False
                else:
                    td.ui.undo.state = True
                event_count = len(td.events)
                outcome = adapter.execute_td_transaction(
                    td,
                    prepared,
                    "operation-wave14-%s" % case,
                    "MCP operation preflight",
                )
                self.assertEqual(outcome.status, "failed_rolled_back")
                self.assertEqual(len(td.events), event_count)
                self.assertIsNone(td.op("/project1/show/insert1"))
                self.assertEqual(td.ui.undo.undoStack, [])

    def test_callback_registration_failure_rolls_back_but_orphan_risk_is_unknown(self):
        td = FakeTD()
        prepared = _prepared(td)
        td.ui.undo.fail_add_callback = True
        failed = adapter.execute_td_transaction(
            td,
            prepared,
            "operation-wave14-add-failure",
            "MCP operation add failure",
        )
        self.assertEqual(failed.status, "failed_rolled_back")
        self.assertIsNone(td.op("/project1/show/insert1"))
        self.assertEqual(td.ui.undo.undoStack, [])

        td = FakeTD()
        prepared = _prepared(td)
        td.ui.undo.fail_end_block = True
        unknown = adapter.execute_td_transaction(
            td,
            prepared,
            "operation-wave14-end-failure",
            "MCP operation end failure",
        )
        self.assertEqual(unknown.status, "outcome_unknown")
        self.assertIsNotNone(td.op("/project1/show/insert1"))
        self.assertEqual(len(td.ui.undo.undoStack), 1)

    def test_journal_capacity_fails_closed_before_mutation_without_eviction(self):
        self.assertGreater(
            adapter.JOURNAL_TTL_SECONDS,
            plan_service.RECEIPT_TTL_SECONDS,
        )
        original_capacity = adapter.MAX_JOURNALS
        adapter.MAX_JOURNALS = 1
        try:
            adapter._remember_journal(
                {"operation_id": "retained-operation-01"},
                "applied",
            )
            retained_expiry = adapter._JOURNALS["retained-operation-01"]["expires_at"]
            adapter._mark_known_journal_state("retained-operation-01", "undone")
            self.assertEqual(
                adapter._JOURNALS["retained-operation-01"]["expires_at"],
                retained_expiry,
            )

            prepared = _prepared(self.td)
            event_count = len(self.td.events)
            outcome = adapter.execute_td_transaction(
                self.td,
                prepared,
                "capacity-operation-02",
                "MCP operation capacity",
            )

            self.assertEqual(outcome.status, "failed_rolled_back")
            self.assertEqual(outcome.error_code, "operation_capacity")
            self.assertEqual(len(self.td.events), event_count)
            self.assertEqual(list(adapter._JOURNALS), ["retained-operation-01"])
        finally:
            adapter.MAX_JOURNALS = original_capacity


if __name__ == "__main__":
    unittest.main()
