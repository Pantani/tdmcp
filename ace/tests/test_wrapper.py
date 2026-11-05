"""Offline smoke tests for the ACE-Step wrapper (no GPU, no acestep package).

The pipeline import is patched with a fake so ``/generate`` request-mapping and
``/health`` are unit-testable. Run: ``python -m unittest ace.tests.test_wrapper``.
"""

from __future__ import annotations

import json
import os
import sys
import unittest
import wave
from unittest import mock

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(os.path.dirname(_HERE))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from ace import worker, wrapper  # noqa: E402


class FakePipeline:
    """Stand-in for ``ACEStepPipeline`` that records call kwargs."""

    last_kwargs: dict = {}

    def __init__(self, checkpoint_dir=None, dtype=None):
        self.checkpoint_dir = checkpoint_dir
        self.dtype = dtype

    def __call__(self, **kwargs):
        FakePipeline.last_kwargs = kwargs
        return {"output_paths": [kwargs.get("save_path", "/out") + "/output_1.wav"],
                "actual_seeds": [kwargs.get("manual_seeds", [0])[0] if kwargs.get("manual_seeds") else 7]}


class BuildKwargsTest(unittest.TestCase):
    def test_scalar_seed_becomes_list(self):
        kwargs = worker._build_kwargs(
            {"prompt": "p", "manual_seeds": 42, "infer_step": 27, "guidance_scale": 15.0}
        )
        self.assertEqual(kwargs["manual_seeds"], [42])
        self.assertEqual(kwargs["infer_step"], 27)
        self.assertEqual(kwargs["guidance_scale"], 15.0)
        self.assertEqual(kwargs["format"], "wav")

    def test_omitted_seed_is_none(self):
        kwargs = worker._build_kwargs({"prompt": "p"})
        self.assertIsNone(kwargs["manual_seeds"])

    def test_first_wav_prefers_wav_extension(self):
        self.assertEqual(worker._first_wav(["a.json", "b.wav"]), "b.wav")
        self.assertEqual(worker._first_wav("solo.wav"), "solo.wav")
        self.assertIsNone(worker._first_wav([]))


class GenerateTest(unittest.TestCase):
    def test_generate_maps_and_reads_written_path(self):
        module = mock.MagicMock()
        module.pipeline_ace_step.ACEStepPipeline = FakePipeline
        with mock.patch.dict(
            sys.modules,
            {"acestep": module, "acestep.pipeline_ace_step": module.pipeline_ace_step},
        ):
            out = worker.generate(
                {"prompt": "lofi", "manual_seeds": 99, "save_path": "/out", "audio_duration": -1}
            )
        self.assertEqual(out["wavPath"], "/out/output_1.wav")
        self.assertEqual(out["seed"], 99)
        # audio_duration -1 fell through (no readable wav on disk).
        self.assertEqual(out["seconds"], -1)

    def test_wav_seconds_reads_real_file(self):
        import tempfile

        fd, path = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        try:
            with wave.open(path, "wb") as handle:
                handle.setnchannels(1)
                handle.setsampwidth(2)
                handle.setframerate(1000)
                handle.writeframes(b"\x00\x00" * 2000)
            self.assertAlmostEqual(worker._wav_seconds(path), 2.0, places=3)
        finally:
            os.unlink(path)


class RunGenerationSyncTest(unittest.TestCase):
    """The sync ``/generate`` path must run IN-PROCESS on the warm pipeline.

    It must NOT spawn a killable worker subprocess (that path is reserved for the
    async /jobs routes). We assert both: the warm pipeline is used, and Popen is
    never called.
    """

    def setUp(self):
        wrapper.JOBS.clear()
        wrapper._PROCS.clear()

    def tearDown(self):
        wrapper.JOBS.clear()
        wrapper._PROCS.clear()

    def test_sync_generate_uses_warm_pipeline_no_subprocess(self):
        warm = FakePipeline()
        with mock.patch.object(wrapper, "load_pipeline", return_value=warm), mock.patch.object(
            wrapper.subprocess, "Popen"
        ) as popen:
            out = wrapper.run_generation(
                {"prompt": "lofi", "manual_seeds": 5, "save_path": "/out", "audio_duration": -1}
            )
        popen.assert_not_called()  # in-process: no killable worker spawned
        self.assertEqual(out["wavPath"], "/out/output_1.wav")
        self.assertEqual(out["seed"], 5)
        # No job bookkeeping is created for the sync path.
        self.assertEqual(wrapper.JOBS, {})
        self.assertEqual(wrapper._PROCS, {})

    def test_sync_generate_surfaces_pipeline_errors(self):
        class Boom(FakePipeline):
            def __call__(self, **kwargs):
                raise RuntimeError("kaboom")

        with mock.patch.object(wrapper, "load_pipeline", return_value=Boom()):
            with self.assertRaises(RuntimeError):
                wrapper.run_generation({"prompt": "x"})


