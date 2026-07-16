"""Focused offline tests for the bounded transactional TOX exporter."""

import os
import sys
import tempfile
import types
import unittest
from unittest import mock

_HERE = os.path.dirname(os.path.abspath(__file__))
_MODULES = os.path.abspath(os.path.join(_HERE, "..", "modules"))
if _MODULES not in sys.path:
    sys.path.insert(0, _MODULES)

from mcp.services import tox_export_service as service  # noqa: E402


class _Mode:
    def __init__(self, name="CONSTANT"):
        self.name = name


class _Par:
    def __init__(self, value, mode="CONSTANT"):
        self.val = value
        self.mode = _Mode(mode)

    def eval(self):
        return self.val


class _RestoreFailPar:
    def __init__(self, value):
        self._value = value
        self._original = value
        self._sanitized = False
        self.mode = _Mode("CONSTANT")

    @property
    def val(self):
        return self._value

    @val.setter
    def val(self, value):
        if self._sanitized and value == self._original:
            raise RuntimeError("induced restore failure")
        self._value = value
        if value == "":
            self._sanitized = True


class _Pars:
    pass


class _Cell:
    def __init__(self, value):
        self.val = value


class _Dat:
    family = "DAT"
    isCOMP = False

    def __init__(self, path, content, table=False, mode="CONSTANT"):
        self.path = path
        self.name = path.rsplit("/", 1)[-1]
        self.id = abs(hash(path))
        self.isTable = table
        self.par = _Pars()
        self.par.file = _Par("/machine/local/source.dat", mode)
        self.par.syncfile = _Par(True, mode)
        self.storage = {"private": "not returned"}
        if table:
            self.rows = [list(row) for row in content]
        else:
            self.text = content

    @property
    def numRows(self):
        return len(self.rows)

    @property
    def numCols(self):
        return max((len(row) for row in self.rows), default=0)

    def __getitem__(self, key):
        row, col = key
        return _Cell(self.rows[row][col])

    def clear(self):
        self.rows = []

    def appendRow(self, row):
        self.rows.append(list(row))


class _Comp:
    family = "COMP"
    isCOMP = True
    type = "baseCOMP"

    def __init__(self, path, children=None, save_error=None):
        self.path = path
        self.name = path.rsplit("/", 1)[-1]
        self.id = abs(hash(path))
        self.children = list(children or [])
        self.save_error = save_error
        self.saved_states = []
        self.par = _Pars()
        self.par.externaltox = _Par("/machine/local/component.tox")

    def findChildren(self, **_kwargs):
        return list(self.children)

    def save(self, path, createFolders=False):
        self.saved_states.append(
            {
                "externaltox": self.par.externaltox.val,
                "children": [
                    {
                        "path": child.path,
                        "file": getattr(getattr(child, "par", None), "file", _Par(None)).val,
                        "syncfile": getattr(
                            getattr(child, "par", None), "syncfile", _Par(None)
                        ).val,
                        "externaltox": getattr(
                            getattr(child, "par", None), "externaltox", _Par(None)
                        ).val,
                    }
                    for child in self.children
                ],
            }
        )
        if self.save_error is not None:
            raise self.save_error
        if createFolders:
            os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as handle:
            handle.write(b"TOX-OFFLINE-FIXTURE")
        return path


class _Scheduler:
    def __init__(self):
        self.callbacks = []

    def __call__(self, callback):
        self.callbacks.append(callback)

    def run_next(self):
        callback = self.callbacks.pop(0)
        callback()


class _Clock:
    def __init__(self):
        self.value = 100.0

    def __call__(self):
        return self.value


