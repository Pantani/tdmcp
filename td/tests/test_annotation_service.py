"""Offline tests for structured transactional annotation editing."""

import math
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
# unittest discovery imports this module before test_api_controller. Keep the
# shared stub complete enough for bridge modules that bind TD globals at import
# time; individual annotation tests still replace only ``op`` as needed.
_td_stub.app = mock.MagicMock(name="app")
_td_stub.project = mock.MagicMock(name="project")
sys.modules.setdefault("td", _td_stub)
_TD = sys.modules["td"]

from mcp.services import annotation_service as service  # noqa: E402


class _Par:
    def __init__(self, name, value, events, mode="ParMode.CONSTANT"):
        self.name = name
        self._value = value
        self.events = events
        self.mode = mode
        self.fail_on_values = set()
        self.eval_fails = False
        self.eval_count = 0
        self.change_on_eval = None

    def eval(self):
        self.eval_count += 1
        self.events.append(("read_par", self.name))
        if self.eval_fails:
            raise RuntimeError("sensitive read failure")
        if (
            self.change_on_eval is not None
            and self.eval_count == self.change_on_eval[0]
        ):
            self._value = self.change_on_eval[1]
        return self._value

    @property
    def val(self):
        return self._value

    @val.setter
    def val(self, value):
        self.events.append(("set_par", self.name, value))
        if value in self.fail_on_values:
            self.fail_on_values.remove(value)
            raise RuntimeError("sensitive write failure")
        self._value = value


class _Node:
    def __init__(self, path, op_type="annotateCOMP", include_all_pars=True):
        self.path = path
        self.OPType = op_type
        self.type = "misleadingFallbackType"
        self.events = []
        self._geometry = {"nodeX": 10, "nodeY": 20, "nodeWidth": 300, "nodeHeight": 160}
        self.fail_on_geometry_values = set()
        self.geometry_minimum = {}
        pars = {}
        if include_all_pars:
            values = {
                "Titletext": "old title",
                "Bodytext": "old body",
                "Backcolorr": 0.1,
                "Backcolorg": 0.2,
                "Backcolorb": 0.3,
                "Backcoloralpha": 0.4,
            }
            pars = {
                name: _Par(name, value, self.events) for name, value in values.items()
            }
        self.par = types.SimpleNamespace(**pars)
        self._text = "old fallback text"

    def _get_geometry(self, attribute):
        self.events.append(("read_attr", attribute))
        return self._geometry[attribute]

    def _set_geometry(self, attribute, value):
        self.events.append(("set_attr", attribute, value))
        if (attribute, value) in self.fail_on_geometry_values:
            self.fail_on_geometry_values.remove((attribute, value))
            raise RuntimeError("sensitive geometry failure")
        minimum = self.geometry_minimum.get(attribute)
        self._geometry[attribute] = (
            max(value, minimum) if minimum is not None else value
        )

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

    @property
    def text(self):
        self.events.append(("read_attr", "text"))
        return self._text

    @text.setter
    def text(self, value):
        self.events.append(("set_attr", "text", value))
        self._text = value


class _OpPatch:
    def __init__(self, nodes):
        self.nodes = nodes

    def __enter__(self):
        self.previous = getattr(_TD, "op", None)
        _TD.op = lambda path: self.nodes.get(path)

    def __exit__(self, *args):
        _TD.op = self.previous


def _par(node, name):
    return getattr(node.par, name)


def _values(node):
    return {
        "title": _par(node, "Titletext")._value,
        "body": _par(node, "Bodytext")._value,
        "color": tuple(
            _par(node, name)._value
            for name in ("Backcolorr", "Backcolorg", "Backcolorb", "Backcoloralpha")
        ),
        "x": node._geometry["nodeX"],
        "y": node._geometry["nodeY"],
        "w": node._geometry["nodeWidth"],
        "h": node._geometry["nodeHeight"],
    }


