"""Unit tests for the custom_params_service bridge module.

Stubs ``sys.modules['td']`` with a fake ``op`` that returns ``_FakeNode``s
carrying ``_FakePar`` lists, then drives ``custom_params_service.get_custom_params``
off-TD and asserts the readout shape AND per-par fault isolation.

Run from the repo root: ``python3 -m unittest discover -s td/tests``.
"""

import os
import sys
import types
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_MODULES = os.path.abspath(os.path.join(_HERE, "..", "modules"))
if _MODULES not in sys.path:
    sys.path.insert(0, _MODULES)

_td_stub = types.ModuleType("td")
sys.modules.setdefault("td", _td_stub)
_TD = sys.modules["td"]

from mcp.services import custom_params_service as svc  # noqa: E402


class _FakePage:
    def __init__(self, name="Custom"):
        self.name = name


class _FakePar:
    def __init__(
        self,
        name,
        label=None,
        page="Custom",
        style="Float",
        default=0.0,
        value=0.0,
        normMin=0.0,
        normMax=1.0,
        menuNames=None,
        menuLabels=None,
        eval_raises=False,
        default_raises=False,
    ):
        self.name = name
        self.label = label or name
        self.page = _FakePage(page)
        self.style = style
        self._default = default
        self._value = value
        self.normMin = normMin
        self.normMax = normMax
        self.menuNames = menuNames
        self.menuLabels = menuLabels
        self._eval_raises = eval_raises
        self._default_raises = default_raises

    @property
    def default(self):
        if self._default_raises:
            raise RuntimeError("default boom")
        return self._default

    def eval(self):
        if self._eval_raises:
            raise RuntimeError("eval boom")
        return self._value


class _FakeNode:
    def __init__(self, customPars=None, path="/project1/comp"):
        if customPars is not None:
            self.customPars = customPars
        self.path = path


class _TdPatch:
    def __init__(self, path_map):
        self._path_map = path_map

    def __enter__(self):
        self._prev = getattr(_TD, "op", None)
        _TD.op = lambda p: self._path_map.get(p)
        return self

    def __exit__(self, *a):
        if self._prev is None:
            try:
                del _TD.op
            except AttributeError:
                pass
        else:
            _TD.op = self._prev


