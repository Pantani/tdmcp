"""Focused offline tests for structured annotation-aware layout snapshots."""

import os
import sys
import types
import unittest
from unittest import mock

_HERE = os.path.dirname(os.path.abspath(__file__))
_MODULES = os.path.abspath(os.path.join(_HERE, "..", "modules"))
if _MODULES not in sys.path:
    sys.path.insert(0, _MODULES)

from mcp.services import annotation_layout_service as service  # noqa: E402


class _Connection:
    def __init__(self, owner):
        self.owner = owner


class _Connector:
    def __init__(self, *owners):
        self.connections = [_Connection(owner) for owner in owners]


class _Node:
    def __init__(
        self,
        path,
        node_id,
        op_type="nullTOP",
        *,
        x=0,
        y=0,
        w=100,
        h=50,
        is_comp=False,
        children=None,
    ):
        self.path = path
        self.id = node_id
        self.OPType = op_type
        self.type = "misleadingFallbackType"
        self.isCOMP = is_comp
        self.children = list(children or [])
        self.docked = []
        self.inputConnectors = []
        self.secret_project_content = "must never enter the compact snapshot"
        self._geometry = {
            "nodeX": x,
            "nodeY": y,
            "nodeWidth": w,
            "nodeHeight": h,
        }
        self.fail_once = set()

    def _get_geometry(self, attribute):
        return self._geometry[attribute]

    def _set_geometry(self, attribute, value):
        failure = (attribute, value)
        if failure in self.fail_once:
            self.fail_once.remove(failure)
            raise RuntimeError("sensitive geometry failure")
        self._geometry[attribute] = value

    @property
    def nodeX(self):
        return self._get_geometry("nodeX")

    @nodeX.setter
    def nodeX(self, value):
        self._set_geometry("nodeX", value)

    @property
    def nodeY(self):
        return self._get_geometry("nodeY")

    @nodeY.setter
    def nodeY(self, value):
        self._set_geometry("nodeY", value)

    @property
    def nodeWidth(self):
        return self._get_geometry("nodeWidth")

    @nodeWidth.setter
    def nodeWidth(self, value):
        self._set_geometry("nodeWidth", value)

    @property
    def nodeHeight(self):
        return self._get_geometry("nodeHeight")

    @nodeHeight.setter
    def nodeHeight(self, value):
        self._set_geometry("nodeHeight", value)


def _geometry(node):
    return dict(node._geometry)


