"""Focused offline tests for the tox-only quarantine roundtrip service."""

import hashlib
import os
import sys
import tempfile
import types
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_MODULES = os.path.abspath(os.path.join(_HERE, "..", "modules"))
if _MODULES not in sys.path:
    sys.path.insert(0, _MODULES)

from mcp.services import tox_roundtrip_service as service  # noqa: E402


class _Scheduler:
    def __init__(self):
        self.callbacks = []

    def __call__(self, callback):
        self.callbacks.append(callback)

    def run_next(self):
        self.callbacks.pop(0)()

    def drain(self, limit=32):
        for _unused in range(limit):
            if not self.callbacks:
                return
            self.run_next()
        raise AssertionError("scheduler did not drain")


class _Clock:
    def __init__(self):
        self.value = 100.0

    def __call__(self):
        return self.value


class _Page:
    def __init__(self, name):
        self.name = name


class _Par:
    def __init__(self, name, value="", style="Str", page="Main"):
        self.name = name
        self.val = value
        self.style = style
        self.page = _Page(page)

    def eval(self):
        return self.val


class _Node:
    def __init__(self, path, node_id, op_type, children=None, errors="", pars=None):
        self.path = path
        self.id = node_id
        self.OPType = op_type
        self.type = "misleadingLegacyType"
        self.children = list(children or [])
        self._errors = errors
        self._pars = list(pars or [])

    def pars(self):
        return list(self._pars)

    def errors(self, recurse=False):  # noqa: ARG002
        return self._errors


class _Holder(_Node):
    isCOMP = True

    def __init__(self, parent, path, node_id, template, load_error=None):
        super().__init__(path, node_id, "baseCOMP")
        self.parent = parent
        self.template = template
        self.load_error = load_error
        self.inputConnectors = [object()]
        self.outputConnectors = [object(), object()]
        self.customPars = [_Par("Gain", 1, "Float", "Controls")]
        self.load_calls = []
        self.nodeX = 0
        self.nodeY = 0

    def loadTox(self, path, asynchronous=None):  # noqa: N802
        self.load_calls.append((path, asynchronous))
        if self.load_error is not None:
            raise self.load_error
        self.children = self.template()

    def destroy(self):
        self.parent.remove(self)


class _Parent(_Node):
    isCOMP = True

    def __init__(self, td, template):
        super().__init__("/project1", 1, "containerCOMP")
        self.td = td
        self.template = template
        self.load_error = None
        self.created = []

    def create(self, op_type, name):  # noqa: ARG002
        path = self.path + "/" + name
        holder = _Holder(
            self, path, 100 + len(self.created), self.template, self.load_error
        )
        self.created.append(holder)
        self.children.append(holder)
        self.td.nodes[path] = holder
        return holder

    def remove(self, holder):
        self.children = [node for node in self.children if node is not holder]
        self.td.nodes.pop(holder.path, None)


class ToxRoundtripServiceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.artifact = os.path.join(self.temp.name, "widget.tox")
        with open(self.artifact, "wb") as handle:
            handle.write(b"TOX-ROUNDTRIP-FIXTURE")
        self.sha = hashlib.sha256(b"TOX-ROUNDTRIP-FIXTURE").hexdigest()
        self.scheduler = _Scheduler()
        self.clock = _Clock()
        self.ids = iter(
            (
                "operation-id_000000000001",
                "operation_id_000000000002",
                "operation_id_000000000003",
                "operation_id_000000000004",
            )
        )
        service._reset_for_tests(clock=self.clock, id_factory=lambda: next(self.ids))
        self.td = types.ModuleType("td")
        self.td.baseCOMP = object()
        self.td.app = types.SimpleNamespace(version="2025.32820", build=32820)
        self.td.nodes = {}
        self.parent = _Parent(self.td, self._template)
        self.td.nodes["/project1"] = self.parent
        self.td.op = lambda path: self.td.nodes.get(path)
        old_td = sys.modules.get("td")
        sys.modules["td"] = self.td
        self.addCleanup(self._restore_td, old_td)

    @staticmethod
    def _restore_td(old_td):
        if old_td is None:
            sys.modules.pop("td", None)
        else:
            sys.modules["td"] = old_td

    @staticmethod
    def _template():
        return [
            _Node("/project1/scratch/noise1", 201, "noiseTOP"),
            _Node("/project1/scratch/out1", 202, "nullTOP"),
        ]

    def contract(self, **overrides):
        contract = {
            "schema_version": 1,
            "artifact_sha256": self.sha,
            "root_type": "baseCOMP",
            "node_count": 2,
            "type_counts": {"noiseTOP": 1, "nullTOP": 1},
            "custom_parameters": [
                {"page": "Controls", "name": "Gain", "style": "Float"}
            ],
            "connectors": {"inputs": 1, "outputs": 2},
            "external_references": {"policy": "none", "count": 0},
            "max_cook_errors": 0,
        }
        contract.update(overrides)
        return contract

    def start(self, **kwargs):
        return service.start_roundtrip(
            self.artifact,
            expected_contract=kwargs.pop("expected_contract", self.contract()),
            artifact_sha256=kwargs.pop("artifact_sha256", self.sha),
            scheduler=self.scheduler,
            **kwargs,
        )

    def finish(self, started):
        self.scheduler.drain()
        return service.get_roundtrip(started["operation_id"])

    def test_queues_before_touching_td_then_passes_and_cleans(self):
        started = self.start(settle_frames=3)
        self.assertEqual(started["status"], "queued")
        self.assertEqual(self.parent.created, [])

        done = self.finish(started)

        self.assertEqual(done["status"], "succeeded")
        self.assertEqual(done["verdict"], "PASS")
        self.assertEqual(done["runtime"]["frames_waited"], 3)
        self.assertEqual(done["observed"]["type_counts"], {"noiseTOP": 1, "nullTOP": 1})
        self.assertTrue(done["cleanup"]["verified"])
        self.assertIsNone(self.td.op(done["cleanup"]["scratch_path"]))
        holder = self.parent.created[0]
        self.assertNotIn("-", holder.path)
        self.assertEqual(holder.load_calls, [(self.artifact, None)])
        self.assertEqual((holder.nodeX, holder.nodeY), (-2400, -2400))
        self.assertFalse(hasattr(self.td, "project"))

    def test_missing_contract_is_unverified_but_still_cleans(self):
        started = self.start(expected_contract=None)
        done = self.finish(started)
        self.assertEqual(done["status"], "succeeded")
        self.assertEqual(done["verdict"], "UNVERIFIED")
        self.assertTrue(done["cleanup"]["verified"])

    def test_contract_mismatch_is_completed_fail(self):
        started = self.start(expected_contract=self.contract(node_count=99))
        done = self.finish(started)
        self.assertEqual(done["status"], "succeeded")
        self.assertEqual(done["verdict"], "FAIL")
        mismatch = next(
            check for check in done["checks"] if check["name"] == "node_count"
        )
        self.assertEqual(mismatch["code"], "mismatch")

    def test_path_type_symlink_and_bounds_reject_before_schedule(self):
        bad_txt = os.path.join(self.temp.name, "widget.toe")
        with open(bad_txt, "wb") as handle:
            handle.write(b"toe")
        link = os.path.join(self.temp.name, "link.tox")
        os.symlink(self.artifact, link)
        for value in ("relative.tox", bad_txt, link, self.temp.name):
            with (
                self.subTest(value=value),
                self.assertRaises(service.InvalidToxArtifactError),
            ):
                service.start_roundtrip(value, scheduler=self.scheduler)
        with self.assertRaises(ValueError):
            self.start(settle_frames=0)
        self.assertEqual(self.scheduler.callbacks, [])

    def test_load_failure_is_typed_and_cleanup_is_verified(self):
        self.parent.load_error = RuntimeError("malformed fixture")
        started = self.start()
        done = self.finish(started)
        self.assertEqual(done["status"], "failed")
        self.assertEqual(done["error"]["phase"], "load")
        self.assertTrue(done["cleanup"]["verified"])

    def test_cancel_is_exactly_once_and_callback_cannot_resolve_again(self):
        started = self.start()
        cancelled = service.cancel_roundtrip(started["operation_id"])
        again = service.cancel_roundtrip(started["operation_id"])
        self.assertEqual(cancelled, again)
        self.assertEqual(cancelled["status"], "cancelled")
        self.assertTrue(cancelled["cleanup"]["verified"])
        self.scheduler.drain()
        self.assertEqual(service.get_roundtrip(started["operation_id"]), cancelled)

    def test_timeout_is_terminal_and_cleans_before_load(self):
        started = self.start(timeout_ms=1000)
        self.clock.value += 2
        timed_out = service.get_roundtrip(started["operation_id"])
        self.assertEqual(timed_out["status"], "failed")
        self.assertEqual(timed_out["error"]["code"], "timeout")
        self.assertTrue(timed_out["cleanup"]["verified"])

    def test_two_jobs_are_isolated_and_third_is_rejected(self):
        first = self.start()
        second = self.start(artifact_sha256=self.sha)
        with self.assertRaises(service.RoundtripCapacityError):
            self.start()
        self.scheduler.run_next()
        self.scheduler.run_next()
        paths = [
            job["cleanup"]["scratch_path"]
            for job in (
                service.get_roundtrip(first["operation_id"]),
                service.get_roundtrip(second["operation_id"]),
            )
        ]
        self.assertEqual(len(set(paths)), 2)
        self.assertEqual(self.parent.created[0].nodeY, -2400)
        self.assertEqual(self.parent.created[1].nodeY, -2580)
        service.cancel_all()

    def test_external_refs_are_fingerprinted_without_returning_values(self):
        secret_path = "/Users/artist/private/footage.mov"

        def template():
            return [
                _Node(
                    "/project1/scratch/movie",
                    301,
                    "moviefileinTOP",
                    pars=[_Par("file", secret_path, "File")],
                )
            ]

        self.parent.template = template
        expected_fingerprint = hashlib.sha256(
            ("machine_absolute\0" + secret_path).encode("utf-8")
        ).hexdigest()
        started = self.start(
            expected_contract=self.contract(
                node_count=1,
                type_counts={"moviefileinTOP": 1},
                external_references={
                    "policy": "exact",
                    "count": 1,
                    "fingerprints": [expected_fingerprint],
                },
            )
        )
        done = self.finish(started)
        self.assertEqual(done["verdict"], "PASS")
        self.assertNotIn(secret_path, repr(done))

    def test_cleanup_refuses_to_destroy_same_path_replacement(self):
        started = self.start()
        self.scheduler.run_next()
        job = service._job(started["operation_id"])
        replacement = _Node(job["cleanup"]["scratch_path"], 9999, "baseCOMP")
        self.td.nodes[replacement.path] = replacement
        service.cancel_roundtrip(started["operation_id"])
        done = service.get_roundtrip(started["operation_id"])
        self.assertEqual(done["status"], "failed")
        self.assertEqual(done["error"]["code"], "cleanup_failed")
        self.assertIs(self.td.op(replacement.path), replacement)

    def test_disconnect_cancels_all_active_jobs(self):
        first = self.start()
        second = self.start()
        self.assertEqual(service.cancel_all("disconnect"), 2)
        for started in (first, second):
            done = service.get_roundtrip(started["operation_id"])
            self.assertEqual(done["status"], "cancelled")
            self.assertTrue(done["cleanup"]["verified"])


if __name__ == "__main__":
    unittest.main()
