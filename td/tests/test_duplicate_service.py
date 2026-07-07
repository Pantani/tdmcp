"""Unit tests for the first-class duplicate bridge module (duplicate_service).

Runs off-TD with a stub ``td`` module. ``FakeOp`` exposes ``.path``, ``.parent()``,
and ``.copy(src, name=...)`` (returning a new FakeOp under the parent), mimicking
TD's ``COMP.copy`` deep-copy contract.

Run from the repo root: ``python3 -m unittest discover -s td/tests``. Stdlib only.
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
_td_stub.op = lambda path: None
sys.modules.setdefault("td", _td_stub)
_TD = sys.modules["td"]

from mcp.services import duplicate_service as ds  # noqa: E402


class FakeOp:
    def __init__(self, path, parent=None, copy_fails=False):
        self.path = path
        self._parent = parent
        self._copy_fails = copy_fails
        self._counter = 0

    def parent(self):
        return self._parent

    def copy(self, src, name=None):
        if self._copy_fails:
            raise RuntimeError("copy blew up")
        self._counter += 1
        base = name or "%s%d" % (src.path.rsplit("/", 1)[-1], self._counter)
        new_path = "%s/%s" % (self.path.rstrip("/"), base)
        return FakeOp(new_path, parent=self)


class _OpPatch:
    def __init__(self, graph):
        self.graph = graph

    def __enter__(self):
        self._prev = _TD.op
        _TD.op = lambda path: self.graph.get(path)
        return self

    def __exit__(self, *exc):
        _TD.op = self._prev


class DuplicateServiceTest(unittest.TestCase):
    def test_duplicate_into_source_parent(self):
        parent = FakeOp("/project1")
        src = FakeOp("/project1/base1", parent=parent)
        with _OpPatch({"/project1/base1": src, "/project1": parent}):
            report = ds.duplicate("/project1/base1")
        self.assertEqual(report["source"], "/project1/base1")
        self.assertEqual(report["parent"], "/project1")
        self.assertTrue(report["copy"].startswith("/project1/"))
        self.assertNotEqual(report["copy"], report["source"])

    def test_duplicate_with_explicit_name_and_parent(self):
        src_parent = FakeOp("/project1")
        dst_parent = FakeOp("/project1/holder")
        src = FakeOp("/project1/base1", parent=src_parent)
        with _OpPatch(
            {"/project1/base1": src, "/project1/holder": dst_parent, "/project1": src_parent}
        ):
            report = ds.duplicate("/project1/base1", name="copyX", parent_path="/project1/holder")
        self.assertEqual(report["parent"], "/project1/holder")
        self.assertEqual(report["copy"], "/project1/holder/copyX")

    def test_missing_source_raises_lookup(self):
        with _OpPatch({}):
            with self.assertRaises(LookupError):
                ds.duplicate("/nope")

    def test_missing_explicit_parent_raises_lookup(self):
        src = FakeOp("/project1/base1", parent=FakeOp("/project1"))
        with _OpPatch({"/project1/base1": src}):
            with self.assertRaises(LookupError):
                ds.duplicate("/project1/base1", parent_path="/nope")

    def test_copy_failure_raises_value(self):
        parent = FakeOp("/project1", copy_fails=True)
        src = FakeOp("/project1/base1", parent=parent)
        with _OpPatch({"/project1/base1": src, "/project1": parent}):
            with self.assertRaises(ValueError):
                ds.duplicate("/project1/base1")


if __name__ == "__main__":
    unittest.main()
