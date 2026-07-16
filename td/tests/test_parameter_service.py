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
    def __init__(self, style="Pulse", fail=False, names=None, labels=None, value=None):
        self.style = _Style(style)
        self.fail = fail
        self.count = 0
        self.menuNames = names or []
        self.menuLabels = labels or []
        self.value = value

    def eval(self):
        return self.value

    def pulse(self):
        if self.fail:
            raise RuntimeError("pulse failed")
        self.count += 1


class _Node:
    def __init__(self, path, **pars):
        self.path = path
        self.par = types.SimpleNamespace(**pars)


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


if __name__ == "__main__":
    unittest.main()
