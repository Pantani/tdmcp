"""Focused offline tests for the bounded parameter-search service."""

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

from mcp.services import parameter_search_service as search  # noqa: E402


class _Mode:
    def __init__(self, name):
        self.name = name

    def __str__(self):
        return "ParMode.%s" % self.name


class _Par:
    def __init__(
        self,
        name,
        value,
        *,
        expr="",
        mode="CONSTANT",
        is_default=True,
        password=False,
        page=True,
    ):
        self.name = name
        self._value = value
        self.expr = expr
        self.mode = _Mode(mode)
        self.isDefault = is_default
        self.password = password
        self.page = object() if page else None

    def eval(self):
        if isinstance(self._value, Exception):
            raise self._value
        return self._value


class _UnreadableExprPar(_Par):
    @property
    def expr(self):
        raise RuntimeError("private expression sentinel")

    @expr.setter
    def expr(self, _value):
        pass


class _UnreadableModePar(_Par):
    @property
    def mode(self):
        raise RuntimeError("private mode sentinel")

    @mode.setter
    def mode(self, _value):
        pass


class _UnreadableDefaultPar(_Par):
    @property
    def isDefault(self):  # noqa: N802
        raise RuntimeError("private default sentinel")

    @isDefault.setter
    def isDefault(self, _value):  # noqa: N802
        pass


class _OpValue:
    def __init__(self, path):
        self.path = path


class _Node:
    def __init__(self, path, parameters, op_type="baseCOMP", family="COMP"):
        self.path = path
        self.name = path.rsplit("/", 1)[-1]
        self.OPType = op_type
        self.family = family
        self._parameters = list(parameters)

    def pars(self):
        return list(self._parameters)


class _Root:
    def __init__(self, path, children):
        self.path = path
        self.name = path.rsplit("/", 1)[-1]
        self.OPType = "baseCOMP"
        self.family = "COMP"
        self._children = list(children)

    def findChildren(self, depth=None):  # noqa: N803
        if depth != 1:
            raise AssertionError("parameter search must reuse direct-child traversal")
        return list(self._children)


def _lookup(root):
    return lambda path: root if path == root.path else None


def _search(root, **kwargs):
    return search.search_parameters(
        root.path,
        op_lookup=_lookup(root),
        clock=lambda: 0.0,
        **kwargs,
    )


class ParameterSearchFilterTests(unittest.TestCase):
    def setUp(self):
        self.alpha = _Node(
            "/project1/search/alpha",
            [
                _Par("zeta", 10),
                _Par("gain", 0.75, is_default=False),
                _Par("speed", 2, expr="absTime.seconds", mode="EXPRESSION", is_default=False),
                _Par("hidden", 3, page=False),
            ],
            "noiseTOP",
            "TOP",
        )
        self.beta = _Node(
            "/project1/search/beta",
            [
                _Par("bound", 4, mode="BIND", is_default=False),
                _Par("exported", 5, mode="EXPORT", is_default=False),
                _Par("mystery", 6, mode="FUTURE"),
            ],
            "constantCHOP",
            "CHOP",
        )
        # Native order is deliberately opposite the required result order.
        self.root = _Root("/project1/search", [self.beta, self.alpha])

    def test_orders_by_utf8_op_path_then_parameter_name_before_limit(self):
        full = _search(self.root, limit=20)
        pairs = [(hit["op"], hit["par"]) for hit in full["results"]]
        self.assertEqual(pairs, sorted(pairs, key=lambda pair: (pair[0].encode(), pair[1].encode())))

        limited = _search(self.root, limit=2)
        self.assertEqual(limited["results"], full["results"][:2])
        self.assertEqual(limited["matched"], full["matched"])
        self.assertTrue(limited["truncated"])
        self.assertFalse(limited["scan_truncated"])

    def test_combines_node_parameter_value_expression_and_type_filters(self):
        report = _search(
            self.root,
            node_pattern="alpha",
            node_name_glob="alp*",
            node_path_glob="*/alpha",
            type_filter="noise",
            type_match="partial",
            family="top",
            parameter_glob="sp*",
            value_glob="2",
            expression_glob="*seconds",
            mode="expression",
            non_default_only=True,
        )
        self.assertEqual([(hit["par"], hit["value"]) for hit in report["results"]], [("speed", 2)])

        exact = _search(self.root, type_filter="constantCHOP", type_match="exact", mode="BIND")
        self.assertEqual([hit["par"] for hit in exact["results"]], ["bound"])

    def test_normalizes_all_modes_and_skips_parameters_without_a_page(self):
        report = _search(self.root, limit=20)
        modes = {hit["par"]: hit["mode"] for hit in report["results"]}
        self.assertEqual(modes["gain"], "CONSTANT")
        self.assertEqual(modes["speed"], "EXPRESSION")
        self.assertEqual(modes["bound"], "BIND")
        self.assertEqual(modes["exported"], "EXPORT")
        self.assertEqual(modes["mystery"], "UNKNOWN")
        self.assertNotIn("hidden", modes)
        self.assertEqual(report["skipped_parameters"], 1)


