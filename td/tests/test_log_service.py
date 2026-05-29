"""Unit tests for the GET /api/logs Error-DAT reader.

Exercises log_endpoint.get_logs off-TD with a fake Error DAT. The load-bearing
assertions are (1) columns are mapped BY HEADER NAME, so a reordered header
still yields correctly-keyed rows (§7-R6), and (2) a missing Error DAT returns
{available: False, ...} so the client can fall back to the legacy op-walk.

Stdlib only. Run: `python3 -m unittest discover -s td/tests`.
"""

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

_td_stub = types.ModuleType("td")
_td_stub.op = mock.MagicMock(name="op")
sys.modules.setdefault("td", _td_stub)

from mcp.services import log_service as le  # noqa: E402


class FakeErrorDat:
    """A 2D table: rows[r][c]. Row 0 is the header. dat[r, c] -> cell string."""

    def __init__(self, rows):
        self._rows = rows
        self.path = "/project1/tdmcp_bridge/error_log"
        self.numRows = len(rows)
        self.numCols = len(rows[0]) if rows else 0

    def __getitem__(self, key):
        r, c = key
        return self._rows[r][c]


# Confirmed-live header order.
_HEADER = ["source", "message", "absframe", "frame", "severity", "type"]


def _dat(rows):
    return FakeErrorDat([_HEADER] + rows)


def _patch_op(dat):
    return mock.patch.object(le, "op", lambda path: dat)


class GetLogsTests(unittest.TestCase):
    def test_maps_columns_by_header_name(self):
        dat = _dat(
            [
                ["/project1/movie1", "Failed to open file.", "45338", "348", "warning", "TOP"],
            ]
        )
        with _patch_op(dat):
            rep = le.get_logs()
        self.assertTrue(rep["available"])
        self.assertEqual(rep["count"], 1)
        line = rep["lines"][0]
        self.assertEqual(line["source"], "/project1/movie1")
        self.assertEqual(line["message"], "Failed to open file.")
        self.assertEqual(line["severity"], "warning")
        self.assertEqual(line["type"], "TOP")
        # int columns coerced
        self.assertEqual(line["absframe"], 45338)
        self.assertEqual(line["frame"], 348)

    def test_reordered_header_still_keys_correctly(self):
        # Put severity/type/message in a DIFFERENT order than the canonical one;
        # mapping-by-name must keep each value under the right key (§7-R6).
        reordered = ["type", "severity", "source", "message", "frame", "absframe"]
        rows = [
            ["SOP", "error", "/project1/geo1", "Bad SOP.", "12", "999"],
        ]
        dat = FakeErrorDat([reordered] + rows)
        with _patch_op(dat):
            rep = le.get_logs()
        line = rep["lines"][0]
        self.assertEqual(line["type"], "SOP")
        self.assertEqual(line["severity"], "error")
        self.assertEqual(line["source"], "/project1/geo1")
        self.assertEqual(line["message"], "Bad SOP.")
        self.assertEqual(line["frame"], 12)
        self.assertEqual(line["absframe"], 999)

    def test_severity_filter(self):
        dat = _dat(
            [
                ["/p/a", "warn one", "1", "1", "warning", "TOP"],
                ["/p/b", "err one", "2", "2", "error", "CHOP"],
                ["/p/c", "warn two", "3", "3", "warning", "SOP"],
            ]
        )
        with _patch_op(dat):
            rep = le.get_logs(severity="error")
        self.assertEqual(rep["count"], 1)
        self.assertEqual(rep["lines"][0]["message"], "err one")

    def test_scope_prefix_filter(self):
        dat = _dat(
            [
                ["/project1/sceneA/x", "a", "1", "1", "error", "TOP"],
                ["/project1/sceneB/y", "b", "2", "2", "error", "TOP"],
            ]
        )
        with _patch_op(dat):
            rep = le.get_logs(scope="/project1/sceneA")
        self.assertEqual([l["source"] for l in rep["lines"]], ["/project1/sceneA/x"])

    def test_truncates_to_max_lines_keeping_newest(self):
        rows = [["/p/%d" % i, "m%d" % i, str(i), str(i), "error", "TOP"] for i in range(5)]
        dat = _dat(rows)
        with _patch_op(dat):
            rep = le.get_logs(max_lines=2)
        self.assertEqual(rep["count"], 2)
        # newest (last appended) kept
        self.assertEqual([l["message"] for l in rep["lines"]], ["m3", "m4"])
        self.assertTrue(any("Truncated" in w for w in rep["warnings"]))

    def test_missing_dat_returns_unavailable(self):
        with mock.patch.object(le, "op", lambda path: None):
            rep = le.get_logs()
        self.assertFalse(rep["available"])
        self.assertEqual(rep["count"], 0)
        self.assertEqual(rep["lines"], [])
        self.assertTrue(rep["warnings"])
        self.assertEqual(rep["error_dat"], "/project1/tdmcp_bridge/error_log")

    def test_header_only_dat_returns_no_lines(self):
        dat = _dat([])  # header row only
        with _patch_op(dat):
            rep = le.get_logs()
        self.assertTrue(rep["available"])
        self.assertEqual(rep["count"], 0)


if __name__ == "__main__":
    unittest.main()
