"""Unit tests for project_load_service.load.

Mirrors ``test_transport_service.py`` / ``test_project_analysis_service.py``:
install a stub ``td`` module + drive ``load()`` off-TD against fakes. Verifies the
returned envelope shape (root_path / node_count / errors / optional preview_b64),
input validation (400-mapped ValueErrors), and per-field defensiveness.

Run from repo root: ``python3 -m unittest discover -s td/tests``.
"""

import os
import sys
import tempfile
import types
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_MODULES = os.path.abspath(os.path.join(_HERE, "..", "modules"))
if _MODULES not in sys.path:
    sys.path.insert(0, _MODULES)

# project_load_service does ``import td`` INSIDE load(); reach the shared stub.
_td_stub = sys.modules.setdefault("td", types.ModuleType("td"))

from mcp.services import project_load_service as pl  # noqa: E402


# --- Fakes ---------------------------------------------------------------------


class _FakeNode:
    def __init__(self, path, is_comp=False, children=None, errors_text="", level="error"):
        self.path = path
        self.isCOMP = is_comp
        self.children = children if children is not None else []
        self._errors = errors_text
        self.name = level  # _level_name reads getattr(level, "name") then str(level)

    def findChildren(self, maxDepth=None):  # noqa: N803
        return list(self.children)

    def errors(self, recurse=False):  # noqa: ARG002
        return self._errors


class _FakeRootSlash:
    """Stand-in for ``op('/')`` — exposes the single top-level project COMP."""

    def __init__(self, comp):
        self.children = [comp]


class _FakeProject:
    def __init__(self):
        self.loaded = []

    def load(self, path):
        self.loaded.append(path)


def _install(td_stub, *, slash_children, by_path):
    project = _FakeProject()
    td_stub.project = project

    def fake_op(p):
        if p == "/":
            return _FakeRootSlash(slash_children[0]) if slash_children else _FakeRootSlash(None)
        return by_path.get(p)

    td_stub.op = fake_op
    return project


def _toe_file():
    fd, path = tempfile.mkstemp(suffix=".toe")
    os.close(fd)
    return path


# --- Tests ---------------------------------------------------------------------


class LoadValidationTests(unittest.TestCase):
    def test_rejects_empty_path(self):
        with self.assertRaises(ValueError):
            pl.load("")

    def test_rejects_relative_path(self):
        with self.assertRaises(ValueError) as cm:
            pl.load("relative/x.toe")
        self.assertIn("absolute", str(cm.exception))

    def test_rejects_wrong_extension(self):
        path = tempfile.mkstemp(suffix=".txt")[1]
        try:
            with self.assertRaises(ValueError) as cm:
                pl.load(path)
            self.assertIn(".toe", str(cm.exception))
        finally:
            os.unlink(path)

    def test_rejects_missing_file(self):
        with self.assertRaises(ValueError) as cm:
            pl.load("/definitely/missing/proj.toe")
        self.assertIn("not found", str(cm.exception))


class LoadReportTests(unittest.TestCase):
    def setUp(self):
        self.toe = _toe_file()

    def tearDown(self):
        os.unlink(self.toe)

    def test_loads_and_reports_root_and_count(self):
        kid_a = _FakeNode("/project1/a")
        kid_b = _FakeNode("/project1/b")
        root = _FakeNode("/project1", is_comp=True, children=[kid_a, kid_b])
        project = _install(_td_stub, slash_children=[root], by_path={"/project1": root})

        report = pl.load(self.toe, timeout_ms=5000)

        # project.load was actually invoked with the artifact path.
        self.assertEqual(project.loaded, [self.toe])
        self.assertEqual(report["root_path"], "/project1")
        self.assertEqual(report["node_count"], 2)
        self.assertEqual(report["errors"], [])
        # No preview op resolvable → preview_b64 omitted (optional).
        self.assertNotIn("preview_b64", report)

    def test_collects_node_errors(self):
        bad = _FakeNode("/project1/bad", errors_text="GLSL: compile failed", level="error")
        root = _FakeNode("/project1", is_comp=True, children=[bad])
        _install(_td_stub, slash_children=[root], by_path={"/project1": root})

        report = pl.load(self.toe)

        self.assertEqual(len(report["errors"]), 1)
        self.assertEqual(report["errors"][0]["path"], "/project1/bad")
        self.assertEqual(report["errors"][0]["message"], "GLSL: compile failed")

    def test_falls_back_to_project1_when_no_comp_child(self):
        # op('/') has no COMP child → root_path defaults to /project1 (None nodes).
        _install(_td_stub, slash_children=[], by_path={})
        report = pl.load(self.toe)
        self.assertEqual(report["root_path"], "/project1")
        self.assertEqual(report["node_count"], 0)
        self.assertEqual(report["errors"], [])

    def test_node_errors_raising_does_not_kill_report(self):
        class _Boom(_FakeNode):
            def errors(self, recurse=False):  # noqa: ARG002
                raise RuntimeError("kaboom")

        boom = _Boom("/project1/n")
        root = _FakeNode("/project1", is_comp=True, children=[boom])
        _install(_td_stub, slash_children=[root], by_path={"/project1": root})

        report = pl.load(self.toe)
        self.assertEqual(report["node_count"], 1)
        self.assertEqual(report["errors"], [])


if __name__ == "__main__":
    unittest.main()
