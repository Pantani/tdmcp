"""Unit tests for the custom_params_service bridge module.

Stubs ``sys.modules['td']`` with a fake ``op`` that returns ``_FakeNode``s
carrying ``_FakePar`` lists, then drives ``custom_params_service.get_custom_params``
off-TD and asserts the readout shape AND per-par fault isolation.

Run from the repo root: ``python3 -m unittest discover -s td/tests``.
"""

import os
import sys
import threading
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


class _LifecycleMode:
    CONSTANT = "CONSTANT"
    EXPRESSION = "EXPRESSION"
    BIND = "BIND"


_TD.ParMode = _LifecycleMode


class _LifecycleGroup(list):
    def __init__(self, name):
        super().__init__()
        self.name = name

    def __bool__(self):
        raise RuntimeError("ParGroup truthiness must never be read")


class _LifecyclePar:
    def __init__(self, page, name, style, group, label, is_custom=True):
        self.page = page
        self.name = name
        self.style = style
        self.parGroup = group
        self.isCustom = is_custom
        self.label = label
        self.default = 0
        self.min = 0
        self.max = 1
        self.clampMin = False
        self.clampMax = False
        self.normMin = 0
        self.normMax = 1
        self.val = 0
        self.menuNames = []
        self.menuLabels = []
        self._expr = ""
        self.bindExpr = ""
        self.mode = _LifecycleMode.CONSTANT

    @property
    def expr(self):
        return self._expr

    @expr.setter
    def expr(self, value):
        self._expr = value
        self.mode = _LifecycleMode.EXPRESSION

    def eval(self):
        if self.mode == _LifecycleMode.EXPRESSION and self._expr == "1 + 2":
            return 3
        return self.val

    def destroy(self):
        if self in self.parGroup:
            self.parGroup.remove(self)
        if not list(self.parGroup) and self.parGroup in self.page.groups:
            self.page.groups.remove(self.parGroup)


class _LifecyclePage:
    _METHOD_STYLES = {
        "appendFloat": "Float",
        "appendInt": "Int",
        "appendToggle": "Toggle",
        "appendMenu": "Menu",
        "appendStr": "Str",
        "appendPulse": "Pulse",
        "appendHeader": "Header",
        "appendOP": "OP",
        "appendTOP": "TOP",
        "appendFile": "File",
        "appendFolder": "Folder",
        "appendXYZW": "XYZW",
        "appendRGBA": "RGBA",
        "appendRGB": "RGB",
        "appendXYZ": "XYZ",
    }

    def __init__(self, comp, name):
        self.comp = comp
        self.name = name
        self.groups = []

    def __getattr__(self, name):
        style = self._METHOD_STYLES.get(name)
        if style is None:
            raise AttributeError(name)

        def append(root, label=None, size=1, replace=True):
            del replace
            return self._append(style, root, label or root, size)

        return append

    def _append(self, style, root, label, size):
        if self.comp.find_par(root) is not None:
            raise RuntimeError("parameter collision")
        suffixes = {
            "XYZW": ["x", "y", "z", "w"],
            "RGBA": ["r", "g", "b", "a"],
            "RGB": ["r", "g", "b"],
            "XYZ": ["x", "y", "z"],
        }.get(style)
        if suffixes is not None:
            names = [root + suffix for suffix in suffixes]
        elif style in {"Float", "Int"} and size > 1:
            names = [root + str(index + 1) for index in range(size)]
        else:
            names = [root]
        group = _LifecycleGroup(root)
        group.extend(_LifecyclePar(self, item, style, group, label) for item in names)
        self.groups.append(group)
        return group

    def sort(self, *groups):
        if not all(isinstance(group, _LifecycleGroup) for group in groups):
            raise RuntimeError("sort requires ParGroup objects")
        if {id(group) for group in groups} != {id(group) for group in self.groups}:
            raise RuntimeError("sort must preserve every group")
        self.groups = list(groups)

    def destroy(self):
        if self.comp.fail_page_destroy:
            raise RuntimeError("induced rollback failure")
        self.comp.pages.remove(self)
        self.groups.clear()


class _LifecycleNode:
    def __init__(self, path="/project1/comp"):
        self.path = path
        self.pages = []
        self.extra_pars = []
        self.fail_page_destroy = False

    @property
    def customPages(self):
        return self.pages

    @property
    def customPars(self):
        return [par for page in self.pages for group in page.groups for par in group] + self.extra_pars

    def appendCustomPage(self, name):
        page = _LifecyclePage(self, name)
        self.pages.append(page)
        return page

    def find_par(self, name):
        return next((par for par in self.customPars if par.name == name), None)


