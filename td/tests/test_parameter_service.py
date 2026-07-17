"""Offline tests for strict Pulse parameter execution."""

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

from mcp.services import parameter_service as ps  # noqa: E402


class _Style:
    def __init__(self, name):
        self.name = name


class _Par:
    def __init__(
        self,
        style="Pulse",
        fail=False,
        names=None,
        labels=None,
        value=None,
        name="par",
        sequence=None,
        fail_value=None,
    ):
        self.name = name
        self.style = _Style(style)
        self.fail = fail
        self.count = 0
        self.menuNames = names or []
        self.menuLabels = labels or []
        self._value = value
        self.sequence = sequence
        self.mode = types.SimpleNamespace(name="CONSTANT")
        self.expr = ""
        self.bindExpr = ""
        self.readOnly = False
        self.enable = True
        self.fail_value = fail_value
        self.eval_override = None

    @property
    def val(self):
        return self._value

    @val.setter
    def val(self, value):
        if value == self.fail_value:
            raise RuntimeError("set failed")
        self._value = value

    def eval(self):
        return self.eval_override if self.eval_override is not None else self._value

    def pulse(self):
        if self.fail:
            raise RuntimeError("pulse failed")
        self.count += 1


class _Node:
    def __init__(self, path, **pars):
        self.path = path
        self.par = types.SimpleNamespace(**pars)

    def pars(self):
        return list(vars(self.par).values())


class _Sequence:
    def __init__(self, name, owner, blocks=1):
        self.name = name
        self.owner = owner
        self.numBlocks = blocks


class _OpPatch:
    def __init__(self, graph):
        self.graph = graph

    def __enter__(self):
        self.previous = getattr(_TD, "op", None)
        _TD.op = lambda path: self.graph.get(path)

    def __exit__(self, *args):
        _TD.op = self.previous


