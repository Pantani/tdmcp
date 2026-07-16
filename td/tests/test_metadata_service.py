"""Offline tests for atomic metadata edits and copy/apply/destroy-last moves."""

import os
import sys
import types
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_MODULES = os.path.abspath(os.path.join(_HERE, "..", "modules"))
if _MODULES not in sys.path:
    sys.path.insert(0, _MODULES)

_td_stub = types.ModuleType("td")
_td_stub.op = lambda _path: None
sys.modules.setdefault("td", _td_stub)
_TD = sys.modules["td"]

from mcp.services import metadata_service as ms  # noqa: E402


class _Graph:
    def __init__(self):
        self.nodes = {}
        self.events = []

    def add(self, node):
        self.nodes[node.path] = node

    def remove(self, node):
        self.nodes.pop(node.path, None)

    def rename(self, old_path, node):
        self.nodes.pop(old_path, None)
        self.nodes[node.path] = node


class _Node:
    _DEFAULTS = {
        "nodeX": 0,
        "nodeY": 0,
        "color": (0.55, 0.55, 0.55),
        "comment": "",
        "display": False,
        "render": False,
        "viewer": False,
        "bypass": False,
        "lock": False,
        "cloneImmune": False,
        "allowCooking": True,
    }

    def __init__(self, graph, name, parent=None, values=None):
        self.graph = graph
        self._name = name
        self._parent = parent
        self.children = []
        self._values = dict(self._DEFAULTS)
        self._values.update(values or {})
        self.fail_once = set()
        self.copy_fail_once = set()
        self.destroy_fails = False
        if parent is not None:
            parent.children.append(self)
        graph.add(self)

    @property
    def path(self):
        if self._parent is None:
            return "/" + self._name if self._name else "/"
        return self._parent.path.rstrip("/") + "/" + self._name

    @property
    def name(self):
        return self._name

    @name.setter
    def name(self, value):
        old_path = self.path
        self._before_set("name", value)
        self._name = value
        self.graph.rename(old_path, self)

    def _before_set(self, field, value):
        self.graph.events.append(("set", self.path, field, value))
        if field in self.fail_once:
            self.fail_once.remove(field)
            raise RuntimeError("%s setter failed" % field)

    def _get(self, field):
        return self._values[field]

    def _set(self, field, value):
        self._before_set(field, value)
        self._values[field] = value

    def parent(self):
        return self._parent

    def copy(self, source, name=None):
        copied_values = {field: getattr(source, field) for field in self._DEFAULTS}
        node = _Node(self.graph, name or source.name, parent=self, values=copied_values)
        node.fail_once.update(self.copy_fail_once)
        self.graph.events.append(("copy", source.path, node.path))
        return node

    def destroy(self):
        self.graph.events.append(("destroy", self.path))
        if self.destroy_fails:
            raise RuntimeError("destroy failed")
        self.graph.remove(self)
        if self._parent is not None and self in self._parent.children:
            self._parent.children.remove(self)


def _metadata_property(field):
    return property(lambda self: self._get(field), lambda self, value: self._set(field, value))


for _field in _Node._DEFAULTS:
    setattr(_Node, _field, _metadata_property(_field))


class _TdPatch:
    def __init__(self, graph):
        self.graph = graph

    def __enter__(self):
        self.previous = getattr(_TD, "op", None)
        _TD.op = lambda path: self.graph.nodes.get(path)

    def __exit__(self, *args):
        _TD.op = self.previous


def _basic_graph():
    graph = _Graph()
    project = _Node(graph, "project1")
    source = _Node(graph, "source", parent=project)
    destination = _Node(graph, "destination", parent=project)
    return graph, project, source, destination