def _add_payload(params, page="Custom", key=None):
    payload = {"page": page, "params": params}
    if key is not None:
        payload["idempotency_key"] = key
    return payload


class TestCustomParameterLifecycle(unittest.TestCase):
    def setUp(self):
        svc._RECEIPTS.clear()
        self.node = _LifecycleNode()
        self.patch = _TdPatch({self.node.path: self.node})
        self.patch.__enter__()

    def tearDown(self):
        self.patch.__exit__(None, None, None)
        svc._RECEIPTS.clear()

    def apply(self, payload):
        return svc.apply_custom_parameter_lifecycle(self.node.path, payload)

    def test_structured_add_supports_all_proven_and_legacy_styles_without_exec(self):
        previous = os.environ.get("TDMCP_BRIDGE_ALLOW_EXEC")
        os.environ["TDMCP_BRIDGE_ALLOW_EXEC"] = "0"
        try:
            styles = [
                "Float",
                "Int",
                "Toggle",
                "Menu",
                "Str",
                "Pulse",
                "Header",
                "OP",
                "TOP",
                "File",
                "Folder",
                "XYZW",
                "RGBA",
                "RGB",
                "XYZ",
            ]
            params = [
                {
                    "name": "P%s" % index,
                    "type": style,
                    **({"menu_names": ["one", "two"], "menu_labels": ["One", "Two"]} if style == "Menu" else {}),
                }
                for index, style in enumerate(styles)
            ]
            result = self.apply(_add_payload(params))
        finally:
            if previous is None:
                os.environ.pop("TDMCP_BRIDGE_ALLOW_EXEC", None)
            else:
                os.environ["TDMCP_BRIDGE_ALLOW_EXEC"] = previous
        self.assertEqual(result["status"], "applied")
        self.assertEqual([item["style"] for item in result["results"][0]["parameters"]], styles)
        self.assertEqual(len(self.node.customPars), 25)

    def test_legacy_name_page_defaults_ranges_clamp_and_menu_are_preserved(self):
        result = self.apply(
            _add_payload(
                [
                    {"name": "gain amount", "type": "Float", "label": "Gain", "default": 0.5, "min": 0, "max": 2, "clamp": True},
                    {"name": "Mode", "type": "Menu", "default": "b", "menu_names": ["a", "b"], "menu_labels": ["A", "B"]},
                    {"name": "Vector", "type": "Int", "size": 2, "default": [3, 4]},
                    {"name": "Enabled", "type": "Toggle", "default": "false"},
                    {"name": "Tint", "type": "RGB", "default": "#ff0000"},
                    {"name": "Trigger", "type": "Pulse", "default": True},
                ],
                page="controls",
            )
        )
        self.assertEqual(result["status"], "applied")
        self.assertEqual(self.node.pages[0].name, "Controls")
        gain = self.node.find_par("Gainamount")
        self.assertEqual((gain.default, gain.val, gain.normMin, gain.normMax), (0.5, 0.5, 0, 2))
        self.assertTrue(gain.clampMin and gain.clampMax)
        self.assertEqual(self.node.find_par("Mode").menuLabels, ["A", "B"])
        self.assertEqual([self.node.find_par("Vector1").val, self.node.find_par("Vector2").val], [3, 4])
        self.assertIs(self.node.find_par("Enabled").val, False)
        self.assertEqual([self.node.find_par(name).val for name in ("Tintr", "Tintg", "Tintb")], [1.0, 0.0, 0.0])
        self.assertEqual(self.node.find_par("Trigger").val, 0)

    def test_exact_existing_is_unchanged_but_definition_conflict_mutates_nothing(self):
        payload = _add_payload([{"name": "Gain", "type": "Float", "label": "Gain", "default": 1}])
        first = self.apply(payload)
        before = svc._snapshot_state(self.node)
        second = self.apply(payload)
        conflict = self.apply(_add_payload([{"name": "Gain", "type": "Float", "label": "Different", "default": 1}]))
        self.assertEqual(first["status"], "applied")
        self.assertEqual(second["status"], "replayed")
        self.assertEqual(conflict["error"]["code"], "definition_conflict")
        self.assertEqual(svc._snapshot_state(self.node), before)

    def test_edit_fields_expression_and_bind(self):
        self.apply(
            _add_payload(
                [
                    {"name": "Gain", "type": "Float"},
                    {"name": "Mode", "type": "Menu", "menu_names": ["a"]},
                    {"name": "Enabled", "type": "Toggle"},
                ]
            )
        )
        result = self.apply(
            {
                "operations": [
                    {
                        "action": "edit_parameter",
                        "name": "Gain",
                        "fields": {"label": "Master", "default": 1.25, "min": 0, "max": 10, "clamp": True, "value": 2.5, "mode": "EXPRESSION", "expression": "1 + 2"},
                    },
                    {
                        "action": "edit_parameter",
                        "name": "Mode",
                        "fields": {"menu_names": ["safe", "strict"], "menu_labels": ["Safe", "Strict"], "value": "strict"},
                    },
                    {"action": "edit_parameter", "name": "Gain", "fields": {"mode": "BIND", "bind_expression": "me.par.Source"}},
                    {"action": "edit_parameter", "name": "Enabled", "fields": {"default": "false", "value": "false"}},
                ]
            }
        )
        gain = self.node.find_par("Gain")
        self.assertEqual(result["status"], "applied")
        self.assertEqual((gain.label, gain.default, gain.normMax, gain.val), ("Master", 1.25, 10, 2.5))
        self.assertEqual((gain.min, gain.max), (0, 10))
        self.assertEqual((gain.mode, gain.bindExpr), (_LifecycleMode.BIND, "me.par.Source"))
        self.assertEqual(self.node.find_par("Mode").menuNames, ["safe", "strict"])
        self.assertIs(self.node.find_par("Enabled").val, False)
        self.assertNotIn("me.par.Source", str(result))

    def test_mode_resolution_uses_live_parameter_enum_without_td_parmode(self):
        class LiveMode:
            pass

        LiveMode.CONSTANT = LiveMode()
        LiveMode.EXPRESSION = LiveMode()
        par = types.SimpleNamespace(mode=LiveMode.EXPRESSION)

        svc._set_par_mode(types.SimpleNamespace(), par, "CONSTANT")

        self.assertIs(par.mode, LiveMode.CONSTANT)

    def test_delete_sort_rename_and_delete_page_use_groups(self):
        self.apply(
            _add_payload(
                [
                    {"name": "Gain", "type": "Float"},
                    {"name": "Vector", "type": "XYZW"},
                    {"name": "Color", "type": "RGBA"},
                ]
            )
        )
        sorted_result = self.apply({"operations": [{"action": "sort_page", "page": "Custom", "order": ["Vectorx", "Gain", "Colorr"]}]})
        self.assertEqual(sorted_result["status"], "applied")
        self.assertEqual([group.name for group in self.node.pages[0].groups], ["Vector", "Gain", "Color"])
        self.assertEqual(len(self.node.pages[0].groups[0]), 4)
        deleted = self.apply({"operations": [{"action": "delete_parameter", "name": "Vectorx"}]})
        self.assertEqual(deleted["status"], "applied")
        self.assertIsNone(self.node.find_par("Vectorx"))
        renamed = self.apply({"operations": [{"action": "rename_page", "page": "Custom", "new_name": "Controls"}]})
        self.assertEqual(renamed["results"][0]["final_page"], "Controls")
        removed = self.apply({"operations": [{"action": "delete_page", "page": "Controls"}]})
        self.assertEqual(removed["status"], "applied")
        self.assertEqual(self.node.customPages, [])

    def test_sort_rejects_omitted_or_duplicate_groups_without_mutation(self):
        self.apply(_add_payload([{"name": "Gain", "type": "Float"}, {"name": "Vector", "type": "XYZW"}]))
        before = svc._snapshot_state(self.node)
        omitted = self.apply({"operations": [{"action": "sort_page", "page": "Custom", "order": ["Gain"]}]})
        duplicate = self.apply({"operations": [{"action": "sort_page", "page": "Custom", "order": ["Vectorx", "Vectory"]}]})
        self.assertEqual(omitted["error"]["code"], "invalid_definition")
        self.assertEqual(duplicate["error"]["code"], "invalid_definition")
        self.assertEqual(svc._snapshot_state(self.node), before)

    def test_export_is_held_fail_closed_before_mutation(self):
        self.apply(_add_payload([{"name": "Gain", "type": "Float"}]))
        before = svc._snapshot_state(self.node)
        result = self.apply({"operations": [{"action": "edit_parameter", "name": "Gain", "fields": {"mode": "EXPORT"}}]})
        self.assertEqual(result["status"], "held")
        self.assertEqual(result["error"]["code"], "unsupported_parameter_mode")
        self.assertFalse(result["rollback"]["attempted"])
        self.assertEqual(svc._snapshot_state(self.node), before)

    def test_built_in_parameter_is_protected(self):
        page = self.node.appendCustomPage("Custom")
        group = _LifecycleGroup("Builtin")
        builtin = _LifecyclePar(page, "Builtin", "Float", group, "Builtin", is_custom=False)
        group.append(builtin)
        self.node.extra_pars.append(builtin)
        result = self.apply({"operations": [{"action": "delete_parameter", "name": "Builtin"}]})
        self.assertEqual(result["error"]["code"], "built_in_protected")
        self.assertIn(builtin, self.node.extra_pars)

    def test_mid_transaction_failure_restores_exact_snapshot(self):
        self.apply(_add_payload([{"name": "Gain", "type": "Float"}, {"name": "Vector", "type": "XYZW"}]))
        before = svc._snapshot_state(self.node)
        result = self.apply(
            {
                "operations": [
                    {"action": "edit_parameter", "name": "Gain", "fields": {"label": "Mutated", "value": 9}},
                    {"action": "delete_parameter", "name": "Missing"},
                ]
            }
        )
        self.assertEqual(result["status"], "rolled_back")
        self.assertEqual(result["rollback"], {"attempted": True, "succeeded": True})
        self.assertEqual(svc._snapshot_state(self.node), before)

    def test_rollback_failure_is_explicit_partial_failure(self):
        self.apply(_add_payload([{"name": "Gain", "type": "Float"}]))
        self.node.fail_page_destroy = True
        result = self.apply(
            {
                "operations": [
                    {"action": "edit_parameter", "name": "Gain", "fields": {"label": "Mutated"}},
                    {"action": "delete_parameter", "name": "Missing"},
                ]
            }
        )
        self.assertEqual(result["status"], "partial_failure")
        self.assertEqual(result["error"]["code"], "rollback_failed")
        self.assertFalse(result["rollback"]["succeeded"])

    def test_idempotency_replay_conflict_and_value_redaction(self):
        key = "custom_params_retry_1234"
        payload = _add_payload([{"name": "Secret", "type": "Str", "default": "top-secret-value"}], key=key)
        first = self.apply(payload)
        replay = self.apply(payload)
        conflict = self.apply(_add_payload([{"name": "Other", "type": "Float"}], key=key))
        self.assertEqual(first["status"], "applied")
        self.assertEqual(replay["status"], "replayed")
        self.assertEqual(conflict["error"]["code"], "idempotency_conflict")
        self.assertNotIn("top-secret-value", str(first))
        self.assertEqual(len(self.node.customPages), 1)

    def test_fingerprint_deduplicates_concurrent_retries(self):
        payload = _add_payload([{"name": "Gain", "type": "Float", "default": 1}])
        results = []

        def apply_once():
            results.append(self.apply(payload))

        threads = [threading.Thread(target=apply_once), threading.Thread(target=apply_once)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(sorted(result["status"] for result in results), ["applied", "replayed"])
        self.assertEqual(len(self.node.customPars), 1)

    def test_receipt_ttl_and_capacity_are_bounded(self):
        svc._RECEIPTS["expired"] = {"created_at": 0}
        svc._prune_receipts(svc.RECEIPT_TTL_SECONDS + 1)
        self.assertNotIn("expired", svc._RECEIPTS)
        for index in range(svc.MAX_RECEIPTS + 2):
            svc._RECEIPTS[str(index)] = {"created_at": float(index + 1000)}
        svc._prune_receipts(1000)
        self.assertEqual(len(svc._RECEIPTS), svc.MAX_RECEIPTS)
        self.assertNotIn("0", svc._RECEIPTS)

    def test_invalid_bounds_duplicates_and_missing_operator_are_typed(self):
        bad_menu = self.apply(_add_payload([{"name": "Mode", "type": "Menu", "menu_names": []}]))
        duplicate = self.apply(_add_payload([{"name": "gain", "type": "Float"}, {"name": "Gain", "type": "Float"}]))
        self.assertEqual(bad_menu["error"]["code"], "invalid_definition")
        self.assertEqual(duplicate["error"]["code"], "duplicate_definition")
        too_many = self.apply(_add_payload([{"name": "P%s" % index, "type": "Float"} for index in range(65)]))
        bad_key = self.apply(_add_payload([{"name": "A", "type": "Float"}], key="short"))
        unknown = self.apply({"operations": [{"action": "delete_page", "page": "Custom", "unsafe": True}]})
        self.assertEqual(too_many["error"]["code"], "invalid_definition")
        self.assertEqual(bad_key["error"]["code"], "invalid_definition")
        self.assertEqual(unknown["error"]["code"], "invalid_definition")
        with _TdPatch({}):
            missing = svc.apply_custom_parameter_lifecycle("/missing", _add_payload([{"name": "A", "type": "Float"}]))
        self.assertEqual(missing["error"]["code"], "operator_not_found")


if __name__ == "__main__":
    unittest.main()
