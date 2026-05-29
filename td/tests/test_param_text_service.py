"""Unit tests for the param-mode + DAT-text bridge endpoints.

Exercises param_modes_endpoint.read_param_modes / set_param_mode / get_dat_text
/ put_dat_text off-TD with lightweight fakes for TD Par / DAT objects. The
load-bearing assertion is that set_param_mode resolves the ParMode enum via
`type(par.mode)` and the parameter's mode ACTUALLY flips to EXPRESSION/BIND/
CONSTANT (not just .expr being set) — the fix for the silently-swallowed
`ParMode` NameError in the old exec path.

Stdlib only. Run: `python3 -m unittest discover -s td/tests` (or
`npm run test:bridge`).
"""

import enum
import os
import sys
import types
import unittest
from unittest import mock

# --- Make the bridge package importable without TouchDesigner ------------------
_HERE = os.path.dirname(os.path.abspath(__file__))
_MODULES = os.path.abspath(os.path.join(_HERE, "..", "modules"))
if _MODULES not in sys.path:
    sys.path.insert(0, _MODULES)

# The bridge service modules bind `op` from `td` at import time; a stub
# suffices (each test patches the module's `op` with its own resolver).
_td_stub = types.ModuleType("td")
_td_stub.op = mock.MagicMock(name="op")
sys.modules.setdefault("td", _td_stub)

from mcp.services import param_text_service as pme  # noqa: E402


# --- A faithful ParMode-like enum: type(par.mode) must expose the members ------
class FakeParMode(enum.Enum):
    CONSTANT = 0
    EXPRESSION = 1
    EXPORT = 2
    BIND = 3


class FakePar:
    """A parameter that round-trips val / expr / bindExpr and a real-ish mode.

    `type(self.mode)` is FakeParMode, so set_param_mode's
    `ModeCls = type(par.mode)` resolves the enum class exactly like live TD.
    """

    def __init__(self, name, val=0.0, mode=FakeParMode.CONSTANT):
        self.name = name
        self.val = val
        self.expr = ""
        self.bindExpr = ""
        self.mode = mode
        self.exportOP = None

    def eval(self):
        return self.val


class FakeParCollection:
    def __init__(self, pars):
        for p in pars:
            setattr(self, p.name, p)

    def _all(self):
        return [v for v in vars(self).values() if isinstance(v, FakePar)]


class FakeNode:
    def __init__(self, path, pars, type_name="noiseTOP"):
        self.path = path
        self.name = path.rsplit("/", 1)[-1]
        self.type = type_name
        self.par = FakeParCollection(pars)

    def pars(self):
        return self.par._all()


class FakeDat:
    def __init__(self, path, text="", is_table=False, num_rows=1, num_cols=1):
        self.path = path
        self.name = path.rsplit("/", 1)[-1]
        self.isDAT = True
        self.text = text
        self.isTable = is_table
        self.numRows = num_rows
        self.numCols = num_cols


class FakeNonDat:
    def __init__(self, path):
        self.path = path
        self.name = path.rsplit("/", 1)[-1]
        self.isDAT = False
        self.text = "should-not-be-read"


def _patch_op(node):
    return mock.patch.object(pme, "op", lambda path: node)


# --- read_param_modes ----------------------------------------------------------
class ReadParamModesTests(unittest.TestCase):
    def test_reports_modes_and_values(self):
        pars = [
            FakePar("amp", val=0.5, mode=FakeParMode.CONSTANT),
            FakePar("period", val=2.0, mode=FakeParMode.EXPRESSION),
        ]
        pars[1].expr = "me.time.seconds"
        node = FakeNode("/project1/noise1", pars)
        with _patch_op(node):
            rep = pme.read_param_modes("/project1/noise1")
        self.assertEqual(rep["path"], "/project1/noise1")
        self.assertEqual(rep["type"], "noiseTOP")
        by_name = {p["name"]: p for p in rep["parameters"]}
        self.assertEqual(by_name["amp"]["mode"], "CONSTANT")
        self.assertEqual(by_name["amp"]["value"], 0.5)
        self.assertEqual(by_name["period"]["mode"], "EXPRESSION")
        self.assertEqual(by_name["period"]["expr"], "me.time.seconds")

    def test_keys_filter(self):
        pars = [FakePar("amp"), FakePar("period")]
        node = FakeNode("/project1/noise1", pars)
        with _patch_op(node):
            rep = pme.read_param_modes("/project1/noise1", keys=["amp"])
        self.assertEqual([p["name"] for p in rep["parameters"]], ["amp"])

    def test_non_default_only_drops_constants(self):
        pars = [
            FakePar("amp", mode=FakeParMode.CONSTANT),
            FakePar("period", mode=FakeParMode.EXPRESSION),
        ]
        node = FakeNode("/project1/noise1", pars)
        with _patch_op(node):
            rep = pme.read_param_modes("/project1/noise1", non_default_only=True)
        self.assertEqual([p["name"] for p in rep["parameters"]], ["period"])

    def test_missing_node_raises(self):
        with mock.patch.object(pme, "op", lambda path: None):
            with self.assertRaises(LookupError):
                pme.read_param_modes("/nope")