class HealthReportTest(unittest.TestCase):
    def test_loading_when_no_pipeline(self):
        with mock.patch.object(wrapper, "_PIPELINE", None), mock.patch.object(
            wrapper, "_PIPELINE_ERROR", None
        ):
            report = wrapper.health_report()
        self.assertFalse(report["model_loaded"])
        self.assertEqual(report["status"], "loading")

    def test_ok_when_pipeline_present(self):
        with mock.patch.object(wrapper, "_PIPELINE", object()), mock.patch.object(
            wrapper, "_DEVICE", "cuda:0"
        ):
            report = wrapper.health_report()
        self.assertTrue(report["model_loaded"])
        self.assertEqual(report["status"], "ok")
        self.assertEqual(report["device"], "cuda:0")


class _FakeProc:
    """Stand-in for a Popen handle: `poll()` flips to exited after `finish()`."""

    def __init__(self, pid=4321):
        self.pid = pid
        self._code = None
        self.killed = False

    def finish(self, code=0):
        self._code = code

    def poll(self):
        return self._code

    def wait(self, timeout=None):
        if self._code is None:
            self._code = 0
        return self._code

    def kill(self):
        self.killed = True
        self._code = -9


class JobLifecycleTest(unittest.TestCase):
    """Async submit/poll/cancel offline: patch Popen so no real worker runs."""

    def setUp(self):
        wrapper.JOBS.clear()
        wrapper._PROCS.clear()

    def tearDown(self):
        wrapper.JOBS.clear()
        wrapper._PROCS.clear()

    def _submit(self, proc):
        with mock.patch.object(wrapper.subprocess, "Popen", return_value=proc):
            return wrapper.submit_generation({"prompt": "lofi"})

    def test_submit_returns_running_job(self):
        proc = _FakeProc()
        job_id = self._submit(proc)
        self.assertIn(job_id, wrapper.JOBS)
        self.assertEqual(wrapper.JOBS[job_id]["status"], "running")
        self.assertEqual(wrapper.JOBS[job_id]["pid"], proc.pid)
        self.assertIn(job_id, wrapper._PROCS)

    def test_poll_running_then_done(self):
        proc = _FakeProc()
        job_id = self._submit(proc)
        # Still running: poll returns running, no finalize.
        self.assertEqual(wrapper.poll_job(job_id)["status"], "running")

        # Worker writes its out JSON and exits -> poll transitions to done.
        out_path = wrapper._PROCS[job_id]["out_path"]
        with open(out_path, "w", encoding="utf-8") as handle:
            json.dump({"wavPath": "/out/x.wav", "seconds": 30, "seed": 42}, handle)
        proc.finish(0)

        job = wrapper.poll_job(job_id)
        self.assertEqual(job["status"], "done")
        self.assertEqual(job["wavPath"], "/out/x.wav")
        self.assertEqual(job["seconds"], 30)
        self.assertEqual(job["seed"], 42)
        # Temps cleaned up + side table dropped after finalize.
        self.assertNotIn(job_id, wrapper._PROCS)

    def test_poll_worker_error(self):
        proc = _FakeProc()
        job_id = self._submit(proc)
        out_path = wrapper._PROCS[job_id]["out_path"]
        with open(out_path, "w", encoding="utf-8") as handle:
            json.dump({"error": "boom"}, handle)
        proc.finish(0)
        job = wrapper.poll_job(job_id)
        self.assertEqual(job["status"], "error")
        self.assertEqual(job["error"], "boom")

    def test_cancel_running_job(self):
        proc = _FakeProc()
        job_id = self._submit(proc)
        res = wrapper.cancel_job(job_id)
        self.assertTrue(res["cancelled"])
        self.assertEqual(res["status"], "cancelled")
        self.assertTrue(proc.killed)
        self.assertEqual(wrapper.JOBS[job_id]["status"], "cancelled")
        self.assertNotIn(job_id, wrapper._PROCS)

    def test_cancel_terminal_job_is_noop(self):
        proc = _FakeProc()
        job_id = self._submit(proc)
        wrapper.JOBS[job_id]["status"] = "done"
        res = wrapper.cancel_job(job_id)
        self.assertFalse(res["cancelled"])
        self.assertEqual(res["status"], "done")

    def test_unknown_job_id(self):
        self.assertIsNone(wrapper.poll_job("nope"))
        self.assertIsNone(wrapper.cancel_job("nope"))


if __name__ == "__main__":
    unittest.main()
