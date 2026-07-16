"""Focused offline tests for the bounded node-search bridge service."""

import os
import sys
import types
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_MODULES = os.path.abspath(os.path.join(_HERE, "..", "modules"))
if _MODULES not in sys.path:
    sys.path.insert(0, _MODULES)

sys.modules.setdefault("td", types.ModuleType("td"))

from mcp.services import search_service as search  # noqa: E402


class _Node:
    def __init__(self, path, op_type="baseCOMP", family="COMP", children=None):
        self.path = path
        self.name = path.rsplit("/", 1)[-1]
        self.OPType = op_type
        self.family = family
        self._children = list(children or [])
        self.calls = []

    def findChildren(self, depth=None):  # noqa: N803
        self.calls.append(depth)
        if depth != 1:
            raise AssertionError("service must traverse via direct-child findChildren(depth=1)")
        return list(self._children)


class _Leaf:
    def __init__(self, path, op_type, family):
        self.path = path
        self.name = path.rsplit("/", 1)[-1]
        self.OPType = op_type
        self.family = family


def _fixture():
    deep = _Leaf("/project1/search/alpha/deeper/deep_table", "tableDAT", "DAT")
    deeper = _Node("/project1/search/alpha/deeper", children=[deep])
    alpha_top = _Leaf("/project1/search/alpha/shared_image", "nullTOP", "TOP")
    alpha_chop = _Leaf("/project1/search/alpha/shared_signal", "constantCHOP", "CHOP")
    alpha = _Node(
        "/project1/search/alpha",
        children=[deeper, alpha_chop, alpha_top],
    )
    beta = _Leaf("/project1/search/beta_table", "tableDAT", "DAT")
    zeta = _Leaf("/project1/search/zeta_image", "noiseTOP", "TOP")
    # Deliberately non-global/native order.
    root = _Node("/project1/search", children=[zeta, beta, alpha])
    return root


def _lookup(root):
    return lambda path: root if path == root.path else None


class SearchDepthTests(unittest.TestCase):
    def test_default_depth_is_direct_children(self):
        root = _fixture()
        report = search.search_nodes(root.path, op_lookup=_lookup(root))
        self.assertEqual(
            [node["path"] for node in report["nodes"]],
            [
                "/project1/search/alpha",
                "/project1/search/beta_table",
                "/project1/search/zeta_image",
            ],
        )
        self.assertEqual(report["metadata"]["scanned"], 3)
        self.assertEqual(root.calls, [1])

    def test_max_depth_is_intuitive_and_unbounded_requires_explicit_flag(self):
        root = _fixture()
        depth_two = search.search_nodes(root.path, max_depth=2, op_lookup=_lookup(root))
        self.assertIn("/project1/search/alpha/shared_image", [n["path"] for n in depth_two["nodes"]])
        self.assertNotIn(
            "/project1/search/alpha/deeper/deep_table",
            [n["path"] for n in depth_two["nodes"]],
        )

        root = _fixture()
        unbounded = search.search_nodes(root.path, unbounded=True, op_lookup=_lookup(root))
        self.assertIn(
            "/project1/search/alpha/deeper/deep_table",
            [n["path"] for n in unbounded["nodes"]],
        )
        with self.assertRaisesRegex(ValueError, "requires explicit unbounded"):
            search.search_nodes(root.path, max_depth=None, op_lookup=_lookup(root))
        with self.assertRaisesRegex(ValueError, "contradictory"):
            search.search_nodes(root.path, max_depth=2, unbounded=True, op_lookup=_lookup(root))


class SearchFilterTests(unittest.TestCase):
    def test_legacy_pattern_matches_name_or_full_path(self):
        root = _fixture()
        by_name = search.search_nodes(
            root.path,
            pattern="beta_*",
            op_lookup=_lookup(root),
        )
        self.assertEqual([n["name"] for n in by_name["nodes"]], ["beta_table"])

        by_path_only = search.search_nodes(
            root.path,
            pattern="*/alpha/shared_image",
            max_depth=2,
            op_lookup=_lookup(root),
        )
        self.assertEqual(
            [n["path"] for n in by_path_only["nodes"]],
            ["/project1/search/alpha/shared_image"],
        )

        # Legacy pattern has only '*' as a metacharacter; regex/fnmatch syntax is literal.
        literal = search.search_nodes(
            root.path,
            pattern="beta_[table]?",
            op_lookup=_lookup(root),
        )
        self.assertEqual(literal["nodes"], [])

    def test_globs_type_modes_and_family_are_case_insensitive(self):
        root = _fixture()
        by_glob = search.search_nodes(
            root.path,
            name_glob="SHARED_*",
            path_glob="*/ALPHA/*",
            max_depth=2,
            op_lookup=_lookup(root),
        )
        self.assertEqual(
            [n["name"] for n in by_glob["nodes"]],
            ["shared_image", "shared_signal"],
        )

        exact = search.search_nodes(
            root.path,
            type_filter="TABLEdat",
            type_match="exact",
            family="dat",
            unbounded=True,
            op_lookup=_lookup(root),
        )
        self.assertEqual(
            [n["path"] for n in exact["nodes"]],
            ["/project1/search/alpha/deeper/deep_table", "/project1/search/beta_table"],
        )

        contains = search.search_nodes(
            root.path,
            type_filter="top",
            type_match="contains",
            unbounded=True,
            op_lookup=_lookup(root),
        )
        self.assertEqual({n["family"] for n in contains["nodes"]}, {"TOP"})

    def test_hit_is_compact(self):
        root = _fixture()
        report = search.search_nodes(root.path, limit=1, op_lookup=_lookup(root))
        self.assertEqual(set(report["nodes"][0]), {"path", "name", "type", "family"})


