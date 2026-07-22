"""Offline tests for TouchDesigner Palette package installer helpers.

The actual .tox save path is live-TD only. These tests cover the reusable
Python/string/path behavior and a tiny fake operator graph for build_package().
"""

import io
import os
import sys
import tempfile
import types
import unittest
import zipfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_MODULES = os.path.abspath(os.path.join(_HERE, "..", "modules"))
if _MODULES not in sys.path:
    sys.path.insert(0, _MODULES)

_td_stub = types.ModuleType("td")
sys.modules.setdefault("td", _td_stub)
_TD = sys.modules["td"]

from mcp import install  # noqa: E402


class _FakeResponse:
    def __init__(self, data):
        self._data = data

    def read(self):
        return self._data


class _FakePar:
    def __init__(self, value=None):
        self.val = value

    def eval(self):
        return self.val


class _FakeParGroup:
    def __init__(self):
        self._pars = {}

    def add(self, name, value=None):
        par = self._pars.setdefault(name, _FakePar())
        par.val = value
        return par

    def __getattr__(self, name):
        if name not in self._pars:
            self._pars[name] = _FakePar()
        return self._pars[name]


class _TouchDesignerLikeCreatedParGroup:
    """Models Page.append*() returning a ParGroup with forbidden truthiness."""

    def __init__(self, par):
        self._par = par

    def __bool__(self):
        raise RuntimeError("bool(ParGroup) is not supported")

    def __getitem__(self, index):
        if index != 0:
            raise IndexError(index)
        return self._par


class _FakePage:
    def __init__(self, owner, name):
        self.owner = owner
        self.name = name
        self.appended = []

    def _append(self, kind, name, default=None, label=None):
        self.appended.append((kind, name, label))
        return [self.owner.par.add(name, default)]

    def appendPulse(self, name, label=None):
        return self._append("Pulse", name, None, label)

    def appendInt(self, name, label=None):
        return self._append("Int", name, 0, label)

    def appendStr(self, name, label=None):
        return self._append("Str", name, "", label)

    def appendToggle(self, name, label=None):
        return self._append("Toggle", name, False, label)

    def appendMenu(self, name, label=None):
        return self._append("Menu", name, "Keep", label)


class _FakeOp:
    def __init__(self, path, op_type="baseCOMP"):
        self.path = path
        self.name = path.rsplit("/", 1)[-1] or "/"
        self.op_type = op_type
        self.children = {}
        self.par = _FakeParGroup()
        self.custom_pages = {}
        self.saved_path = None
        self.destroyed = False
        self.nodeX = 0
        self.nodeY = 0

    def op(self, name):
        return self.children.get(name)

    def create(self, op_type, name):
        child_path = self.path.rstrip("/") + "/" + name
        child = _FakeOp(child_path, op_type=op_type)
        self.children[name] = child
        return child

    def appendCustomPage(self, name):
        page = _FakePage(self, name)
        self.custom_pages[name] = page
        return page

    def save(self, path):
        self.saved_path = path

    def destroy(self):
        self.destroyed = True


class _FakeTd:
    baseCOMP = "baseCOMP"
    textDAT = "textDAT"
    parameterexecuteDAT = "parameterexecuteDAT"
    webserverDAT = "webserverDAT"
    executeDAT = "executeDAT"
    errorDAT = "errorDAT"

    def run(self, _script, callback, delayFrames=1):
        callback()

    def __init__(self):
        self.root = _FakeOp("/", "root")
        self.project1 = _FakeOp("/project1")
        self.root.children["project1"] = self.project1

    def op(self, path):
        if path == "/":
            return self.root
        if path == "/project1":
            return self.project1
        return None


class _TdPatch:
    def __init__(self, fake_td):
        self.fake_td = fake_td

    def __enter__(self):
        self._saved = {}
        for name in (
            "op",
            "baseCOMP",
            "textDAT",
            "parameterexecuteDAT",
            "webserverDAT",
            "executeDAT",
            "errorDAT",
            "run",
        ):
            self._saved[name] = getattr(_TD, name, None)
            setattr(_TD, name, getattr(self.fake_td, name))
        return self.fake_td

    def __exit__(self, *exc):
        for name in (
            "op",
            "baseCOMP",
            "textDAT",
            "parameterexecuteDAT",
            "webserverDAT",
            "executeDAT",
            "errorDAT",
            "run",
        ):
            if self._saved[name] is None and hasattr(_TD, name):
                delattr(_TD, name)
            elif self._saved[name] is not None:
                setattr(_TD, name, self._saved[name])