# --- set_param_mode (the bug-fix assertion) ------------------------------------
class SetParamModeTests(unittest.TestCase):
    def test_expression_flips_mode_via_type_of_par_mode(self):
        par = FakePar("tx", mode=FakeParMode.CONSTANT)
        node = FakeNode("/project1/geo1", [par])
        with _patch_op(node):
            res = pme.set_param_mode(
                "/project1/geo1", "tx", "expression", expr="me.time.seconds"
            )
        # The actual enum member was set, not just .expr — this is the fix for
        # the silently-swallowed ParMode NameError.
        self.assertIs(par.mode, FakeParMode.EXPRESSION)
        self.assertEqual(par.expr, "me.time.seconds")
        self.assertEqual(res["readback_mode"], "EXPRESSION")
        self.assertEqual(res["readback_expr"], "me.time.seconds")
        self.assertEqual(res["mode"], "expression")

    def test_bind_flips_mode_and_sets_bind_expr(self):
        par = FakePar("ty", mode=FakeParMode.CONSTANT)
        node = FakeNode("/project1/geo1", [par])
        with _patch_op(node):
            res = pme.set_param_mode("/project1/geo1", "ty", "bind", expr="parent().par.X")
        self.assertIs(par.mode, FakeParMode.BIND)
        self.assertEqual(par.bindExpr, "parent().par.X")
        self.assertEqual(res["readback_mode"], "BIND")

    def test_constant_sets_val_and_mode(self):
        par = FakePar("tz", mode=FakeParMode.EXPRESSION)
        node = FakeNode("/project1/geo1", [par])
        with _patch_op(node):
            res = pme.set_param_mode("/project1/geo1", "tz", "constant", value=3.5)
        self.assertIs(par.mode, FakeParMode.CONSTANT)
        self.assertEqual(par.val, 3.5)
        self.assertEqual(res["readback_mode"], "CONSTANT")

    def test_unknown_param_raises(self):
        node = FakeNode("/project1/geo1", [FakePar("tx")])
        with _patch_op(node):
            with self.assertRaises(ValueError) as cm:
                pme.set_param_mode("/project1/geo1", "nope", "expression", expr="1")
        self.assertIn("No such parameter", str(cm.exception))

    def test_expression_without_expr_raises(self):
        node = FakeNode("/project1/geo1", [FakePar("tx")])
        with _patch_op(node):
            with self.assertRaises(ValueError):
                pme.set_param_mode("/project1/geo1", "tx", "expression")

    def test_constant_without_value_raises(self):
        node = FakeNode("/project1/geo1", [FakePar("tx")])
        with _patch_op(node):
            with self.assertRaises(ValueError):
                pme.set_param_mode("/project1/geo1", "tx", "constant")

    def test_missing_node_raises(self):
        with mock.patch.object(pme, "op", lambda path: None):
            with self.assertRaises(LookupError):
                pme.set_param_mode("/nope", "tx", "expression", expr="1")


# --- get_dat_text / put_dat_text ----------------------------------------------
class DatTextTests(unittest.TestCase):
    def test_get_text_table_metadata(self):
        dat = FakeDat("/project1/table1", text="a\tb\nc\td", is_table=True, num_rows=2, num_cols=2)
        with _patch_op(dat):
            res = pme.get_dat_text("/project1/table1")
        self.assertEqual(res["text"], "a\tb\nc\td")
        self.assertTrue(res["is_table"])
        self.assertEqual(res["num_rows"], 2)
        self.assertEqual(res["num_cols"], 2)

    def test_get_text_not_a_dat_raises(self):
        with _patch_op(FakeNonDat("/project1/noise1")):
            with self.assertRaises(ValueError) as cm:
                pme.get_dat_text("/project1/noise1")
        self.assertIn("is not a DAT", str(cm.exception))

    def test_get_text_missing_raises(self):
        with mock.patch.object(pme, "op", lambda path: None):
            with self.assertRaises(LookupError):
                pme.get_dat_text("/nope")

    def test_put_text_writes_and_reports_lengths(self):
        dat = FakeDat("/project1/text1", text="old")
        with _patch_op(dat):
            res = pme.put_dat_text("/project1/text1", "new content")
        self.assertEqual(dat.text, "new content")
        self.assertEqual(res["old_length"], 3)
        self.assertEqual(res["new_length"], len("new content"))

    def test_put_text_not_a_dat_raises(self):
        with _patch_op(FakeNonDat("/project1/noise1")):
            with self.assertRaises(ValueError):
                pme.put_dat_text("/project1/noise1", "x")


if __name__ == "__main__":
    unittest.main()
