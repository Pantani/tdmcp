"""Unit tests for project_analysis_service.analyze.

Mirrors ``test_system_service.py``: install a stub ``td`` module + drive
``analyze()`` off-TD against fake ops. Verifies counts, dependency_map,
unused / orphan / broken-file classification, and per-field defensiveness.

Run from repo root: ``python3 -m unittest discover -s td/tests``.
"""

import os
import sys
import types
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_MODULES = os.path.abspath(os.path.join(_HERE, "..", "modules"))
if _MODULES not in sys.path:
    sys.path.insert(0, _MODULES)

# Shared stub — project_analysis_service does ``import td`` INSIDE analyze().
_td_stub = sys.modules.setdefault("td", types.ModuleType("td"))

from mcp.services import project_analysis_service as pa  # noqa: E402


# --- Fakes ---------------------------------------------------------------------


class _ModeEnum:
    """Stand-in for an instance of TD's ParMode enum.

    ``analyze`` derives ``EXPRESSION`` from ``type(par.mode).EXPRESSION``, so the
    value's CLASS must expose an ``EXPRESSION`` attribute (the sentinel value of
    that mode). Equality is checked against that sentinel; a fresh
    ``_ModeEnum("EXPRESSION")`` equals the class attribute.
    """

    EXPRESSION = None  # filled in below
    CONSTANT = None

    def __init__(self, name):
        self.name = name

    def __eq__(self, other):
        return isinstance(other, _ModeEnum) and other.name == self.name

    def __hash__(self):
        return hash(self.name)


_ModeEnum.EXPRESSION = _ModeEnum("EXPRESSION")
_ModeEnum.CONSTANT = _ModeEnum("CONSTANT")


# Back-compat alias for the test-body references below.
_Mode = _ModeEnum


class _Connector:
    def __init__(self, connections=None):
        self.connections = connections or []


class _Par:
    def __init__(self, name, value="", mode=_Mode.CONSTANT, expr="", is_file=None, exports=None):
        self.name = name
        self._value = value
        self.mode = mode
        self.expr = expr
        if is_file is not None:
            self.isFile = is_file
        self.exports = exports or []

    def eval(self):
        return self._value


class _FakeOp:
    def __init__(
        self,
        path,
        name=None,
        ty="constantTOP",
        family="TOP",
        pars=None,
        out_conns=0,
        in_conns=0,
        is_comp=False,
        viewer=False,
        display=None,
        render=None,
        children=None,
        parent=None,
    ):
        self.path = path
        self.name = name or path.rsplit("/", 1)[-1]
        self.type = ty
        self.OPType = ty
        self.family = family
        self._pars = pars or []
        self.outputConnectors = [_Connector([object()] * out_conns)] if out_conns else [_Connector()]
        self.inputConnectors = [_Connector([object()] * in_conns)] if in_conns else [_Connector()]
        self.isCOMP = is_comp
        self.viewer = viewer
        self.children = children if children is not None else []
        self._parent = parent

        class _ParAttr:
            pass

        pa_attr = _ParAttr()
        if display is not None:
            d = _Par("display", value=display)
            d.eval = lambda: display  # type: ignore[assignment]
            pa_attr.display = d
        if render is not None:
            r = _Par("render", value=render)
            r.eval = lambda: render  # type: ignore[assignment]
            pa_attr.render = r
        self.par = pa_attr

    def pars(self):
        return self._pars

    def parent(self):
        return self._parent

    def op(self, ref):
        # Used by _resolve to look up siblings — fake graph routes through op_global.
        return None

    # findChildren / op_global wired by the test root


class _FakeRoot(_FakeOp):
    def __init__(self, path, kids):
        super().__init__(path, ty="container", family="COMP", is_comp=True)
        self._kids = kids
        for k in kids:
            k._parent = self

    def findChildren(self, depth=None, maxDepth=None):  # noqa: N803
        return list(self._kids)


def _install_root(root):
    """Patch ``td.op`` to resolve our fake graph."""
    by_path = {root.path: root}
    if hasattr(root, "_kids"):
        for k in root._kids:
            by_path[k.path] = k

    by_name = {k.name: k for k in getattr(root, "_kids", [])}

    def fake_op(p):
        if p == root.path:
            return root
        if p in by_path:
            return by_path[p]
        return by_name.get(p)

    _td_stub.op = fake_op
    return by_path


# --- Tests ---------------------------------------------------------------------