class AnnotationLayoutServiceTests(unittest.TestCase):
    def setUp(self):
        self.td = types.ModuleType("td")
        self.td.nodes = {}
        self.td.op = lambda path: self.td.nodes.get(path)
        self.previous_td = sys.modules.get("td")
        sys.modules["td"] = self.td
        self.addCleanup(self._restore_td)

    def _restore_td(self):
        if self.previous_td is None:
            sys.modules.pop("td", None)
        else:
            sys.modules["td"] = self.previous_td

    def _install(self, *nodes):
        self.td.nodes.update({node.path: node for node in nodes})

    def _network(self):
        source = _Node("/project1/layout/a_source", 11, x=10, y=0, w=80, h=40)
        target = _Node("/project1/layout/z_target", 12, x=240, y=0, w=80, h=40)
        target.inputConnectors = [_Connector(source)]
        docked = _Node(
            "/project1/layout/source_viewer",
            13,
            op_type="opviewerCOMP",
            x=20,
            y=-80,
            w=120,
            h=90,
        )
        source.docked = [docked]
        annotation = _Node(
            "/project1/layout/note",
            14,
            op_type="annotateCOMP",
            x=-100,
            y=50,
            w=500,
            h=200,
        )
        root = _Node(
            "/project1/layout",
            10,
            op_type="baseCOMP",
            is_comp=True,
            children=[target, annotation, docked, source],
        )
        self._install(root, source, target, docked, annotation)
        return root, source, target, docked, annotation

    @staticmethod
    def _plan(context, positions=None, annotation_bounds=None):
        return {
            "root_path": context["root_path"],
            "recursive": context["recursive"],
            "fingerprint": context["fingerprint"],
            "networks": [
                {
                    "path": context["networks"][0]["path"],
                    "positions": positions or {},
                    "annotation_bounds": annotation_bounds or {},
                }
            ],
        }

    def test_context_is_compact_sorted_and_fingerprint_is_deterministic(self):
        root, source, target, docked, annotation = self._network()

        first = service.get_layout_context(root.path)
        root.children.reverse()
        source.docked.reverse()
        second = service.get_layout_context(root.path)

        self.assertEqual(first, second)
        self.assertRegex(first["fingerprint"], r"^[0-9a-f]{64}$")
        self.assertEqual(first["root_path"], root.path)
        self.assertFalse(first["recursive"])
        self.assertEqual(len(first["networks"]), 1)
        network = first["networks"][0]
        self.assertEqual(network["path"], root.path)
        self.assertEqual(
            [item["path"] for item in network["nodes"]],
            [source.path, target.path],
        )
        self.assertEqual(
            network["annotations"],
            [
                {
                    "path": annotation.path,
                    "x": -100,
                    "y": 50,
                    "w": 500,
                    "h": 200,
                    "enclosed_paths": [source.path, target.path],
                }
            ],
        )
        self.assertEqual(
            network["docked"],
            [
                {
                    "path": docked.path,
                    "x": 20,
                    "y": -80,
                    "w": 120,
                    "h": 90,
                    "host_path": source.path,
                }
            ],
        )
        self.assertEqual(network["edges"], [{"from": source.path, "to": target.path}])
        self.assertNotIn("secret_project_content", str(first))

    def test_headless_context_does_not_require_ui_state(self):
        root = _Node(
            "/project1/headless",
            8,
            op_type="baseCOMP",
            is_comp=True,
        )
        self._install(root)

        context = service.get_layout_context(root.path)

        self.assertFalse(hasattr(self.td, "ui"))
        self.assertEqual(
            context["networks"],
            [
                {
                    "path": root.path,
                    "nodes": [],
                    "annotations": [],
                    "docked": [],
                    "edges": [],
                }
            ],
        )

    def test_invalid_and_missing_roots_fail_closed(self):
        root, *_unused = self._network()
        not_a_comp = _Node("/project1/not_a_comp", 99)
        self._install(not_a_comp)

        invalid_calls = [
            ("relative/path", False),
            ("/project1/layout\nsecret", False),
            ("/project1/layout", "yes"),
        ]
        for root_path, recursive in invalid_calls:
            with self.subTest(root_path=root_path, recursive=recursive):
                with self.assertRaises(service.InvalidAnnotationLayoutError):
                    service.get_layout_context(root_path, recursive)

        for path in ("/project1/missing", not_a_comp.path):
            with self.subTest(path=path):
                with self.assertRaises(service.AnnotationLayoutNotFoundError):
                    service.get_layout_context(path)

        self.td.op = lambda _path: None
        with self.assertRaises(service.AnnotationLayoutNotFoundError):
            service.get_layout_context(root.path)

    def test_context_enforces_network_node_annotation_and_touched_caps(self):
        root, source, target, _docked, annotation = self._network()
        child_comp = _Node(
            "/project1/layout/subnet",
            20,
            op_type="baseCOMP",
            is_comp=True,
        )
        root.children.append(child_comp)
        self._install(child_comp)

        cap_cases = [
            ("MAX_NETWORKS", 1, True, "recursive layout exceeds network cap"),
            ("MAX_HOSTS", 1, False, "layout context exceeds node or annotation cap"),
            (
                "MAX_ANNOTATIONS",
                0,
                False,
                "layout context exceeds node or annotation cap",
            ),
            ("MAX_TOUCHED", 3, False, "layout context exceeds touched-operator cap"),
        ]
        for constant, limit, recursive, message in cap_cases:
            with self.subTest(constant=constant):
                with mock.patch.object(service, constant, limit):
                    with self.assertRaisesRegex(
                        service.InvalidAnnotationLayoutError, message
                    ):
                        service.get_layout_context(root.path, recursive)

        self.assertIn(source, root.children)
        self.assertIn(target, root.children)
        self.assertIn(annotation, root.children)

    def test_apply_success_moves_nodes_and_resizes_annotation_with_exact_readback(self):
        root, source, _target, _docked, annotation = self._network()
        context = service.get_layout_context(root.path)
        body = self._plan(
            context,
            positions={source.path: [320, -180]},
            annotation_bounds={
                annotation.path: {
                    "x": -160,
                    "y": 90,
                    "w": 640,
                    "h": 260,
                    "resized": True,
                }
            },
        )

        report = service.apply_layout(body)

        self.assertEqual(
            report,
            {
                "applied": True,
                "rolled_back": False,
                "root_path": root.path,
                "fingerprint": context["fingerprint"],
                "moved": 2,
                "resized_annotations": 1,
                "networks": 1,
                "rollback_errors": [],
            },
        )
        self.assertEqual((source.nodeX, source.nodeY), (320, -180))
        self.assertEqual(
            _geometry(annotation),
            {"nodeX": -160, "nodeY": 90, "nodeWidth": 640, "nodeHeight": 260},
        )

    def test_apply_rejects_a_stale_fingerprint_before_writing(self):
        root, source, *_unused = self._network()
        context = service.get_layout_context(root.path)
        original = _geometry(source)
        source.nodeX = 99
        changed = _geometry(source)
        body = self._plan(context, positions={source.path: [400, -200]})

        with self.assertRaises(service.StaleAnnotationLayoutError):
            service.apply_layout(body)

        self.assertNotEqual(original, changed)
        self.assertEqual(_geometry(source), changed)

    def test_apply_rejects_duplicate_and_unknown_targets(self):
        root, source, _target, _docked, annotation = self._network()
        context = service.get_layout_context(root.path)
        duplicate = self._plan(context, positions={source.path: [10, 20]})
        duplicate["networks"].append(
            {
                "path": root.path,
                "positions": {source.path: [30, 40]},
                "annotation_bounds": {},
            }
        )
        unknown = self._plan(
            context, positions={"/project1/layout/not_in_snapshot": [10, 20]}
        )
        wrong_annotation = self._plan(
            context,
            annotation_bounds={source.path: {"x": 0, "y": 0, "w": 100, "h": 100}},
        )
        outside_network = self._plan(context)
        outside_network["networks"][0]["path"] = "/project1/outside"

        cases = [duplicate, unknown, wrong_annotation, outside_network]
        for index, body in enumerate(cases):
            with self.subTest(case=index):
                with self.assertRaises(service.InvalidAnnotationLayoutError):
                    service.apply_layout(body)

        self.assertEqual(source.nodeX, 10)
        self.assertEqual(annotation.nodeWidth, 500)

    def test_partial_apply_failure_restores_every_touched_operator(self):
        root, source, target, *_unused = self._network()
        context = service.get_layout_context(root.path)
        originals = {source.path: _geometry(source), target.path: _geometry(target)}
        target.fail_once.add(("nodeX", 500))
        body = self._plan(
            context,
            positions={source.path: [300, -100], target.path: [500, -100]},
        )

        with self.assertRaises(service.AnnotationLayoutApplyError) as caught:
            service.apply_layout(body)

        report = caught.exception.report
        self.assertEqual(caught.exception.code, "annotation_layout_apply_failed")
        self.assertFalse(report["applied"])
        self.assertTrue(report["rolled_back"])
        self.assertEqual(report["moved"], 0)
        self.assertEqual(report["resized_annotations"], 0)
        self.assertEqual(report["error"]["code"], "annotation_layout_apply_failed")
        self.assertEqual(report["rollback_errors"], [])
        self.assertEqual(_geometry(source), originals[source.path])
        self.assertEqual(_geometry(target), originals[target.path])

    def test_rollback_failure_is_typed_and_reports_the_unrestored_target(self):
        root, source, target, *_unused = self._network()
        context = service.get_layout_context(root.path)
        original_source = _geometry(source)
        original_target = _geometry(target)
        source.fail_once.add(("nodeX", original_source["nodeX"]))
        target.fail_once.add(("nodeX", 500))
        body = self._plan(
            context,
            positions={source.path: [300, -100], target.path: [500, -100]},
        )

        with self.assertRaises(service.AnnotationLayoutRollbackError) as caught:
            service.apply_layout(body)

        report = caught.exception.report
        self.assertEqual(caught.exception.code, "annotation_layout_rollback_failed")
        self.assertFalse(report["applied"])
        self.assertFalse(report["rolled_back"])
        self.assertEqual(report["error"]["code"], "annotation_layout_apply_failed")
        self.assertEqual(
            report["rollback_errors"],
            [{"path": source.path, "message": "sensitive geometry failure"}],
        )
        self.assertEqual((source.nodeX, source.nodeY), (300, -100))
        self.assertEqual(_geometry(target), original_target)


if __name__ == "__main__":
    unittest.main()