class InstallPackageHelperTests(unittest.TestCase):
    def test_first_created_par_does_not_coerce_touchdesigner_par_group_to_bool(self):
        par = _FakePar("Keep")
        created = _TouchDesignerLikeCreatedParGroup(par)

        self.assertIs(install._first_created_par(created), par)

    def test_interaction_callbacks_clear_sensitive_copy_after_terminal_state(self):
        source = install._interaction_callbacks_source()
        self.assertIn("def _clear():", source)
        self.assertIn("_set('Interactiontitle', '')", source)
        self.assertIn("_set('Interactionprompt', '')", source)
        self.assertIn("menuNames = ['Keep']", source)
        self.assertIn("interaction_service.cancel_interaction", source)

    def test_event_hooks_source_caches_heartbeat_service_after_first_import(self):
        source = install._event_hooks_source()

        self.assertIn("_api_service = None", source)
        self.assertIn("global _api_service", source)
        self.assertEqual(source.count("from mcp.services import api_service"), 1)
        self.assertIn("_api_service = api_service", source)
        self.assertIn("_api_service.mark_heartbeat()", source)
        self.assertIn("        _mark_heartbeat()", source)

    def test_webserver_stop_fails_pending_interactions_closed(self):
        source = install._callbacks_source()
        self.assertIn("def onServerStop(webServerDAT):", source)
        self.assertIn("interaction_service.disconnect_interactions()", source)
        self.assertIn("tox_export_service.cancel_all('disconnect')", source)
        self.assertIn("tox_roundtrip_service.cancel_all('disconnect')", source)

    def test_interaction_inbox_prefers_ui_perform_mode_when_project_flag_is_absent(
        self,
    ):
        comp = _FakeOp("/project1/tdmcp_bridge")
        for name in (
            "Interactionchoice",
            "Interactionid",
            "Interactionstatus",
            "Interactiontitle",
            "Interactionprompt",
        ):
            comp.par.add(name)
        td_like = types.SimpleNamespace(
            ui=types.SimpleNamespace(performMode=False),
            project=types.SimpleNamespace(),
        )

        shown = install._present_interaction(
            td_like,
            comp,
            {
                "request_id": "opaque-id",
                "choices": ["Delete", "Bypass", "Keep"],
                "default_choice": "Keep",
                "title": "Delete node?",
                "prompt": "/project1/noise1",
            },
        )

        self.assertTrue(shown)
        self.assertEqual(comp.par.Interactionstatus.val, "pending")
        self.assertEqual(comp.par.Interactionchoice.val, "Keep")

    def test_interaction_inbox_is_fail_closed_in_ui_perform_mode(self):
        comp = _FakeOp("/project1/tdmcp_bridge")
        td_like = types.SimpleNamespace(
            ui=types.SimpleNamespace(performMode=True),
            project=types.SimpleNamespace(performMode=False),
        )

        self.assertFalse(
            install._present_interaction(
                td_like,
                comp,
                {
                    "request_id": "opaque-id",
                    "choices": ["Delete", "Bypass", "Keep"],
                    "default_choice": "Keep",
                    "title": "Delete node?",
                    "prompt": "/project1/noise1",
                },
            )
        )

    def test_palette_package_path_defaults_to_derivative_palette_folder(self):
        path = install.palette_package_path(home="/Users/artist")
        self.assertEqual(
            path,
            "/Users/artist/Documents/Derivative/Palette/tdmcp/tdmcp_bridge_package.tox",
        )

    def test_palette_package_path_accepts_custom_palette_folder_and_adds_tox_suffix(
        self,
    ):
        path = install.palette_package_path(
            "show_bridge",
            palette_dir="/tmp/Palette/tdmcp",
        )
        self.assertEqual(path, "/tmp/Palette/tdmcp/show_bridge.tox")

    def test_palette_package_path_rejects_non_tox_extension(self):
        with self.assertRaisesRegex(ValueError, r"\.tox"):
            install.palette_package_path("bridge.txt", palette_dir="/tmp/Palette")

    def test_package_callbacks_source_wires_controls_to_existing_install_functions(
        self,
    ):
        source = install.package_callbacks_source(modules_dir="/opt/td/modules")
        self.assertIn("sys.path.insert(0, '/opt/td/modules')", source)
        self.assertIn("install.run(", source)
        self.assertIn("install.uninstall(", source)
        self.assertIn("fetch_modules", source)
        self.assertIn("Repozip", source)
        self.assertIn(install.DEFAULT_PACKAGE_BOOTSTRAP_REPO_ZIP, source)
        self.assertIn("TDMCP_BRIDGE_TOKEN", source)
        self.assertIn("TDMCP_BRIDGE_ALLOW_EXEC", source)
        for control in ("Install", "Reinstall", "Uninstall", "Status"):
            self.assertIn(control, source)

    def test_default_package_bootstrap_zip_is_release_tag_pinned(self):
        self.assertRegex(
            install.DEFAULT_PACKAGE_BOOTSTRAP_REPO_ZIP,
            r"^https://github\.com/Pantani/tdmcp/archive/refs/tags/v\d+\.\d+\.\d+\.zip$",
        )
        self.assertNotIn("/refs/heads/", install.DEFAULT_PACKAGE_BOOTSTRAP_REPO_ZIP)

    def test_package_callbacks_source_bootstraps_modules_when_modulesdir_is_blank(self):
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as zf:
            zf.writestr("tdmcp-v1/td/modules/mcp/__init__.py", "")
            zf.writestr(
                "tdmcp-v1/td/modules/utils/version.py", "BRIDGE_VERSION = 'test'\n"
            )
            zf.writestr("tdmcp-v1/README.md", "ignored")

        with tempfile.TemporaryDirectory() as dest:
            namespace = {}
            exec(
                install.package_callbacks_source(
                    repo_zip="https://example.invalid/tdmcp.zip",
                    bootstrap_dest=dest,
                ),
                namespace,
            )
            calls = []

            def fake_urlopen(url, timeout=30):
                calls.append((url, timeout))
                return _FakeResponse(archive.getvalue())

            previous_urlopen = namespace["urllib"].request.urlopen
            previous_path = list(sys.path)
            namespace["urllib"].request.urlopen = fake_urlopen
            owner = _FakeOp("/package")
            owner.par.add("Modulesdir", "")
            owner.par.add("Repozip", "https://example.invalid/tdmcp.zip")
            owner.par.add("Bootstrapdest", dest)

            try:
                opts = namespace["_settings"](owner)
                modules_dir = namespace["_ensure_modules"](opts)

                self.assertEqual(modules_dir, os.path.join(dest, "modules"))
                self.assertEqual(opts["modules_dir"], modules_dir)
                self.assertIn((owner.par.Repozip.val, 30), calls)
                self.assertIn(modules_dir, sys.path)
                self.assertTrue(
                    os.path.exists(os.path.join(modules_dir, "mcp", "__init__.py"))
                )
                self.assertTrue(
                    os.path.exists(os.path.join(modules_dir, "utils", "version.py"))
                )
                self.assertFalse(
                    os.path.exists(os.path.join(dest, "modules", "README.md"))
                )
            finally:
                namespace["urllib"].request.urlopen = previous_urlopen
                sys.path[:] = previous_path

    def test_package_callbacks_source_uninstalls_without_bootstrap_network(self):
        namespace = {}
        exec(install.package_callbacks_source(), namespace)
        fake_td = _FakeTd()
        bridge = fake_td.project1.create("baseCOMP", "tdmcp_bridge")
        owner = _FakeOp("/package")
        owner.par.add("Modulesdir", "")
        owner.par.add("Repozip", "https://example.invalid/missing.zip")
        owner.par.add("Bootstrapdest", "/tmp/tdmcp-bridge")
        owner.par.add("Parentpath", "/project1")
        owner.par.add("Container", "tdmcp_bridge")
        calls = []

        def fake_urlopen(url, timeout=30):
            calls.append((url, timeout))
            raise AssertionError("uninstall should not fetch modules")

        previous_urlopen = namespace["urllib"].request.urlopen
        namespace["urllib"].request.urlopen = fake_urlopen
        try:
            with _TdPatch(fake_td):
                namespace["uninstall_bridge"](types.SimpleNamespace(owner=owner))

            self.assertTrue(bridge.destroyed)
            self.assertEqual(calls, [])
            self.assertEqual(owner.par.Laststatus.val, "removed /project1/tdmcp_bridge")
        finally:
            namespace["urllib"].request.urlopen = previous_urlopen

    def test_package_callbacks_source_configures_token_and_explicit_exec_gate(self):
        namespace = {}
        exec(install.package_callbacks_source(), namespace)
        owner = _FakeOp("/package")
        owner.par.add("Token", "s3cret")
        owner.par.add("Allowexec", False)
        previous_token = os.environ.get("TDMCP_BRIDGE_TOKEN")
        previous_allow_exec = os.environ.get("TDMCP_BRIDGE_ALLOW_EXEC")

        try:
            os.environ.pop("TDMCP_BRIDGE_TOKEN", None)
            os.environ["TDMCP_BRIDGE_ALLOW_EXEC"] = "0"
            namespace["_configure_security"](owner)
            self.assertEqual(os.environ.get("TDMCP_BRIDGE_TOKEN"), "s3cret")
            self.assertEqual(os.environ.get("TDMCP_BRIDGE_ALLOW_EXEC"), "0")

            owner.par.Token.val = " "
            namespace["_configure_security"](owner)
            self.assertIsNone(os.environ.get("TDMCP_BRIDGE_TOKEN"))
            self.assertEqual(os.environ.get("TDMCP_BRIDGE_ALLOW_EXEC"), "0")
        finally:
            if previous_token is None:
                os.environ.pop("TDMCP_BRIDGE_TOKEN", None)
            else:
                os.environ["TDMCP_BRIDGE_TOKEN"] = previous_token
            if previous_allow_exec is None:
                os.environ.pop("TDMCP_BRIDGE_ALLOW_EXEC", None)
            else:
                os.environ["TDMCP_BRIDGE_ALLOW_EXEC"] = previous_allow_exec

    def test_build_package_creates_controls_and_callback_dat_without_installing_bridge(
        self,
    ):
        fake_td = _FakeTd()
        with _TdPatch(fake_td):
            comp = install.build_package(
                port=7700,
                parent_path="/project1",
                container="show_bridge",
                modules_dir="/opt/td/modules",
            )

        self.assertEqual(comp.path, "/project1/tdmcp_bridge_package")
        self.assertIn("package_callbacks", comp.children)
        self.assertIn("package_readme", comp.children)
        self.assertEqual(comp.children["package_callbacks"].nodeX, -180)
        self.assertEqual(comp.children["package_callbacks"].nodeY, 0)
        self.assertEqual(comp.children["package_readme"].nodeX, 180)
        self.assertEqual(comp.children["package_readme"].nodeY, 0)
        self.assertIn("Bridge", comp.custom_pages)
        appended = comp.custom_pages["Bridge"].appended
        self.assertIn(("Pulse", "Install", "Install"), appended)
        self.assertIn(("Pulse", "Reinstall", "Reinstall"), appended)
        self.assertIn(("Pulse", "Uninstall", "Uninstall"), appended)
        self.assertIn(("Pulse", "Status", "Status"), appended)
        self.assertIn(("Str", "Repozip", "Repo Zip"), appended)
        self.assertIn(("Str", "Bootstrapdest", "Bootstrap Dest"), appended)
        self.assertEqual(comp.par.Bridgeport.val, 7700)
        self.assertEqual(comp.par.Parentpath.val, "/project1")
        self.assertEqual(comp.par.Container.val, "show_bridge")
        self.assertEqual(comp.par.Modulesdir.val, "/opt/td/modules")
        self.assertEqual(
            comp.par.Repozip.val, install.DEFAULT_PACKAGE_BOOTSTRAP_REPO_ZIP
        )
        self.assertEqual(
            comp.par.Bootstrapdest.val, install.DEFAULT_PACKAGE_BOOTSTRAP_DEST
        )
        self.assertEqual(comp.par.Allowexec.val, False)

    def test_run_lays_out_runtime_bridge_nodes_without_overlap(self):
        fake_td = _FakeTd()
        with _TdPatch(fake_td):
            comp = install.run(
                port=7700,
                parent_path="/project1",
                container="show_bridge",
                modules_dir="/opt/td/modules",
            )

        expected = {
            "callbacks": (-320, 120),
            "interaction_callbacks": (-320, -80),
            "webserver": (0, 120),
            "events_hook": (0, -80),
            "error_log": (320, 120),
        }
        self.assertEqual(comp.nodeX, -300)
        self.assertEqual(comp.nodeY, 0)
        self.assertEqual(set(expected), set(comp.children))
        coords = []
        for name, coord in expected.items():
            child = comp.children[name]
            self.assertEqual((child.nodeX, child.nodeY), coord)
            coords.append(coord)
        self.assertEqual(len(coords), len(set(coords)))
        self.assertIn("Interactions", comp.custom_pages)
        self.assertEqual(comp.par.Interactionchoice.val, "Keep")
        self.assertIn("Interactionresolve", comp.children["interaction_callbacks"].text)

    def test_export_package_rejects_non_tox_path_before_touchdesigner_save(self):
        with self.assertRaisesRegex(ValueError, r"\.tox"):
            install.export_package("/tmp/tdmcp_bridge_package.txt")

    def test_export_palette_package_uses_package_name_for_comp_and_tox(self):
        fake_td = _FakeTd()
        with _TdPatch(fake_td):
            comp = install.export_palette_package(
                modules_dir="/opt/td/modules",
                package_name="show_bridge",
                palette_dir="/tmp/Palette/tdmcp",
                port=7700,
                repo_zip="https://example.invalid/v1.zip",
                bootstrap_dest="/tmp/tdmcp-bootstrap",
            )

        self.assertEqual(comp.path, "/project1/show_bridge")
        self.assertEqual(comp.saved_path, "/tmp/Palette/tdmcp/show_bridge.tox")
        self.assertEqual(comp.par.Bridgeport.val, 7700)
        self.assertEqual(comp.par.Repozip.val, "https://example.invalid/v1.zip")
        self.assertEqual(comp.par.Bootstrapdest.val, "/tmp/tdmcp-bootstrap")

    def test_export_palette_package_rejects_unsafe_package_name(self):
        with self.assertRaisesRegex(ValueError, "single filename segment"):
            install.export_palette_package(package_name="../show_bridge")


if __name__ == "__main__":
    unittest.main()