class ParameterServiceTest(unittest.TestCase):
    def test_pulses_only_after_pulse_style_validation(self):
        par = _Par("Pulse")
        node = _Node("/project1/timer1", start=par)
        with _OpPatch({node.path: node}):
            report = ps.pulse_parameter(node.path, "start")
        self.assertEqual(par.count, 1)
        self.assertEqual(
            report,
            {"path": node.path, "parameter": "start", "style": "Pulse", "pulsed": True},
        )

    def test_normalizes_enum_style_name(self):
        par = _Par()
        par.style = "ParStyle.PULSE"
        node = _Node("/project1/base1", resetpulse=par)
        with _OpPatch({node.path: node}):
            report = ps.pulse_parameter(node.path, "resetpulse")
        self.assertEqual(report["style"], "PULSE")

    def test_missing_node_and_parameter_are_distinct(self):
        with _OpPatch({}):
            with self.assertRaises(LookupError):
                ps.pulse_parameter("/missing", "start")
        node = _Node("/project1/base1")
        with _OpPatch({node.path: node}):
            with self.assertRaises(KeyError):
                ps.pulse_parameter(node.path, "start")

    def test_non_pulse_parameter_is_rejected_without_call(self):
        par = _Par("Float")
        node = _Node("/project1/lfo1", speed=par)
        with _OpPatch({node.path: node}):
            with self.assertRaisesRegex(TypeError, "expected Pulse"):
                ps.pulse_parameter(node.path, "speed")
        self.assertEqual(par.count, 0)

    def test_pulse_runtime_failure_is_typed(self):
        node = _Node("/project1/timer1", start=_Par(fail=True))
        with _OpPatch({node.path: node}):
            with self.assertRaisesRegex(ValueError, "failed"):
                ps.pulse_parameter(node.path, "start")

    def test_reads_bounded_live_menu_metadata(self):
        par = _Par("Menu", names=["add", "multiply"], labels=["Add", "Multiply"], value="add")
        node = _Node("/project1/math1", combine=par)
        with _OpPatch({node.path: node}):
            report = ps.read_parameter_menu(node.path, "combine")
        self.assertEqual(
            report,
            {
                "path": node.path,
                "parameter": "combine",
                "style": "Menu",
                "names": ["add", "multiply"],
                "labels": ["Add", "Multiply"],
                "current": "add",
            },
        )

    def test_rejects_unbounded_or_malformed_inputs(self):
        for path, parameter in (("relative", "start"), ("/ok", "bad name"), ("/ok", "1bad")):
            with self.subTest(path=path, parameter=parameter), self.assertRaises(ValueError):
                ps.pulse_parameter(path, parameter)

    def _sequence_node(self):
        node = _Node("/project1/constant1")
        sequence = _Sequence("const", node, 1)
        node.par = types.SimpleNamespace(
            const0value=_Par("Float", value=1.0, name="const0value", sequence=sequence),
            const1value=_Par("Float", value=2.0, name="const1value", sequence=sequence),
        )
        return node, sequence

    def test_discovers_sequence_blocks_and_values(self):
        node, sequence = self._sequence_node()
        with _OpPatch({node.path: node}):
            report = ps.read_parameter_sequences(node.path)
        self.assertFalse(report["truncated"])
        self.assertEqual(report["sequences"][0]["name"], "const")
        self.assertEqual(report["sequences"][0]["num_blocks"], 1)
        self.assertEqual(
            [item["name"] for item in report["sequences"][0]["parameters"]],
            ["const0value", "const1value"],
        )
        self.assertEqual(sequence.numBlocks, 1)

    def test_resizes_then_applies_indexed_values(self):
        node, sequence = self._sequence_node()
        with _OpPatch({node.path: node}):
            report = ps.update_parameter_sequences(
                node.path,
                {"const": 2},
                {"const1value": 7.5},
            )
        self.assertEqual(sequence.numBlocks, 2)
        self.assertEqual(node.par.const1value.val, 7.5)
        self.assertEqual(report["resized"], [{"name": "const", "was": 1, "num_blocks": 2}])
        self.assertFalse(report["rolled_back"])

    def test_rolls_back_count_and_prior_value_when_later_write_fails(self):
        node, sequence = self._sequence_node()
        node.par.const0value.eval_override = 123.0
        node.par.const1value.fail_value = 99
        with _OpPatch({node.path: node}):
            with self.assertRaisesRegex(ValueError, "rolled back"):
                ps.update_parameter_sequences(
                    node.path,
                    {"const": 2},
                    {"const0value": 8.0, "const1value": 99},
                )
        self.assertEqual(sequence.numBlocks, 1)
        self.assertEqual(node.par.const0value.val, 1.0)
        self.assertEqual(node.par.const1value.val, 2.0)

    def test_rejects_expression_objects_without_mutation(self):
        node, sequence = self._sequence_node()
        with _OpPatch({node.path: node}):
            with self.assertRaisesRegex(ValueError, "constant values only"):
                ps.update_parameter_sequences(
                    node.path,
                    {"const": 2},
                    {"const1value": {"expr": "absTime.seconds"}},
                )
        self.assertEqual(sequence.numBlocks, 1)
        self.assertEqual(node.par.const1value.val, 2.0)

    def test_rejects_unknown_sequence_and_count_bounds(self):
        node, _sequence = self._sequence_node()
        with _OpPatch({node.path: node}):
            with self.assertRaisesRegex(ValueError, "Unknown parameter sequence"):
                ps.update_parameter_sequences(node.path, {"missing": 2}, {})
            with self.assertRaisesRegex(ValueError, "between 1"):
                ps.update_parameter_sequences(node.path, {"const": 0}, {})

    def test_rejects_non_sequence_parameter_in_sequence_transaction(self):
        node, sequence = self._sequence_node()
        node.par.normal = _Par("Float", value=1.0, name="normal")
        with _OpPatch({node.path: node}):
            with self.assertRaisesRegex(ValueError, "not a member"):
                ps.update_parameter_sequences(
                    node.path,
                    {"const": 2},
                    {"normal": 5.0},
                )
        self.assertEqual(sequence.numBlocks, 1)
        self.assertEqual(node.par.normal.val, 1.0)


if __name__ == "__main__":
    unittest.main()