class SearchOrderingAndBudgetTests(unittest.TestCase):
    def test_global_sort_happens_before_result_limit(self):
        root = _fixture()
        report = search.search_nodes(root.path, unbounded=True, limit=2, op_lookup=_lookup(root))
        self.assertEqual(
            [n["path"] for n in report["nodes"]],
            ["/project1/search/alpha", "/project1/search/alpha/deeper"],
        )
        self.assertEqual(
            report["metadata"],
            {
                "scanned": 7,
                "matched": 7,
                "returned": 2,
                "truncated": True,
                "scan_truncated": False,
                "count_complete": True,
                "stop_reason": "completed",
            },
        )

    def test_node_scan_limit_is_stable_and_marks_incomplete_count(self):
        root = _fixture()
        report = search.search_nodes(
            root.path,
            unbounded=True,
            node_scan_limit=3,
            limit=3,
            op_lookup=_lookup(root),
        )
        self.assertEqual(
            [n["path"] for n in report["nodes"]],
            [
                "/project1/search/alpha",
                "/project1/search/alpha/deeper",
                "/project1/search/alpha/deeper/deep_table",
            ],
        )
        self.assertEqual(report["metadata"]["scanned"], 3)
        self.assertEqual(report["metadata"]["matched"], 3)
        self.assertTrue(report["metadata"]["scan_truncated"])
        self.assertFalse(report["metadata"]["count_complete"])
        self.assertEqual(report["metadata"]["stop_reason"], "node_scan_limit")

    def test_time_limit_marks_scan_truncated(self):
        root = _fixture()
        ticks = iter((0.0, 0.0, 1.0))
        report = search.search_nodes(
            root.path,
            unbounded=True,
            time_limit_ms=10,
            op_lookup=_lookup(root),
            clock=lambda: next(ticks),
        )
        self.assertEqual(report["metadata"]["scanned"], 1)
        self.assertTrue(report["metadata"]["scan_truncated"])
        self.assertFalse(report["metadata"]["count_complete"])
        self.assertEqual(report["metadata"]["stop_reason"], "time_limit")


class SearchValidationTests(unittest.TestCase):
    def test_root_must_be_absolute_and_exist(self):
        with self.assertRaisesRegex(ValueError, "absolute"):
            search.search_nodes("project1/search", op_lookup=lambda _path: None)
        with self.assertRaisesRegex(ValueError, "normalized"):
            search.search_nodes("/project1//search", op_lookup=lambda _path: None)
        with self.assertRaisesRegex(LookupError, "Network not found"):
            search.search_nodes("/missing", op_lookup=lambda _path: None)

    def test_depth_limit_scan_and_time_bounds(self):
        root = _fixture()
        lookup = _lookup(root)
        invalid = (
            {"max_depth": 0},
            {"max_depth": 33},
            {"limit": 0},
            {"limit": 201},
            {"node_scan_limit": 0},
            {"node_scan_limit": 10_001},
            {"time_limit_ms": 0},
            {"time_limit_ms": 2_001},
        )
        for kwargs in invalid:
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                search.search_nodes(root.path, op_lookup=lookup, **kwargs)

    def test_rejects_invalid_filters_and_unsupported_new_globs(self):
        root = _fixture()
        lookup = _lookup(root)
        for kwargs in (
            {"name_glob": "bad[glob"},
            {"path_glob": "bad]glob"},
            {"name_glob": "bad?glob"},
            {"path_glob": "bad\\glob"},
            {"pattern": "bad\nglob"},
            {"name_glob": "x" * 257},
            {"type_filter": "x" * 257},
            {"type_match": "prefix"},
            {"family": "VIDEO"},
        ):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                search.search_nodes(root.path, op_lookup=lookup, **kwargs)


if __name__ == "__main__":
    unittest.main()
