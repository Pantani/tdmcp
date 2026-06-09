"""Offline tests for TouchDesigner Palette package installer helpers.

The actual .tox save path is live-TD only. These tests cover the reusable
Python/string/path behavior and a tiny fake operator graph for build_package().
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
sys.modules.setdefault("td", _td_stub)
_TD = sys.modules["td"]

from mcp import install  # noqa: E402


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


class _FakeOp:
    def __init__(self, path, op_type="baseCOMP"):
        self.path = path
        self.name = path.rsplit("/", 1)[-1] or "/"
        self.op_type = op_type
        self.children = {}
        self.par = _FakeParGroup()
        self.custom_pages = {}
        self.saved_path = None
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


class _FakeTd:
    baseCOMP = "baseCOMP"
    textDAT = "textDAT"
    parameterexecuteDAT = "parameterexecuteDAT"

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
        for name in ("op", "baseCOMP", "textDAT", "parameterexecuteDAT"):
            self._saved[name] = getattr(_TD, name, None)
            setattr(_TD, name, getattr(self.fake_td, name))
        return self.fake_td

    def __exit__(self, *exc):
        for name in ("op", "baseCOMP", "textDAT", "parameterexecuteDAT"):
            if self._saved[name] is None and hasattr(_TD, name):
                delattr(_TD, name)
            elif self._saved[name] is not None:
                setattr(_TD, name, self._saved[name])


class InstallPackageHelperTests(unittest.TestCase):
    def test_palette_package_path_defaults_to_derivative_palette_folder(self):
        path = install.palette_package_path(home="/Users/artist")
        self.assertEqual(
            path,
            "/Users/artist/Documents/Derivative/Palette/tdmcp/tdmcp_bridge_package.tox",
        )

    def test_palette_package_path_accepts_custom_palette_folder_and_adds_tox_suffix(self):
        path = install.palette_package_path(
            "show_bridge",
            palette_dir="/tmp/Palette/tdmcp",
        )
        self.assertEqual(path, "/tmp/Palette/tdmcp/show_bridge.tox")

    def test_palette_package_path_rejects_non_tox_extension(self):
        with self.assertRaisesRegex(ValueError, r"\.tox"):
            install.palette_package_path("bridge.txt", palette_dir="/tmp/Palette")

    def test_package_callbacks_source_wires_controls_to_existing_install_functions(self):
        source = install.package_callbacks_source(modules_dir="/opt/td/modules")
        self.assertIn("sys.path.insert(0, '/opt/td/modules')", source)
        self.assertIn("install.run(", source)
        self.assertIn("install.uninstall(", source)
        self.assertIn("TDMCP_BRIDGE_TOKEN", source)
        self.assertIn("TDMCP_BRIDGE_ALLOW_EXEC", source)
        for control in ("Install", "Reinstall", "Uninstall", "Status"):
            self.assertIn(control, source)

    def test_package_callbacks_source_clears_stale_token_when_token_is_blank(self):
        namespace = {}
        exec(install.package_callbacks_source(), namespace)
        owner = _FakeOp("/package")
        owner.par.add("Token", "s3cret")
        owner.par.add("Allowexec", True)
        previous_token = os.environ.get("TDMCP_BRIDGE_TOKEN")
        previous_allow_exec = os.environ.get("TDMCP_BRIDGE_ALLOW_EXEC")

        try:
            os.environ.pop("TDMCP_BRIDGE_TOKEN", None)
            namespace["_configure_security"](owner)
            self.assertEqual(os.environ.get("TDMCP_BRIDGE_TOKEN"), "s3cret")

            owner.par.Token.val = " "
            namespace["_configure_security"](owner)
            self.assertIsNone(os.environ.get("TDMCP_BRIDGE_TOKEN"))
            self.assertEqual(os.environ.get("TDMCP_BRIDGE_ALLOW_EXEC"), "1")
        finally:
            if previous_token is None:
                os.environ.pop("TDMCP_BRIDGE_TOKEN", None)
            else:
                os.environ["TDMCP_BRIDGE_TOKEN"] = previous_token
            if previous_allow_exec is None:
                os.environ.pop("TDMCP_BRIDGE_ALLOW_EXEC", None)
            else:
                os.environ["TDMCP_BRIDGE_ALLOW_EXEC"] = previous_allow_exec

    def test_build_package_creates_controls_and_callback_dat_without_installing_bridge(self):
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
        self.assertIn("Bridge", comp.custom_pages)
        appended = comp.custom_pages["Bridge"].appended
        self.assertIn(("Pulse", "Install", "Install"), appended)
        self.assertIn(("Pulse", "Reinstall", "Reinstall"), appended)
        self.assertIn(("Pulse", "Uninstall", "Uninstall"), appended)
        self.assertIn(("Pulse", "Status", "Status"), appended)
        self.assertEqual(comp.par.Bridgeport.val, 7700)
        self.assertEqual(comp.par.Parentpath.val, "/project1")
        self.assertEqual(comp.par.Container.val, "show_bridge")
        self.assertEqual(comp.par.Modulesdir.val, "/opt/td/modules")
        self.assertEqual(comp.par.Allowexec.val, True)

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
            )

        self.assertEqual(comp.path, "/project1/show_bridge")
        self.assertEqual(comp.saved_path, "/tmp/Palette/tdmcp/show_bridge.tox")
        self.assertEqual(comp.par.Bridgeport.val, 7700)

    def test_export_palette_package_rejects_unsafe_package_name(self):
        with self.assertRaisesRegex(ValueError, "single filename segment"):
            install.export_palette_package(package_name="../show_bridge")


if __name__ == "__main__":
    unittest.main()