class AnalyzeBasicsTests(unittest.TestCase):
    def test_root_not_found_returns_fatal(self):
        _td_stub.op = lambda p: None
        r = pa.analyze("/nope", True)
        self.assertIn("Network not found", r.get("fatal", ""))
        # but shape is still present
        self.assertEqual(r["counts"]["nodes"], 0)
        self.assertEqual(r["unused"], [])

    def test_counts_by_family(self):
        kids = [
            _FakeOp("/p/a", ty="noiseTOP", family="TOP", out_conns=1),
            _FakeOp("/p/b", ty="lfoCHOP", family="CHOP", out_conns=1),
            _FakeOp("/p/c", ty="constantTOP", family="TOP", out_conns=1),
        ]
        _install_root(_FakeRoot("/p", kids))
        r = pa.analyze("/p", True)
        self.assertEqual(r["counts"]["nodes"], 3)
        self.assertEqual(r["counts"]["by_family"], {"TOP": 2, "CHOP": 1})

    def test_unused_node_flagged(self):
        # No outputs, not referenced, not displayed → unused.
        dead = _FakeOp("/p/dead", ty="constantTOP", out_conns=0)
        wired = _FakeOp("/p/keep", ty="nullTOP", out_conns=1)
        _install_root(_FakeRoot("/p", [dead, wired]))
        r = pa.analyze("/p", True)
        unused_paths = [u["path"] for u in r["unused"]]
        self.assertIn("/p/dead", unused_paths)
        self.assertNotIn("/p/keep", unused_paths)

    def test_intentional_out_null_not_flagged(self):
        # Top-level "out1" with no outputs is intentional → not unused.
        out = _FakeOp("/p/out1", ty="outTOP", out_conns=0)
        _install_root(_FakeRoot("/p", [out]))
        r = pa.analyze("/p", True)
        self.assertEqual(r["unused"], [])

    def test_displayed_node_not_flagged_as_unused(self):
        # display=True → not unused even with 0 outputs.
        shown = _FakeOp("/p/show", ty="constantTOP", out_conns=0, display=True)
        _install_root(_FakeRoot("/p", [shown]))
        r = pa.analyze("/p", True)
        self.assertEqual(r["unused"], [])


class AnalyzeDependencyTests(unittest.TestCase):
    def test_expression_par_creates_dependency(self):
        # blur1.tx is an expression referencing op('lfo1'). expr_enum is derived
        # from the first par's mode.type — so the LFO's pars must use _Mode too.
        lfo = _FakeOp("/p/lfo1", ty="lfoCHOP", family="CHOP", out_conns=0)
        blur_par = _Par("tx", mode=_Mode.EXPRESSION, expr="op('lfo1')['chan1']")
        blur = _FakeOp("/p/blur1", ty="blurTOP", family="TOP", pars=[blur_par], out_conns=1)
        _install_root(_FakeRoot("/p", [blur, lfo]))
        r = pa.analyze("/p", True)
        self.assertEqual(r["dependency_map"].get("/p/blur1"), ["/p/lfo1"])

    def test_source_style_par_creates_dependency(self):
        src = _FakeOp("/p/src", ty="noiseTOP", family="TOP", out_conns=0)
        sel_par = _Par("top", value="src", mode=_Mode.CONSTANT)
        sel = _FakeOp("/p/sel", ty="selectTOP", family="TOP", pars=[sel_par], out_conns=1)
        _install_root(_FakeRoot("/p", [sel, src]))
        r = pa.analyze("/p", True)
        self.assertEqual(r["dependency_map"].get("/p/sel"), ["/p/src"])

    def test_referenced_node_not_unused(self):
        # src has no wired outputs but is referenced via op() → not unused.
        src = _FakeOp("/p/src", ty="noiseTOP", out_conns=0)
        blur_par = _Par("tx", mode=_Mode.EXPRESSION, expr="op('src')['r']")
        blur = _FakeOp("/p/blur", ty="blurTOP", pars=[blur_par], out_conns=1)
        _install_root(_FakeRoot("/p", [blur, src]))
        r = pa.analyze("/p", True)
        unused_paths = [u["path"] for u in r["unused"]]
        self.assertNotIn("/p/src", unused_paths)