class MetadataServiceTest(unittest.TestCase):
    def test_same_parent_edit_reads_back_every_supported_field(self):
        graph, _project, source, _destination = _basic_graph()
        changes = {
            "name": "renamed",
            "node_x": 320,
            "node_y": -180,
            "color": [0.1, 0.2, 0.3],
            "comment": "artist-visible note",
            "display": True,
            "render": True,
            "viewer": True,
            "bypass": True,
            "lock": True,
            "cloneImmune": True,
            "allowCooking": False,
        }
        with _TdPatch(graph):
            report = ms.edit_metadata("/project1/source", changes)
        self.assertTrue(report["applied"])
        self.assertFalse(report["rolled_back"])
        self.assertEqual(report["final_path"], "/project1/renamed")
        self.assertEqual(source.nodeX, 320)
        self.assertEqual(source.nodeY, -180)
        self.assertEqual(source.color, (0.1, 0.2, 0.3))
        self.assertTrue(all(item["status"] == "applied" for item in report["fields"].values()))

    def test_same_parent_failure_rolls_back_all_prior_fields(self):
        graph, _project, source, _destination = _basic_graph()
        source.nodeX = 10
        source.nodeY = 20
        graph.events.clear()
        source.fail_once.add("nodeY")
        with _TdPatch(graph):
            report = ms.edit_metadata(
                source.path,
                {"node_x": 999, "node_y": 888, "comment": "must not apply"},
            )
        self.assertFalse(report["applied"])
        self.assertTrue(report["rolled_back"])
        self.assertEqual(source.nodeX, 10)
        self.assertEqual(source.nodeY, 20)
        self.assertEqual(source.comment, "")
        self.assertEqual(report["fields"]["node_x"]["status"], "rolled_back")
        self.assertEqual(report["fields"]["comment"]["status"], "not_applied")

    def test_move_copies_applies_readback_then_destroys_source_last(self):
        graph, _project, source, destination = _basic_graph()
        original_path = source.path
        with _TdPatch(graph):
            report = ms.edit_metadata(
                original_path,
                {"parent_path": destination.path, "name": "moved", "node_x": 500},
            )
        self.assertTrue(report["applied"])
        self.assertEqual(report["final_path"], "/project1/destination/moved")
        self.assertNotIn(original_path, graph.nodes)
        moved = graph.nodes[report["final_path"]]
        self.assertEqual(moved.nodeX, 500)
        copy_index = next(i for i, event in enumerate(graph.events) if event[0] == "copy")
        set_index = next(
            i
            for i, event in enumerate(graph.events)
            if event[0] == "set" and event[1] == moved.path and event[2] == "nodeX"
        )
        destroy_index = next(
            i for i, event in enumerate(graph.events) if event == ("destroy", original_path)
        )
        self.assertLess(copy_index, set_index)
        self.assertLess(set_index, destroy_index)

    def test_move_apply_failure_destroys_copy_and_preserves_source(self):
        graph, _project, source, destination = _basic_graph()
        destination.copy_fail_once.add("comment")
        original_path = source.path
        with _TdPatch(graph):
            report = ms.edit_metadata(
                original_path,
                {"parent_path": destination.path, "comment": "will fail"},
            )
        self.assertFalse(report["applied"])
        self.assertTrue(report["rolled_back"])
        self.assertIs(graph.nodes[original_path], source)
        self.assertNotIn("/project1/destination/source", graph.nodes)

    def test_move_source_destroy_failure_removes_copy_and_preserves_source(self):
        graph, _project, source, destination = _basic_graph()
        source.destroy_fails = True
        original_path = source.path
        with _TdPatch(graph):
            report = ms.edit_metadata(original_path, {"parent_path": destination.path})
        self.assertFalse(report["applied"])
        self.assertTrue(report["rolled_back"])
        self.assertIs(graph.nodes[original_path], source)
        self.assertNotIn("/project1/destination/source", graph.nodes)

    def test_prevalidation_rejects_unknown_fields_collision_and_bad_values(self):
        graph, project, source, _destination = _basic_graph()
        _Node(graph, "taken", parent=project)
        cases = [
            {"unknown": True},
            {"name": "bad name"},
            {"node_x": 1.5},
            {"color": [0, 2, 0]},
            {"display": 1},
            {"comment": "x" * 2049},
            {"name": "taken"},
        ]
        with _TdPatch(graph):
            for changes in cases:
                with self.subTest(changes=changes), self.assertRaises(ValueError):
                    ms.edit_metadata(source.path, changes)

    def test_move_rejects_missing_parent_and_descendant_destination(self):
        graph, _project, source, _destination = _basic_graph()
        child = _Node(graph, "child", parent=source)
        with _TdPatch(graph):
            with self.assertRaises(LookupError):
                ms.edit_metadata(source.path, {"parent_path": "/missing"})
            with self.assertRaises(ValueError):
                ms.edit_metadata(source.path, {"parent_path": child.path})


if __name__ == "__main__":
    unittest.main()