class ParameterSearchSafetyTests(unittest.TestCase):
    def test_redacts_likely_secrets_and_content_filters_are_not_an_oracle(self):
        sentinel = "DISPOSABLE-SENTINEL-9d4b"
        root = _Root(
            "/project1/search",
            [
                _Node(
                    "/project1/search/auth",
                    [
                        _Par("Apitoken", sentinel, expr="sentinel_expr"),
                        _Par("innocent", sentinel),
                        _Par("masked", "also-private", password=True),
                    ],
                )
            ],
        )

        redacted = _search(root, parameter_glob="*token")
        text = json.dumps(redacted)
        self.assertNotIn(sentinel, text)
        self.assertNotIn("sentinel_expr", text)
        self.assertEqual(redacted["results"][0]["value"], "[REDACTED]")
        self.assertEqual(redacted["results"][0]["expr"], "[REDACTED]")
        self.assertTrue(redacted["results"][0]["redacted"])
        self.assertEqual(redacted["redacted_parameters"], 1)

        right_guess = _search(root, parameter_glob="*token", value_glob="*SENTINEL*")
        wrong_guess = _search(root, parameter_glob="*token", value_glob="*WRONG*")
        self.assertEqual(right_guess["results"], [])
        self.assertEqual(right_guess["results"], wrong_guess["results"])
        self.assertEqual(right_guess["skipped_parameters"], wrong_guess["skipped_parameters"])
        self.assertNotIn(sentinel, json.dumps(right_guess))

    def test_unreadable_parameters_skip_forward_without_exception_content(self):
        root = _Root(
            "/project1/search",
            [
                _Node(
                    "/project1/search/errors",
                    [
                        _Par("bad_eval", RuntimeError("private eval sentinel")),
                        _UnreadableExprPar("bad_expr", 1),
                        _UnreadableModePar("bad_mode", 1),
                        _UnreadableDefaultPar("bad_default", 1),
                        _Par("good", 7),
                    ],
                )
            ],
        )
        report = _search(root)
        self.assertEqual([hit["par"] for hit in report["results"]], ["good"])
        self.assertEqual(report["unreadable_parameters"], 4)
        self.assertEqual(report["skipped_parameters"], 4)
        output = json.dumps(report)
        self.assertNotIn("private", output)
        self.assertNotIn("sentinel", output)

    def test_serializes_values_safely_and_bounds_value_and_expression_text(self):
        root = _Root(
            "/project1/search",
            [
                _Node(
                    "/project1/search/values",
                    [
                        _Par("compound", {"z": [2, 1], "a": True}),
                        _Par("nan", float("nan")),
                        _Par("opref", _OpValue("/project1/source")),
                        _Par("long", "v" * 400, expr="e" * 700),
                    ],
                )
            ],
        )
        report = _search(root)
        hits = {hit["par"]: hit for hit in report["results"]}
        self.assertEqual(hits["compound"]["value"], '{"a":true,"z":[2,1]}')
        self.assertEqual(hits["nan"]["value"], "NaN")
        self.assertEqual(hits["opref"]["value"], "/project1/source")
        self.assertEqual(len(hits["long"]["value"]), search.MAX_VALUE_TEXT_LENGTH)
        self.assertEqual(len(hits["long"]["expr"]), search.MAX_EXPRESSION_TEXT_LENGTH)
        self.assertTrue(hits["long"]["value_truncated"])
        self.assertTrue(hits["long"]["expr_truncated"])