class ToxExportServiceTest(unittest.TestCase):
    def setUp(self):
        self.clock = _Clock()
        self.ids = iter(("operation_id_000000000001", "operation_id_000000000002"))
        service._reset_for_tests(clock=self.clock, id_factory=lambda: next(self.ids))
        self.scheduler = _Scheduler()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.text = _Dat("/project1/widget/code", "print('hello')")
        self.table = _Dat("/project1/widget/table", [["a", "1"], ["b", "2"]], table=True)
        self.nested = _Comp("/project1/widget/nested")
        self.source = _Comp(
            "/project1/widget",
            children=[self.text, self.table, self.nested],
        )
        self.td = types.ModuleType("td")
        self.td.app = types.SimpleNamespace(build=32820, version="2025.32820")
        self.td.op = lambda path: self.source if path == self.source.path else None
        self.old_td = sys.modules.get("td")
        sys.modules["td"] = self.td
        self.addCleanup(self._restore_td)

    def _restore_td(self):
        if self.old_td is None:
            sys.modules.pop("td", None)
        else:
            sys.modules["td"] = self.old_td

    def target(self, name="widget.tox"):
        return os.path.join(self.temp.name, name)

    @staticmethod
    def read_bytes(path):
        with open(path, "rb") as handle:
            return handle.read()

    def start(self, target=None, **kwargs):
        return service.start_export(
            self.source.path,
            target or self.target(),
            idempotency_key=kwargs.pop("idempotency_key", "idempotency_key_0001"),
            scheduler=self.scheduler,
            **kwargs,
        )

    def finish(self):
        self.scheduler.run_next()
        self.scheduler.run_next()

    def approval(self, target):
        request = service.build_overwrite_request(self.source.path, target)
        return {
            "kind": "artifact_overwrite",
            "state": "resolved",
            "choice": "Overwrite",
            "target_path": request["normalized_target"],
            "target_fingerprint": request["target_fingerprint"],
            "request_id": "interaction_00000001",
        }

    def test_validates_paths_source_and_symlink_without_scheduling(self):
        for value in ("relative.tox", self.target("bad.txt"), self.target("bad\n.tox")):
            with self.subTest(value=value), self.assertRaises(
                service.InvalidArtifactPathError
            ):
                self.start(value)
        self.td.op = lambda _path: None
        with self.assertRaises(service.SourceNotFoundError):
            self.start(self.target("missing.tox"), idempotency_key="missing_source_0001")
        self.assertEqual(self.scheduler.callbacks, [])

    def test_new_target_runs_two_frames_and_reports_verified_artifact(self):
        target = self.target()
        started = self.start(target)
        self.assertEqual(started["status"], "queued")
        self.assertFalse(os.path.exists(target))

        self.scheduler.run_next()
        mid = service.get_export(started["operation_id"])
        self.assertEqual(mid["status"], "verifying")
        self.assertFalse(os.path.exists(target))

        self.scheduler.run_next()
        done = service.get_export(started["operation_id"])
        self.assertEqual(done["status"], "succeeded")
        self.assertEqual(done["verdict"], "PASS")
        self.assertTrue(done["action_applied"])
        self.assertEqual(done["artifact"]["size_bytes"], len(b"TOX-OFFLINE-FIXTURE"))
        self.assertEqual(len(done["artifact"]["sha256"]), 64)
        self.assertEqual(done["artifact"]["td_build"], 32820)
        self.assertNotIn("private", repr(done))

    def test_existing_target_requires_exact_internal_claim_and_preserves_old_until_promote(self):
        target = self.target()
        with open(target, "wb") as handle:
            handle.write(b"OLD")
        with self.assertRaises(service.ArtifactOverwriteRequiredError):
            self.start(target)
        self.assertEqual(self.read_bytes(target), b"OLD")

        approval = self.approval(target)
        started = self.start(target, overwrite_approval=approval)
        self.scheduler.run_next()
        self.assertEqual(self.read_bytes(target), b"OLD")
        self.scheduler.run_next()
        self.assertEqual(self.read_bytes(target), b"TOX-OFFLINE-FIXTURE")
        self.assertEqual(service.get_export(started["operation_id"])["decision"], "Overwrite")

    def test_wrong_or_stale_claim_fails_before_a_job_is_created(self):
        target = self.target()
        with open(target, "wb") as handle:
            handle.write(b"OLD")
        approval = self.approval(target)
        approval["target_fingerprint"] = "0" * 64
        with self.assertRaises(service.InteractionMismatchError):
            self.start(target, overwrite_approval=approval)
        self.assertEqual(self.scheduler.callbacks, [])
        self.assertEqual(self.read_bytes(target), b"OLD")

    def test_portable_clears_only_during_save_then_restores_exact_content_and_links(self):
        with mock.patch.dict(os.environ, {"TDMCP_TOX_PORTABLE_ENABLED": "1"}):
            started = self.start(mode="portable")
            self.finish()
        done = service.get_export(started["operation_id"])
        self.assertEqual(done["status"], "succeeded")
        at_save = self.source.saved_states[0]
        self.assertEqual(at_save["externaltox"], "")
        for child in at_save["children"]:
            if child["file"] is not None:
                self.assertEqual(child["file"], "")
                self.assertFalse(child["syncfile"])
            if child["externaltox"] is not None:
                self.assertEqual(child["externaltox"], "")
        self.assertEqual(self.source.par.externaltox.val, "/machine/local/component.tox")
        self.assertEqual(self.text.par.file.val, "/machine/local/source.dat")
        self.assertTrue(self.text.par.syncfile.val)
        self.assertEqual(self.text.text, "print('hello')")
        self.assertEqual(self.table.rows, [["a", "1"], ["b", "2"]])
        self.assertEqual(self.nested.par.externaltox.val, "/machine/local/component.tox")
        self.assertTrue(done["live_state"]["restored"])
        self.assertEqual(done["verification"]["portable_links_at_save"], 0)

    def test_nonconstant_portable_link_fails_before_mutation_and_save(self):
        self.text.par.file.mode = _Mode("EXPRESSION")
        with mock.patch.dict(os.environ, {"TDMCP_TOX_PORTABLE_ENABLED": "1"}):
            started = self.start(mode="portable")
            self.scheduler.run_next()
        failed = service.get_export(started["operation_id"])
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(failed["error"]["code"], "unsupported_link_mode")
        self.assertEqual(self.source.saved_states, [])
        self.assertEqual(self.text.par.file.val, "/machine/local/source.dat")

    def test_runtime_policy_holds_unverified_build_by_default_before_scheduling(self):
        self.td.app.build = 99999
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(service.PortableExportHeldError):
                self.start(mode="portable")
        self.assertEqual(self.scheduler.callbacks, [])
        self.assertEqual(self.source.saved_states, [])

    def test_runtime_policy_enables_live_proven_build_by_default(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            started = self.start(mode="portable")
            self.finish()
        self.assertEqual(service.get_export(started["operation_id"])["status"], "succeeded")

    def test_save_failure_restores_portable_state_and_removes_temp(self):
        self.source.save_error = RuntimeError("disk unavailable")
        with mock.patch.dict(os.environ, {"TDMCP_TOX_PORTABLE_ENABLED": "1"}):
            started = self.start(mode="portable")
            self.scheduler.run_next()
        failed = service.get_export(started["operation_id"])
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(failed["error"]["code"], "save_failed")
        self.assertTrue(failed["live_state"]["verified"])
        self.assertTrue(failed["cleanup"]["temp_removed"])
        self.assertEqual(self.text.par.file.val, "/machine/local/source.dat")
        self.assertEqual(self.source.par.externaltox.val, "/machine/local/component.tox")

    def test_restore_failure_prevents_promotion_and_reports_live_failure(self):
        self.text.par.file = _RestoreFailPar("/machine/local/source.dat")
        with mock.patch.dict(os.environ, {"TDMCP_TOX_PORTABLE_ENABLED": "1"}):
            started = self.start(mode="portable")
            self.scheduler.run_next()
        failed = service.get_export(started["operation_id"])
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(failed["error"]["code"], "live_restore_failed")
        self.assertFalse(failed["live_state"]["restored"])
        self.assertFalse(failed["action_applied"])
        self.assertTrue(failed["cleanup"]["temp_removed"])
        self.assertFalse(os.path.exists(self.target()))

    def test_idempotency_returns_same_job_and_conflicting_payload_rejects(self):
        first = self.start()
        duplicate = self.start()
        self.assertEqual(duplicate["operation_id"], first["operation_id"])
        self.assertTrue(duplicate["deduplicated"])
        with self.assertRaises(service.IdempotencyConflictError):
            self.start(self.target("other.tox"))
        recovered = service.get_export_by_key("idempotency_key_0001")
        self.assertEqual(recovered["operation_id"], first["operation_id"])
        self.assertEqual(len(self.scheduler.callbacks), 1)

    def test_active_capacity_rejects_second_job_without_mutation(self):
        self.start()
        with self.assertRaises(service.ArtifactCapacityError):
            self.start(
                self.target("other.tox"),
                idempotency_key="idempotency_key_0002",
            )
        self.assertEqual(len(self.scheduler.callbacks), 1)

    def test_cancel_queued_is_exactly_once_and_never_writes(self):
        started = self.start()
        cancelled = service.cancel_export(started["operation_id"])
        duplicate = service.cancel_export(started["operation_id"])
        self.assertTrue(cancelled["accepted"])
        self.assertFalse(duplicate["accepted"])
        self.scheduler.run_next()
        final = service.get_export(started["operation_id"])
        self.assertEqual(final["status"], "cancelled")
        self.assertEqual(final["verdict"], "PASS")
        self.assertFalse(final["action_applied"])
        self.assertFalse(os.path.exists(self.target()))

    def test_cancel_between_save_and_promotion_removes_temp_and_skips_callback(self):
        started = self.start()
        self.scheduler.run_next()
        self.assertEqual(service.get_export(started["operation_id"])["status"], "verifying")
        cancelled = service.cancel_export(started["operation_id"])
        self.assertEqual(cancelled["status"], "cancelled")
        self.scheduler.run_next()
        final = service.get_export(started["operation_id"])
        self.assertEqual(final["status"], "cancelled")
        self.assertTrue(final["cleanup"]["temp_removed"])
        self.assertFalse(os.path.exists(self.target()))

    def test_target_drift_between_frames_prevents_promotion_and_removes_temp(self):
        target = self.target()
        with open(target, "wb") as handle:
            handle.write(b"OLD")
        started = self.start(target, overwrite_approval=self.approval(target))
        self.scheduler.run_next()
        with open(target, "wb") as handle:
            handle.write(b"ARTIST-CHANGED")
        self.scheduler.run_next()
        failed = service.get_export(started["operation_id"])
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(failed["error"]["code"], "interaction_mismatch")
        self.assertEqual(self.read_bytes(target), b"ARTIST-CHANGED")
        self.assertTrue(failed["cleanup"]["temp_removed"])

    def test_terminal_retention_expires_status_and_idempotency_lookup(self):
        started = self.start()
        self.finish()
        self.clock.value += service.TERMINAL_RETENTION_SECONDS + 1
        expired = service.get_export(started["operation_id"])
        by_key = service.get_export_by_key("idempotency_key_0001")
        self.assertEqual(expired["status"], "expired")
        self.assertEqual(expired["verdict"], "UNVERIFIED")
        self.assertEqual(by_key["status"], "expired")

    def test_cleanup_stale_temps_is_prefix_bounded_and_keeps_unrelated_files(self):
        stale = self.target(".tdmcp-widget-operation_id_000000000001.tmp.tox")
        unrelated = self.target("artist.tmp.tox")
        for path in (stale, unrelated):
            with open(path, "wb") as handle:
                handle.write(b"x")
            os.utime(path, (1, 1))
        result = service.cleanup_stale_temps(self.target(), now=service.STALE_TEMP_SECONDS + 2)
        self.assertEqual(result["removed"], 1)
        self.assertFalse(os.path.exists(stale))
        self.assertTrue(os.path.exists(unrelated))

    def test_public_status_never_contains_private_snapshot_or_storage_content(self):
        with mock.patch.dict(os.environ, {"TDMCP_TOX_PORTABLE_ENABLED": "1"}):
            started = self.start(mode="portable")
            self.scheduler.run_next()
        status = service.get_export(started["operation_id"])
        serialized = repr(status)
        self.assertNotIn("not returned", serialized)
        self.assertNotIn("print('hello')", serialized)
        self.assertNotIn("/machine/local/source.dat", serialized)
        self.assertNotIn("_temp_path", serialized)


if __name__ == "__main__":
    unittest.main()