class AnnotationServiceTests(unittest.TestCase):
    def test_current_build_aliases_and_geometry_apply_in_deterministic_order(self):
        node = _Node("/project1/note")
        changes = {
            "h": 240,
            "color": [0.9, 0.8, 0.7, 0.6],
            "title": "new title",
            "w": 640,
            "body": "new body",
            "y": -200,
            "x": -400,
        }
        with _OpPatch({node.path: node}):
            report = service.edit_annotation(node.path, changes)

        self.assertTrue(report["applied"])
        self.assertFalse(report["rolled_back"])
        self.assertEqual(report["node_type"], "annotateCOMP")
        self.assertEqual(report["final_path"], node.path)
        expected = dict(changes)
        expected["color"] = tuple(changes["color"])
        self.assertEqual(_values(node), expected)
        self.assertEqual(report["fields"]["title"]["binding"], "Titletext")
        self.assertEqual(report["fields"]["body"]["binding"], "Bodytext")
        self.assertEqual(
            report["fields"]["color"]["binding"], list(service._COLOR_ALIASES)
        )
        self.assertEqual(
            report["fields"]["title"]["requested"],
            {"redacted": True, "length": len("new title")},
        )
        self.assertEqual(
            report["fields"]["body"]["actual"],
            {"redacted": True, "length": len("new body")},
        )
        self.assertNotIn("new title", str(report))
        self.assertNotIn("new body", str(report))

        writes = [event for event in node.events if event[0].startswith("set_")]
        self.assertEqual(
            [(event[0], event[1]) for event in writes],
            [
                ("set_par", "Titletext"),
                ("set_par", "Bodytext"),
                ("set_par", "Backcolorr"),
                ("set_par", "Backcolorg"),
                ("set_par", "Backcolorb"),
                ("set_par", "Backcoloralpha"),
                ("set_attr", "nodeX"),
                ("set_attr", "nodeY"),
                ("set_attr", "nodeWidth"),
                ("set_attr", "nodeHeight"),
            ],
        )

    def test_resolves_and_snapshots_all_fields_before_first_write(self):
        node = _Node("/project1/note")
        delattr(node.par, "Bodytext")
        original = _values_without_body(node)
        with _OpPatch({node.path: node}):
            report = service.edit_annotation(
                node.path,
                {"title": "must not apply", "body": "unsupported"},
            )
        self.assertFalse(report["applied"])
        self.assertEqual(report["error"]["code"], "unsupported_annotation_field")
        self.assertEqual(report["fields"]["body"]["status"], "unsupported")
        self.assertEqual(_values_without_body(node), original)
        self.assertFalse(any(event[0].startswith("set_") for event in node.events))

    def test_exact_noop_avoids_all_writes(self):
        node = _Node("/project1/note")
        current = _values(node)
        with _OpPatch({node.path: node}):
            report = service.edit_annotation(node.path, current)
        self.assertTrue(report["applied"])
        self.assertTrue(
            all(field["status"] == "unchanged" for field in report["fields"].values())
        )
        self.assertFalse(any(event[0].startswith("set_") for event in node.events))

    def test_unowned_text_dat_is_rejected_without_any_write(self):
        node = _Node("/project1/fallback", op_type="textDAT", include_all_pars=False)
        with _OpPatch({node.path: node}):
            report = service.edit_annotation(
                node.path, {"title": "new text", "x": -50, "h": 90}
            )
        self.assertFalse(report["applied"])
        self.assertEqual(report["error"]["code"], "unsupported_annotation_type")
        self.assertEqual(node.text, "old fallback text")
        self.assertEqual(node.nodeX, 10)
        self.assertEqual(node.nodeHeight, 160)
        self.assertFalse(any(event[0].startswith("set_") for event in node.events))

    def test_missing_and_wrong_type_are_distinct_typed_failures(self):
        wrong = _Node("/project1/noise", op_type="noiseTOP", include_all_pars=False)
        with _OpPatch({wrong.path: wrong}):
            missing = service.edit_annotation("/project1/missing", {"x": 1})
            unsupported = service.edit_annotation(wrong.path, {"x": 1})
        self.assertEqual(missing["error"]["code"], "annotation_not_found")
        self.assertEqual(unsupported["error"]["code"], "unsupported_annotation_type")
        self.assertFalse(missing["applied"])
        self.assertFalse(unsupported["applied"])

    def test_rejects_unbounded_invalid_or_unknown_inputs(self):
        cases = [
            ("relative", {"x": 1}),
            ("/project1/note", {}),
            ("/project1/note", {"unknown": True}),
            ("/project1/note", {"title": "x" * (service.MAX_TITLE + 1)}),
            ("/project1/note", {"body": "\x00"}),
            ("/project1/note", {"color": [0, 0, 0]}),
            ("/project1/note", {"color": [0, 0, 0, math.inf]}),
            ("/project1/note", {"color": [0, 0, 0, True]}),
            ("/project1/note", {"x": 1.5}),
            ("/project1/note", {"x": True}),
            ("/project1/note", {"w": 0}),
            ("/project1/note", {"w": 9}),
            ("/project1/note", {"h": 9}),
            ("/project1/note", {"h": service.MAX_SIZE + 1}),
        ]
        with _OpPatch({}):
            for path, changes in cases:
                with self.subTest(path=path, changes=changes):
                    report = service.edit_annotation(path, changes)
                    self.assertFalse(report["applied"])
                    self.assertEqual(report["error"]["code"], "invalid_annotation_edit")

    def test_non_constant_parameter_is_rejected_without_mutation(self):
        node = _Node("/project1/note")
        _par(node, "Titletext").mode = "ParMode.EXPRESSION"
        with _OpPatch({node.path: node}):
            report = service.edit_annotation(
                node.path, {"title": "secret requested text"}
            )
        self.assertFalse(report["applied"])
        self.assertEqual(report["error"]["code"], "annotation_field_not_constant")
        self.assertEqual(_par(node, "Titletext")._value, "old title")
        self.assertNotIn("secret requested text", report["error"]["message"])
        self.assertNotIn("secret requested text", str(report))

    def test_mid_apply_failure_rolls_back_all_touched_fields(self):
        node = _Node("/project1/note")
        _par(node, "Bodytext").fail_on_values.add("new body")
        with _OpPatch({node.path: node}):
            report = service.edit_annotation(
                node.path,
                {"title": "new title", "body": "new body", "x": 999},
            )
        self.assertFalse(report["applied"])
        self.assertTrue(report["rolled_back"])
        self.assertEqual(report["error"]["code"], "annotation_write_failed")
        self.assertEqual(_par(node, "Titletext")._value, "old title")
        self.assertEqual(_par(node, "Bodytext")._value, "old body")
        self.assertEqual(node.nodeX, 10)
        self.assertEqual(report["fields"]["title"]["rollback"], "restored")
        self.assertEqual(report["fields"]["body"]["rollback"], "restored")

    def test_partial_rgba_failure_restores_every_channel(self):
        node = _Node("/project1/note")
        _par(node, "Backcolorb").fail_on_values.add(0.7)
        original = _values(node)["color"]
        with _OpPatch({node.path: node}):
            report = service.edit_annotation(node.path, {"color": [0.9, 0.8, 0.7, 0.6]})
        self.assertFalse(report["applied"])
        self.assertTrue(report["rolled_back"])
        self.assertEqual(_values(node)["color"], original)
        self.assertEqual(report["fields"]["color"]["rollback"], "restored")

    def test_readback_mismatch_rolls_back_geometry(self):
        node = _Node("/project1/note")
        node.geometry_minimum["nodeWidth"] = 100
        with _OpPatch({node.path: node}):
            report = service.edit_annotation(node.path, {"x": 400, "w": 50})
        self.assertFalse(report["applied"])
        self.assertTrue(report["rolled_back"])
        self.assertEqual(report["error"]["code"], "annotation_readback_mismatch")
        self.assertEqual(node.nodeX, 10)
        self.assertEqual(node.nodeWidth, 300)

    def test_rollback_failure_is_never_reported_as_success(self):
        node = _Node("/project1/note")
        _par(node, "Titletext").fail_on_values.add("old title")
        _par(node, "Bodytext").fail_on_values.add("new body")
        with _OpPatch({node.path: node}):
            report = service.edit_annotation(
                node.path,
                {"title": "new title", "body": "new body"},
            )
        self.assertFalse(report["applied"])
        self.assertFalse(report["rolled_back"])
        self.assertEqual(report["error"]["code"], "annotation_rollback_failed")
        self.assertEqual(report["fields"]["title"]["rollback"], "failed")
        self.assertEqual(_par(node, "Titletext")._value, "new title")

    def test_concurrent_change_is_refused_without_overwrite(self):
        node = _Node("/project1/note")
        title = _par(node, "Titletext")
        title.change_on_eval = (2, "artist edit")
        with _OpPatch({node.path: node}):
            report = service.edit_annotation(node.path, {"title": "agent edit"})
        self.assertFalse(report["applied"])
        self.assertFalse(report["rolled_back"])
        self.assertEqual(report["error"]["code"], "annotation_write_failed")
        self.assertEqual(title._value, "artist edit")
        self.assertFalse(any(event[0] == "set_par" for event in node.events))

    def test_read_failure_is_typed_and_does_not_leak_exception_text(self):
        node = _Node("/project1/note")
        _par(node, "Titletext").eval_fails = True
        with _OpPatch({node.path: node}):
            report = service.edit_annotation(
                node.path, {"title": "new title", "x": 200}
            )
        self.assertFalse(report["applied"])
        self.assertEqual(report["error"]["code"], "annotation_read_failed")
        self.assertNotIn("sensitive read failure", report["error"]["message"])
        self.assertEqual(node.nodeX, 10)
        self.assertFalse(any(event[0].startswith("set_") for event in node.events))


def _values_without_body(node):
    return {
        "title": _par(node, "Titletext")._value,
        "color": tuple(
            _par(node, name)._value
            for name in ("Backcolorr", "Backcolorg", "Backcolorb", "Backcoloralpha")
        ),
        "geometry": dict(node._geometry),
    }


if __name__ == "__main__":
    unittest.main()