class ParameterSearchBudgetAndValidationTests(unittest.TestCase):
    def test_parameter_node_and_time_limits_have_truthful_metadata(self):
        nodes = [
            _Node("/project1/search/%s" % name, [_Par("a", 1), _Par("b", 2)])
            for name in ("a", "b", "c")
        ]
        root = _Root("/project1/search", list(reversed(nodes)))

        parameter_limited = _search(root, parameter_scan_limit=3, limit=20)
        self.assertEqual(parameter_limited["scanned_parameters"], 3)
        self.assertTrue(parameter_limited["scan_truncated"])
        self.assertFalse(parameter_limited["count_complete"])
        self.assertEqual(parameter_limited["stop_reason"], "parameter_scan_limit")

        node_limited = _search(root, node_scan_limit=1, limit=20)
        self.assertEqual(node_limited["scanned_nodes"], 1)
        self.assertTrue(node_limited["scan_truncated"])
        self.assertEqual(node_limited["stop_reason"], "node_scan_limit")

        ticks = iter((0.0, 0.0, 0.0, 1.0, 1.0, 1.0))
        timed = search.search_parameters(
            root.path,
            time_budget_ms=25,
            op_lookup=_lookup(root),
            clock=lambda: next(ticks),
        )
        self.assertEqual(timed["stop_reason"], "time_limit")
        self.assertTrue(timed["scan_truncated"])
        self.assertEqual(timed["scanned_parameters"], 0)

    def test_response_is_bounded_even_with_large_operator_paths(self):
        huge_path = "/project1/search/" + ("x" * 2_000)
        parameters = [_Par("p%03d" % index, "v" * 256) for index in range(200)]
        root = _Root("/project1/search", [_Node(huge_path, parameters)])
        report = _search(root, limit=200)
        encoded = json.dumps(report, ensure_ascii=False, separators=(",", ":")).encode()
        self.assertLessEqual(len(encoded), search.MAX_RESPONSE_BYTES)
        self.assertLess(report["returned"], report["matched"])
        self.assertTrue(report["truncated"])

    def test_root_slash_requires_a_narrowing_predicate(self):
        root = _Root("/", [])
        with self.assertRaisesRegex(ValueError, "narrowing predicate"):
            _search(root)
        report = _search(root, parameter_glob="gain*")
        self.assertEqual(report["results"], [])

    def test_rejects_invalid_bounds_enums_and_globs(self):
        root = _Root("/project1/search", [])
        invalid = (
            {"max_depth": 0},
            {"max_depth": 33},
            {"limit": 0},
            {"limit": 201},
            {"node_scan_limit": 0},
            {"node_scan_limit": 10_001},
            {"parameter_scan_limit": 0},
            {"parameter_scan_limit": 100_001},
            {"time_budget_ms": 24},
            {"time_budget_ms": 2_501},
            {"type_match": "prefix"},
            {"family": "VIDEO"},
            {"mode": "PYTHON"},
            {"parameter_glob": "bad?glob"},
            {"value_glob": "bad[glob"},
            {"expression_glob": "bad\\glob"},
            {"node_name_glob": "x" * 129},
            {"value_glob": "x" * 257},
            {"parameter_glob": "bad\nglob"},
        )
        for kwargs in invalid:
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                _search(root, **kwargs)


if __name__ == "__main__":
    unittest.main()
