"""Minimal warm-pipeline FastAPI wrapper around ACE-Step's ``ACEStepPipeline``.

Design goals (mirrors the ``td/`` bridge ethos: plain modules, no binary
artifact, TD-global-free — there is no ``op``/``project`` here at all):

* Hold ONE warm ``ACEStepPipeline`` in a module global so we do not cold-load
  the model per request (the native ``infer-api.py`` cold-loads inside
  ``/generate``; that is the P0 residual live probe).
* ``POST /generate`` runs the generation IN-PROCESS on the warm global pipeline
  (via :func:`run_generation`) — reusing the loaded model, never spawning a
  subprocess — reads the ACTUAL written path back, and returns
  ``{ wavPath, seconds, seed }``.
* The async ``/jobs`` routes (submit/poll/cancel) run each generation in a
  KILLABLE worker subprocess: process death is ACE's only cancel lever (there is
  no in-pipeline abort), so killing the child is what frees VRAM. Warmth and
  killability cannot coexist on one process, so async jobs deliberately pay a
  cold load as the price of cancellation.
* ``GET /health`` reports whether the warm pipeline finished constructing.
* Optional bearer auth when ``TDMCP_ACE_TOKEN`` is set.

The generation itself is delegated to :mod:`ace.worker`, which is unit-testable
offline by patching the pipeline import (no GPU needed). The sync path injects the
warm pipeline into ``worker.generate``; the subprocess path lets it cold-load.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import uuid
from typing import Any, Optional

# The heavy imports (fastapi, the ACE pipeline) are deferred so this module
# imports cleanly for py_compile / smoke tests without the deps installed.


# --- Warm pipeline global -------------------------------------------------

_PIPELINE: Any = None
_PIPELINE_ERROR: Optional[str] = None
_DEVICE: Optional[str] = None

# In-process job map (keyed by uuid). The serializable view returned to clients.
JOBS: dict[str, dict[str, Any]] = {}

# Non-serializable side table (subprocess handles + temp paths). Kept OUT of JOBS
# so the JOBS view stays JSON-safe.
_PROCS: dict[str, dict[str, Any]] = {}


def _checkpoint_dir() -> Optional[str]:
    return os.environ.get("ACE_CHECKPOINT_DIR") or os.environ.get("TDMCP_ACE_CHECKPOINT_DIR")


def _dtype() -> str:
    return os.environ.get("TDMCP_ACE_DTYPE", "bfloat16")


def load_pipeline() -> Any:
    """Construct the warm ``ACEStepPipeline`` ONCE and cache it in a global.

    Kept import-guarded and side-effect-only-on-first-call so the module stays
    importable (and py_compile-clean) without the ``acestep`` package present.
    Returns the cached pipeline on every subsequent call.
    """
    global _PIPELINE, _PIPELINE_ERROR, _DEVICE
    if _PIPELINE is not None:
        return _PIPELINE
    try:
        from acestep.pipeline_ace_step import ACEStepPipeline  # type: ignore

        _PIPELINE = ACEStepPipeline(checkpoint_dir=_checkpoint_dir(), dtype=_dtype())
        try:
            _DEVICE = str(getattr(_PIPELINE, "device", "") or "")
        except Exception:  # noqa: BLE001 - device introspection is best-effort
            _DEVICE = None
        _PIPELINE_ERROR = None
    except Exception as exc:  # noqa: BLE001 - report load failure via /health
        _PIPELINE_ERROR = str(exc)
        raise
    return _PIPELINE


def health_report() -> dict[str, Any]:
    """Shape returned by ``GET /health`` (also usable directly in tests)."""
    return {
        "status": "ok" if _PIPELINE is not None else ("error" if _PIPELINE_ERROR else "loading"),
        "model_loaded": _PIPELINE is not None,
        "device": _DEVICE,
    }


# --- Worker dispatch ------------------------------------------------------


def _cleanup_temps(job_id: str) -> None:
    """Unlink the spec/out temp files for a job and drop its _PROCS entry."""
    rec = _PROCS.pop(job_id, None)
    if not rec:
        return
    for key in ("spec_path", "out_path"):
        path = rec.get(key)
        if not path:
            continue
        try:
            os.unlink(path)
        except OSError:
            pass


def submit_generation(body: dict[str, Any]) -> str:
    """Start a killable worker subprocess WITHOUT waiting; return its job_id.

    The subprocess boundary is what makes cancel (SIGKILL the pid to free VRAM)
    a drop-in — ACE has no in-pipeline abort, so process death is the only lever.
    """
    job_id = uuid.uuid4().hex
    job = {
        "status": "running",
        "pid": None,
        "wavPath": None,
        "seconds": None,
        "seed": None,
        "error": None,
        "submitted_at": time.time(),
        "finished_at": None,
    }
    JOBS[job_id] = job

    spec_fd, spec_path = tempfile.mkstemp(prefix="ace_job_", suffix=".json")
    out_fd, out_path = tempfile.mkstemp(prefix="ace_out_", suffix=".json")
    os.close(out_fd)
    try:
        with os.fdopen(spec_fd, "w", encoding="utf-8") as handle:
            json.dump({"body": body, "out": out_path}, handle)

        proc = subprocess.Popen(  # noqa: S603 - args are fixed, spec is a temp file
            [sys.executable, "-m", "ace.worker", spec_path],
        )
    except Exception as exc:  # noqa: BLE001 - convert to a terminal job error
        job["status"] = "error"
        job["error"] = str(exc)
        job["finished_at"] = time.time()
        for path in (spec_path, out_path):
            try:
                os.unlink(path)
            except OSError:
                pass
        return job_id

    job["pid"] = proc.pid
    _PROCS[job_id] = {"proc": proc, "spec_path": spec_path, "out_path": out_path}
    return job_id


def _finalize_job(job_id: str) -> None:
    """Read a finished worker's out JSON into JOBS[job_id] and clean up temps."""
    job = JOBS.get(job_id)
    rec = _PROCS.get(job_id)
    if job is None or rec is None:
        return
    try:
        with open(rec["out_path"], "r", encoding="utf-8") as handle:
            result = json.load(handle)
    except Exception as exc:  # noqa: BLE001 - missing/corrupt out => error
        job.update(status="error", error=str(exc), finished_at=time.time())
        _cleanup_temps(job_id)
        return

    if result.get("error"):
        job.update(status="error", error=result["error"], finished_at=time.time())
    else:
        job.update(
            status="done",
            wavPath=result.get("wavPath"),
            seconds=result.get("seconds"),
            seed=result.get("seed"),
            finished_at=time.time(),
        )
    _cleanup_temps(job_id)


