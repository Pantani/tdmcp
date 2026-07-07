"""Unit tests for the first-class node-save bridge module (save_service).

Runs off-TD by installing a stub ``td`` module whose ``op`` resolves paths against
a small dict of fake ops. ``FakeTop`` mimics an image operator (has ``.save`` +
``.width``/``.height``); ``FakeComp`` mimics a component (``.save`` only, returns
the path string). ``FakeStatusTop`` returns a non-str status object like the real
``TOP.save`` (``FileSaveStatus``), which the service must normalize.

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

from mcp.services import save_service as ss  # noqa: E402


class FakeComp:
    def __init__(self, path):
        self.path = path

    def save(self, file, createFolders=True):  # noqa: N803 (TD kw)
        # COMP.save returns the saved path as a str.
        return file


class FakeTop:
    def __init__(self, path, width=256, height=128):
        self.path = path
        self.width = width
        self.height = height

    def save(self, file, createFolders=True):  # noqa: N803
        return file


class _FileSaveStatus:
    """Mimics td.FileSaveStatus — its str() is NOT the target path."""

    def __repr__(self):
        return "<td.FileSaveStatus object>"


class FakeStatusTop:
    def __init__(self, path):
        self.path = path
        self.width = 1920
        self.height = 1080

    def save(self, file, createFolders=True):  # noqa: N803
        return _FileSaveStatus()


class FakeNoSave:
    def __init__(self, path):
        self.path = path


class _OpPatch:
    def __init__(self, graph):
        self.graph = graph

    def __enter__(self):
        self._prev = _TD.op
        _TD.op = lambda path: self.graph.get(path)
        return self

    def __exit__(self, *exc):
        _TD.op = self._prev


class SaveServiceTest(unittest.TestCase):
    def test_comp_save_returns_path_no_dimensions(self):
        with _OpPatch({"/base1": FakeComp("/base1")}):
            report = ss.save_node("/base1", "/tmp/base1.tox")
        self.assertEqual(report["path"], "/base1")
        self.assertEqual(report["saved"], "/tmp/base1.tox")
        self.assertFalse(report["has_dimensions"])
        self.assertNotIn("width", report)

    def test_top_save_reports_dimensions(self):
        with _OpPatch({"/render1": FakeTop("/render1", 640, 360)}):
            report = ss.save_node("/render1", "/tmp/frame.png")
        self.assertTrue(report["has_dimensions"])
        self.assertEqual(report["width"], 640)
        self.assertEqual(report["height"], 360)
        self.assertEqual(report["saved"], "/tmp/frame.png")

    def test_status_object_return_is_normalized_to_requested_file(self):
        # TOP.save returns a FileSaveStatus (non-str); the service must report the
        # requested file as the canonical saved path, not the status repr.
        with _OpPatch({"/render2": FakeStatusTop("/render2")}):
            report = ss.save_node("/render2", "/tmp/out.exr")
        self.assertEqual(report["saved"], "/tmp/out.exr")
        self.assertTrue(report["has_dimensions"])

    def test_missing_node_raises_lookup(self):
        with _OpPatch({}):
            with self.assertRaises(LookupError):
                ss.save_node("/nope", "/tmp/x.tox")

    def test_node_without_save_raises_value(self):
        with _OpPatch({"/plain": FakeNoSave("/plain")}):
            with self.assertRaises(ValueError):
                ss.save_node("/plain", "/tmp/x.tox")

    def test_empty_file_raises_value(self):
        with _OpPatch({"/base1": FakeComp("/base1")}):
            with self.assertRaises(ValueError):
                ss.save_node("/base1", "   ")


if __name__ == "__main__":
    unittest.main()
