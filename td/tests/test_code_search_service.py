"""Focused offline tests for bounded TouchDesigner code search."""

import json
import os
import sys
import types
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_MODULES = os.path.abspath(os.path.join(_HERE, "..", "modules"))
if _MODULES not in sys.path:
    sys.path.insert(0, _MODULES)

sys.modules.setdefault("td", types.ModuleType("td"))

from mcp.services import code_search_service as search  # noqa: E402


class _Par:
    def __init__(self, name, *, expr="", password=False):
        self.name = name
        self.expr = expr
        self.password = password


class _Node:
    def __init__(
        self,
        path,
        *,
        text=None,
        parameters=(),
        op_type="baseCOMP",
        family="COMP",
    ):
        self.path = path
        self.name = path.rsplit("/", 1)[-1]
        self.OPType = op_type
        self.family = family
        self._parameters = list(parameters)
        if text is not None:
            self.text = text

    def pars(self):
        return list(self._parameters)


class _UnreadableDat(_Node):
    @property
    def text(self):
        raise RuntimeError("private DAT sentinel")

    @text.setter
    def text(self, _value):
        pass


class _Root(_Node):
    def __init__(self, path, children):
        super().__init__(path)
        self._children = list(children)

    def findChildren(self, depth=None):  # noqa: N803
        if depth != 1:
            raise AssertionError("code search must reuse direct-child traversal")
        return list(self._children)


def _lookup(root):
    return lambda path: root if path == root.path else None


def _search(root, query, **kwargs):
    return search.search_code(
        query,
        root.path,
        op_lookup=_lookup(root),
        clock=lambda: 0.0,
        **kwargs,
    )


class CodeSearchRankingTests(unittest.TestCase):
    def setUp(self):
        self.callbacks = _Node(
            "/project1/search/callbacks",
            text=(
                "def onPulse(par):\n"
                "    reset_feedback_buffer()\n\n"
                "def reset_feedback_buffer():\n"
                "    op('feedback1').par.reset.pulse()\n"
            ),
            op_type="textDAT",
            family="DAT",
        )
        self.controller = _Node(
            "/project1/search/controller",
            parameters=[
                _Par("Speed", expr="op('clock1')['speed'] * 0.5"),
                _Par("Reset", expr="op('callbacks').module.reset_feedback_buffer"),
                _Par("Constant"),
            ],
        )
        self.root = _Root("/project1/search", [self.controller, self.callbacks])

    def test_searches_coherent_dat_and_expression_documents_with_provenance(self):
        report = _search(self.root, "reset feedback buffer")

        self.assertEqual(report["matched"], 2)
        self.assertEqual(report["returned"], 2)
        self.assertTrue(report["count_complete"])
        self.assertEqual(report["results"][0]["op"], self.callbacks.path)
        self.assertEqual(report["results"][0]["source_kind"], "dat_text")
        self.assertEqual(report["results"][0]["field"], "text")
        self.assertEqual(report["results"][0]["line"], 2)
        self.assertEqual(report["results"][0]["column"], 5)
        self.assertIn("bm25", report["results"][0]["rank_sources"])
        self.assertEqual(
            {hit["source_kind"] for hit in report["results"]},
            {"dat_text", "parameter_expression"},
        )

    def test_literal_identifier_boosts_and_source_filters_are_deterministic(self):
        report = _search(
            self.root,
            "reset_feedback_buffer",
            source_kinds=["dat_text"],
        )
        self.assertEqual(len(report["results"]), 1)
        self.assertEqual(report["results"][0]["rank_sources"], ["literal", "bm25"])
        self.assertEqual(report["source_kinds"], ["dat_text"])
        self.assertEqual(report["scanned_parameters"], 0)

    def test_indexes_whole_identifiers_and_their_case_and_number_components(self):
        generator = _Node(
            "/project1/search/noise1",
            text="float fbmNoise = resetFeedbackBuffer(); // GLSLShader",
            op_type="noiseTOP",
            family="DAT",
        )
        root = _Root("/project1/search", [generator])

        compound = _search(root, "noise fbm", source_kinds=["dat_text"])
        self.assertEqual([hit["op"] for hit in compound["results"]], [generator.path])
        self.assertIn("bm25", compound["results"][0]["rank_sources"])

        camel_case = _search(root, "feedback buffer", source_kinds=["dat_text"])
        self.assertEqual([hit["op"] for hit in camel_case["results"]], [generator.path])

        acronym = _search(root, "glsl shader", source_kinds=["dat_text"])
        self.assertEqual([hit["op"] for hit in acronym["results"]], [generator.path])

        whole_identifier = _search(root, "noisetop operator", source_kinds=["dat_text"])
        self.assertEqual([hit["op"] for hit in whole_identifier["results"]], [generator.path])
        self.assertEqual(whole_identifier["results"][0]["rank_sources"], ["bm25"])

    def test_applies_node_filters_before_document_ranking(self):
        report = _search(
            self.root,
            "feedback",
            node_name_glob="control*",
            source_kinds=["parameter_expression"],
        )
        self.assertEqual([hit["op"] for hit in report["results"]], [self.controller.path])