def poll_job(job_id: str) -> Optional[dict[str, Any]]:
    """Return the serializable JOBS view, finalizing if the worker just exited."""
    job = JOBS.get(job_id)
    if job is None:
        return None
    rec = _PROCS.get(job_id)
    if job["status"] == "running" and rec is not None:
        if rec["proc"].poll() is not None:  # worker exited
            _finalize_job(job_id)
    return job


def cancel_job(job_id: str) -> Optional[dict[str, Any]]:
    """SIGKILL a running worker (freeing VRAM by process death); terminal jobs no-op."""
    job = JOBS.get(job_id)
    if job is None:
        return None
    if job["status"] in ("done", "error", "cancelled"):
        return {"cancelled": False, "status": job["status"]}
    rec = _PROCS.get(job_id)
    if rec is not None:
        proc = rec["proc"]
        try:
            proc.kill()  # portable (TerminateProcess on Windows, SIGKILL on POSIX)
            proc.wait(timeout=5)
        except Exception:  # noqa: BLE001 - best-effort reap; already gone is fine
            pass
        _cleanup_temps(job_id)
    job.update(status="cancelled", finished_at=time.time())
    return {"cancelled": True, "status": "cancelled"}


def run_generation(body: dict[str, Any]) -> dict[str, Any]:
    """Synchronous facade for ``POST /generate`` (P0/F2 depend on this shape).

    Runs the generation IN-PROCESS on the warm ``load_pipeline()`` global — NOT
    in a subprocess. This is the whole point of the warm wrapper: the sync path
    reuses the already-loaded model instead of paying a cold load per request (or
    doubling VRAM with a second pipeline in a child process).

    The killable worker subprocess is reserved for the async ``/jobs`` routes,
    where killing the process to reclaim VRAM is the only cancel lever ACE offers.
    Warmth and killability are mutually exclusive on one process, so the async
    path deliberately pays a cold load as the cost of cancellation.
    """
    from ace import worker  # local import keeps module import light / py_compile-clean

    pipeline = load_pipeline()
    return worker.generate(body, pipeline=pipeline)


# --- FastAPI app ----------------------------------------------------------


def create_app() -> Any:
    """Build the FastAPI app. Imported lazily so tests can skip fastapi."""
    from fastapi import FastAPI, HTTPException, Request  # type: ignore

    app = FastAPI(title="tdmcp ACE-Step wrapper")

    def _check_auth(request: "Request") -> None:
        token = os.environ.get("TDMCP_ACE_TOKEN")
        if not token:
            return
        header = request.headers.get("authorization", "")
        if header != f"Bearer {token}":
            raise HTTPException(status_code=401, detail="Invalid or missing bearer token.")

    @app.on_event("startup")
    def _warm() -> None:  # pragma: no cover - requires the model/GPU
        try:
            load_pipeline()
        except Exception:  # noqa: BLE001 - /health surfaces the failure
            pass

    @app.get("/health")
    def health(request: Request) -> dict[str, Any]:
        _check_auth(request)
        return health_report()

    @app.post("/generate")
    def generate(body: dict[str, Any], request: Request) -> dict[str, Any]:
        _check_auth(request)
        if not str(body.get("prompt", "")).strip():
            raise HTTPException(status_code=422, detail="Field 'prompt' is required.")
        try:
            return run_generation(body)
        except Exception as exc:  # noqa: BLE001 - map to a wrapper API error
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    @app.post("/jobs")
    def submit(body: dict[str, Any], request: Request) -> dict[str, Any]:
        _check_auth(request)
        if not str(body.get("prompt", "")).strip():
            raise HTTPException(status_code=422, detail="Field 'prompt' is required.")
        return {"job_id": submit_generation(body)}

    @app.get("/jobs/{job_id}")
    def job_status(job_id: str, request: Request) -> dict[str, Any]:
        _check_auth(request)
        job = poll_job(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail=f"Unknown job {job_id}")
        return {
            "status": job["status"],
            "wavPath": job["wavPath"],
            "seconds": job["seconds"],
            "seed": job["seed"],
            "error": job["error"],
        }

    @app.post("/jobs/{job_id}/cancel")
    def job_cancel(job_id: str, request: Request) -> dict[str, Any]:
        _check_auth(request)
        res = cancel_job(job_id)
        if res is None:
            raise HTTPException(status_code=404, detail=f"Unknown job {job_id}")
        return res

    return app


def main() -> None:  # pragma: no cover - process entrypoint
    import uvicorn  # type: ignore

    host = os.environ.get("TDMCP_ACE_HOST", "127.0.0.1")
    port = int(os.environ.get("TDMCP_ACE_PORT", "8000"))
    uvicorn.run(create_app(), host=host, port=port)


if __name__ == "__main__":  # pragma: no cover
    main()