class AnalyzeFileDepsTests(unittest.TestCase):
    def test_broken_file_dep_reported(self):
        par = _Par("file", value="/definitely/missing/path.mov", is_file=True)
        n = _FakeOp("/p/movie", ty="moviefileinTOP", pars=[par], out_conns=1)
        _install_root(_FakeRoot("/p", [n]))
        r = pa.analyze("/p", True)
        self.assertEqual(len(r["broken_file_deps"]), 1)
        self.assertEqual(r["broken_file_deps"][0]["par"], "file")
        self.assertEqual(r["broken_file_deps"][0]["file"], "/definitely/missing/path.mov")

    def test_existing_file_not_reported(self):
        par = _Par("file", value=__file__, is_file=True)
        n = _FakeOp("/p/movie", ty="moviefileinTOP", pars=[par], out_conns=1)
        _install_root(_FakeRoot("/p", [n]))
        r = pa.analyze("/p", True)
        self.assertEqual(r["broken_file_deps"], [])

    def test_relative_path_resolved_against_project_folder(self):
        # Relative path should resolve against td.project.folder before being flagged.
        project_dir = os.path.dirname(os.path.abspath(__file__))
        rel_name = os.path.basename(__file__)  # this very test file — exists.
        par_existing = _Par("file", value=rel_name, is_file=True)
        n_existing = _FakeOp("/p/has", ty="moviefileinTOP", pars=[par_existing], out_conns=1)

        par_missing = _Par("file", value="definitely_not_here.mov", is_file=True)
        n_missing = _FakeOp("/p/miss", ty="moviefileinTOP", pars=[par_missing], out_conns=1)

        _install_root(_FakeRoot("/p", [n_existing, n_missing]))
        # Inject td.project.folder
        prev_project = getattr(_td_stub, "project", None)
        _td_stub.project = types.SimpleNamespace(folder=project_dir)
        try:
            r = pa.analyze("/p", True)
        finally:
            if prev_project is None:
                del _td_stub.project
            else:
                _td_stub.project = prev_project

        broken_paths = [b["path"] for b in r["broken_file_deps"]]
        self.assertNotIn("/p/has", broken_paths)
        self.assertIn("/p/miss", broken_paths)

    def test_file_par_hint_used_when_isfile_absent(self):
        # name in _FILE_PAR_HINTS + no isFile attr → still treated as file.
        par = _Par("moviefile", value="/missing.mov")
        n = _FakeOp("/p/movie", pars=[par], out_conns=1)
        _install_root(_FakeRoot("/p", [n]))
        r = pa.analyze("/p", True)
        self.assertEqual(len(r["broken_file_deps"]), 1)


class AnalyzeOrphanCompTests(unittest.TestCase):
    def test_orphan_comp_flagged(self):
        empty = _FakeOp(
            "/p/empty", ty="container", family="COMP", is_comp=True, children=[], out_conns=0
        )
        _install_root(_FakeRoot("/p", [empty]))
        r = pa.analyze("/p", True)
        orphan_paths = [o["path"] for o in r["orphan_comps"]]
        self.assertIn("/p/empty", orphan_paths)

    def test_non_empty_comp_not_orphan(self):
        kid = _FakeOp("/p/full/kid", ty="constantTOP")
        full = _FakeOp(
            "/p/full",
            ty="container",
            family="COMP",
            is_comp=True,
            children=[kid],
            out_conns=0,
        )
        _install_root(_FakeRoot("/p", [full]))
        r = pa.analyze("/p", True)
        self.assertEqual(r["orphan_comps"], [])


class AnalyzeRobustnessTests(unittest.TestCase):
    def test_par_eval_raising_does_not_kill_scan(self):
        class _Boom(_Par):
            def eval(self):
                raise RuntimeError("kaboom")

        bad = _Boom("file", is_file=True)
        n = _FakeOp("/p/n", pars=[bad], out_conns=1)
        _install_root(_FakeRoot("/p", [n]))
        r = pa.analyze("/p", True)
        # Did not raise; counts populated; broken-deps empty (eval failed).
        self.assertEqual(r["counts"]["nodes"], 1)
        self.assertEqual(r["broken_file_deps"], [])

    def test_findchildren_raising_falls_back_to_default(self):
        class _BadRoot(_FakeRoot):
            def findChildren(self, depth=None, maxDepth=None):  # noqa: N803
                if maxDepth or depth:
                    raise RuntimeError("bad kwargs")
                return list(self._kids)

        kid = _FakeOp("/p/n", out_conns=1)
        root = _BadRoot("/p", [kid])
        _install_root(root)
        r = pa.analyze("/p", True)
        self.assertEqual(r["counts"]["nodes"], 1)

    def test_recursive_flag_passed_through(self):
        _install_root(_FakeRoot("/p", []))
        r = pa.analyze("/p", recursive=False)
        self.assertFalse(r["recursive"])


if __name__ == "__main__":
    unittest.main()