class CodeSearchSafetyTests(unittest.TestCase):
    def test_redacts_before_matching_so_secret_values_are_not_an_oracle(self):
        sentinel = "DISPOSABLE-SENTINEL-9d4b"
        public = _Node(
            "/project1/search/config",
            text=(
                'api_key = "%s"\n'
                'config = {"api_key": "%s"}\n'
                'headers = {"Authorization": "Bearer abcdefghijklmnop"}'
            )
            % (sentinel, sentinel),
            op_type="textDAT",
            family="DAT",
        )
        sensitive = _Node(
            "/project1/search/token_store",
            text="secondary = '%s'" % sentinel,
            op_type="textDAT",
            family="DAT",
        )
        expression = _Node(
            "/project1/search/auth",
            parameters=[
                _Par("ApiToken", expr="'%s'" % sentinel),
                _Par("Header", expr="'Bearer abcdefghijklmnop'"),
            ],
        )
        root = _Root("/project1/search", [public, sensitive, expression])

        guessed = _search(root, sentinel)
        self.assertEqual(guessed["results"], [])
        guessed_without_echo = dict(guessed)
        guessed_without_echo.pop("query")
        self.assertNotIn(sentinel, json.dumps(guessed_without_echo))

        named = _search(root, "api key")
        self.assertEqual(len(named["results"]), 1)
        self.assertEqual(named["results"][0]["excerpt"], "api_key = [REDACTED]")
        self.assertTrue(named["results"][0]["redacted"])
        self.assertGreaterEqual(named["redacted_documents"], 3)
        self.assertNotIn(sentinel, json.dumps(named))
        self.assertNotIn("abcdefghijklmnop", json.dumps(named))

    def test_unreadable_sources_fail_closed_without_exception_content(self):
        root = _Root(
            "/project1/search",
            [
                _UnreadableDat(
                    "/project1/search/broken", op_type="textDAT", family="DAT"
                ),
                _Node(
                    "/project1/search/good",
                    text="def healthy_callback(): pass",
                    op_type="textDAT",
                    family="DAT",
                ),
            ],
        )
        report = _search(root, "healthy callback")
        self.assertEqual(len(report["results"]), 1)
        self.assertEqual(report["unreadable_documents"], 1)
        self.assertNotIn("private", json.dumps(report))


class CodeSearchBudgetAndValidationTests(unittest.TestCase):
    def test_document_parameter_byte_and_node_limits_are_truthful(self):
        nodes = [
            _Node(
                "/project1/search/%s" % name,
                text="needle %s" % name,
                parameters=[_Par("Expr", expr="needle_%s" % name)],
                op_type="textDAT",
                family="DAT",
            )
            for name in ("a", "b", "c")
        ]
        root = _Root("/project1/search", list(reversed(nodes)))

        document_limited = _search(root, "needle", document_scan_limit=2)
        self.assertEqual(document_limited["scanned_documents"], 2)
        self.assertTrue(document_limited["scan_truncated"])
        self.assertEqual(document_limited["stop_reason"], "document_scan_limit")

        parameter_limited = _search(
            root,
            "needle",
            source_kinds=["parameter_expression"],
            parameter_scan_limit=2,
        )
        self.assertEqual(parameter_limited["scanned_parameters"], 2)
        self.assertTrue(parameter_limited["scan_truncated"])
        self.assertEqual(parameter_limited["stop_reason"], "parameter_scan_limit")

        byte_limited = _search(
            root,
            "needle",
            source_kinds=["dat_text"],
            byte_scan_limit=5,
        )
        self.assertTrue(byte_limited["scan_truncated"])
        self.assertFalse(byte_limited["count_complete"])
        self.assertEqual(byte_limited["stop_reason"], "byte_scan_limit")

        node_limited = _search(root, "needle", node_scan_limit=1)
        self.assertEqual(node_limited["scanned_nodes"], 1)
        self.assertTrue(node_limited["scan_truncated"])
        self.assertEqual(node_limited["stop_reason"], "node_scan_limit")

    def test_limit_bounds_results_without_claiming_the_scan_was_incomplete(self):
        root = _Root(
            "/project1/search",
            [
                _Node(
                    "/project1/search/%s" % name,
                    text="shared needle",
                    op_type="textDAT",
                    family="DAT",
                )
                for name in ("a", "b", "c")
            ],
        )
        report = _search(root, "needle", limit=2)
        self.assertEqual(report["matched"], 3)
        self.assertEqual(report["returned"], 2)
        self.assertTrue(report["truncated"])
        self.assertFalse(report["scan_truncated"])
        self.assertTrue(report["count_complete"])

    def test_rejects_invalid_queries_sources_and_bounds(self):
        root = _Root("/project1/search", [])
        invalid = (
            ("", {}),
            ("***", {}),
            ("needle", {"source_kinds": []}),
            ("needle", {"source_kinds": ["table_cells"]}),
            ("needle", {"document_scan_limit": 0}),
            ("needle", {"parameter_scan_limit": 100_001}),
            ("needle", {"byte_scan_limit": 8 * 1_024 * 1_024 + 1}),
            ("needle", {"time_budget_ms": 24}),
            ("needle", {"node_name_glob": "bad?glob"}),
        )
        for query, kwargs in invalid:
            with self.subTest(query=query, kwargs=kwargs), self.assertRaises(ValueError):
                _search(root, query, **kwargs)


if __name__ == "__main__":
    unittest.main()
