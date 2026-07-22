"""Offline tests for structured project save and overwrite consent."""

import os
import sys
import types
import unittest
from unittest import mock

_HERE = os.path.dirname(os.path.abspath(__file__))
_MODULES = os.path.abspath(os.path.join(_HERE, "..", "modules"))
if _MODULES not in sys.path:
    sys.path.insert(0, _MODULES)

_td_stub = types.ModuleType("td")
sys.modules.setdefault("td", _td_stub)
_TD = sys.modules["td"]

from mcp.services import project_service as ps  # noqa: E402


class _Project:
    def __init__(self, name="scene.toe", folder="/show", fail=False):
        self.name = name
        self.folder = folder
        self.saveVersion = "2025.30000"
        self.saveBuild = 30000
        self.fail = fail
        self.calls = []

    def save(self, *args):
        self.calls.append(args)
        if self.fail:
            raise RuntimeError("disk unavailable")
        if args:
            path = args[0]
            self.folder, self.name = os.path.dirname(path), os.path.basename(path)


class _App:
    build = 32820
    version = "2025.32820"


class _TdPatch:
    def __init__(self, project):
        self.project = project

    def __enter__(self):
        self.saved = {name: getattr(_TD, name, None) for name in ("project", "app")}
        _TD.project = self.project
        _TD.app = _App()

    def __exit__(self, *args):
        for name in ("project", "app"):
            if hasattr(_TD, name):
                delattr(_TD, name)
        for name, value in self.saved.items():
            if value is not None:
                setattr(_TD, name, value)


class ProjectServiceTest(unittest.TestCase):
    def test_save_current_project_and_verify_readback(self):
        project = _Project()
        with _TdPatch(project), mock.patch.object(ps.os.path, "isfile", return_value=True):
            report = ps.save_project()
        self.assertEqual(project.calls, [()])
        self.assertEqual(report["decision"], "save")
        self.assertEqual(report["final_path"], "/show/scene.toe")
        self.assertTrue(report["verified_exists"])
        self.assertEqual(report["project"]["td_build"], 32820)

    def test_untitled_requires_explicit_save_as(self):
        project = _Project(name="Untitled", folder="/show")
        with _TdPatch(project):
            with self.assertRaisesRegex(ValueError, "explicit Save As"):
                ps.save_project()
        self.assertEqual(project.calls, [])

    def test_unsaved_toe_named_placeholder_never_opens_native_save_dialog(self):
        project = _Project(name="NewProject.1.toe", folder="/show")
        with _TdPatch(project), mock.patch.object(ps.os.path, "isfile", return_value=True):
            with self.assertRaisesRegex(ValueError, "explicit Save As"):
                ps.save_project()
        self.assertEqual(project.calls, [])

    def test_new_save_as_path_does_not_require_approval(self):
        project = _Project()
        with _TdPatch(project), mock.patch.object(ps.os.path, "isfile", return_value=False):
            # The post-save check sees the same mock; make it true only after save.
            with mock.patch.object(
                ps.os.path,
                "isfile",
                side_effect=lambda _path: bool(project.calls),
            ):
                report = ps.save_project("/show/versions/scene_v2.toe")
        self.assertEqual(project.calls, [("/show/versions/scene_v2.toe",)])
        self.assertEqual(report["decision"], "save_as")
        self.assertEqual(report["final_path"], "/show/versions/scene_v2.toe")

    def test_existing_target_fails_closed_without_matching_claim(self):
        project = _Project()
        with _TdPatch(project), mock.patch.object(ps.os.path, "isfile", return_value=True):
            with self.assertRaises(PermissionError):
                ps.save_project("/show/existing.toe")
            with self.assertRaises(PermissionError):
                ps.save_project(
                    "/show/existing.toe",
                    {
                        "kind": "save_overwrite",
                        "state": "resolved",
                        "choice": "Overwrite",
                        "target_path": "/show/other.toe",
                    },
                )
        self.assertEqual(project.calls, [])

    def test_matching_overwrite_claim_saves_and_reports_overwrite(self):
        project = _Project()
        target = "/show/existing.toe"
        approval = {
            "kind": "save_overwrite",
            "state": "resolved",
            "choice": "Overwrite",
            "target_path": target,
        }
        with _TdPatch(project), mock.patch.object(ps.os.path, "isfile", return_value=True):
            report = ps.save_project(target, approval)
        self.assertEqual(project.calls, [(target,)])
        self.assertEqual(report["decision"], "overwrite")

    def test_save_does_not_succeed_without_file_readback(self):
        project = _Project()
        with _TdPatch(project), mock.patch.object(
            ps.os.path,
            "isfile",
            side_effect=[True, False, False],
        ):
            with self.assertRaisesRegex(OSError, "not present"):
                ps.save_project()

    def test_rejects_relative_non_toe_and_control_character_paths(self):
        project = _Project()
        with _TdPatch(project):
            for value in ("scene.toe", "/show/scene.txt", "/show/bad\nname.toe"):
                with self.subTest(value=value), self.assertRaises(ValueError):
                    ps.save_project(value)


if __name__ == "__main__":
    unittest.main()