class TestCustomParamsService(unittest.TestCase):
    def test_happy_path_multi_style(self):
        node = _FakeNode(
            customPars=[
                _FakePar("Resolution", style="Int", default=1080, value=1080, normMax=4096.0),
                _FakePar("Speed", style="Float", default=1.0, value=2.5),
                _FakePar(
                    "Mode",
                    style="Menu",
                    default="a",
                    value="b",
                    menuNames=["a", "b", "c"],
                ),
            ]
        )
        with _TdPatch({"/project1/comp": node}):
            out = svc.get_custom_params("/project1/comp")
        self.assertEqual(len(out["params"]), 3)
        self.assertEqual(out["params"][0]["name"], "Resolution")
        self.assertEqual(out["params"][0]["style"], "Int")
        self.assertEqual(out["params"][0]["page"], "Custom")
        self.assertEqual(out["params"][0]["default"], 1080)
        self.assertEqual(out["params"][0]["value"], 1080)
        self.assertEqual(out["params"][0]["max"], 4096.0)
        self.assertEqual(out["params"][2]["options"], ["a", "b", "c"])
        self.assertEqual(out["warnings"], [])
        self.assertNotIn("fatal", out)

    def test_node_not_found(self):
        with _TdPatch({}):
            out = svc.get_custom_params("/nope")
        self.assertIn("fatal", out)
        self.assertIn("not found", out["fatal"].lower())

    def test_missing_customPars(self):
        node = _FakeNode(customPars=None)
        # Force attribute absence: don't set it.
        if hasattr(node, "customPars"):
            del node.customPars
        with _TdPatch({"/project1/x": node}):
            out = svc.get_custom_params("/project1/x")
        self.assertEqual(out["params"], [])
        self.assertTrue(any("customPars" in w for w in out["warnings"]))

    def test_empty_customPars(self):
        node = _FakeNode(customPars=[])
        with _TdPatch({"/project1/x": node}):
            out = svc.get_custom_params("/project1/x")
        self.assertEqual(out["params"], [])
        self.assertEqual(out["warnings"], [])

    def test_par_eval_raises_continues(self):
        node = _FakeNode(
            customPars=[
                _FakePar("Good", value=42),
                _FakePar("Bad", eval_raises=True),
            ]
        )
        with _TdPatch({"/c": node}):
            out = svc.get_custom_params("/c")
        self.assertEqual(len(out["params"]), 2)
        self.assertEqual(out["params"][0]["value"], 42)
        self.assertIsNone(out["params"][1]["value"])
        self.assertTrue(any("Could not eval Bad" in w for w in out["warnings"]))

    def test_par_default_raises_continues(self):
        node = _FakeNode(customPars=[_FakePar("X", default_raises=True)])
        with _TdPatch({"/c": node}):
            out = svc.get_custom_params("/c")
        self.assertEqual(len(out["params"]), 1)
        self.assertIsNone(out["params"][0]["default"])
        self.assertTrue(any("default of X" in w for w in out["warnings"]))

    def test_menu_prefers_labels_over_names(self):
        node = _FakeNode(
            customPars=[
                _FakePar(
                    "Mode",
                    style="Menu",
                    menuNames=["a", "b", "c"],
                    menuLabels=["Alpha", "Beta", "Gamma"],
                )
            ]
        )
        with _TdPatch({"/c": node}):
            out = svc.get_custom_params("/c")
        self.assertEqual(out["params"][0]["options"], ["Alpha", "Beta", "Gamma"])

    def test_menu_falls_back_to_names_when_labels_absent(self):
        node = _FakeNode(
            customPars=[_FakePar("Mode", style="Menu", menuNames=["a", "b"], menuLabels=None)]
        )
        with _TdPatch({"/c": node}):
            out = svc.get_custom_params("/c")
        self.assertEqual(out["params"][0]["options"], ["a", "b"])

    def test_menu_without_menuNames(self):
        node = _FakeNode(customPars=[_FakePar("Mode", style="Menu", menuNames=None)])
        with _TdPatch({"/c": node}):
            out = svc.get_custom_params("/c")
        self.assertIsNone(out["params"][0]["options"])

    def test_encoded_path_with_slashes(self):
        # Controller does the unquoting; here we just confirm the service
        # honors arbitrarily deep paths.
        node = _FakeNode(customPars=[_FakePar("A")])
        path = "/project1/sub/deep/comp"
        with _TdPatch({path: node}):
            out = svc.get_custom_params(path)
        self.assertEqual(len(out["params"]), 1)

    def test_par_without_name_skipped(self):
        bad = _FakePar("ignored")
        # Make name accessor raise.
        del bad.name
        bad.__class__ = type(
            "_NamelessPar",
            (object,),
            {"name": property(lambda self: (_ for _ in ()).throw(RuntimeError("no name")))},
        )
        node = _FakeNode(customPars=[bad, _FakePar("Real")])
        with _TdPatch({"/c": node}):
            out = svc.get_custom_params("/c")
        # The nameless one is skipped, the real one survives.
        self.assertEqual(len(out["params"]), 1)
        self.assertEqual(out["params"][0]["name"], "Real")
        self.assertTrue(any("no readable name" in w for w in out["warnings"]))

    def test_customPars_not_iterable(self):
        node = _FakeNode(customPars=42)  # not iterable
        with _TdPatch({"/c": node}):
            out = svc.get_custom_params("/c")
        self.assertEqual(out["params"], [])
        self.assertTrue(any("not iterable" in w for w in out["warnings"]))

    def test_op_raises(self):
        class _BoomTd:
            @staticmethod
            def op(_p):
                raise RuntimeError("td boom")

        prev = _TD.op if hasattr(_TD, "op") else None
        _TD.op = _BoomTd.op
        try:
            out = svc.get_custom_params("/x")
        finally:
            if prev is None:
                del _TD.op
            else:
                _TD.op = prev
        self.assertIn("fatal", out)
        self.assertIn("td boom", out["fatal"])


if __name__ == "__main__":
    unittest.main()
