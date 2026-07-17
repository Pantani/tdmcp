"""Capture a TOP as a base64-encoded PNG.

The TOP is composited over a checkerboard first, so transparent regions read as a
checker pattern instead of solid white when a viewer flattens the PNG's alpha over a
white page. Opaque TOPs are unaffected (the checker stays fully hidden). If the
composite path errors for any reason, we fall back to saving the TOP directly.
"""

import base64
import math
import time
import uuid

import td

op = td.op  # TD globals are not available inside imported modules; reach via td

_CHANNELS = ("r", "g", "b", "a")

# Deferred capture jobs: a transient event (a feedback reset, a timer start) can only
# be seen a few frames AFTER the pulse that triggers it, but the trigger and the
# capture arrive on separate MCP round-trips. delay_frames schedules the capture on a
# later TD frame and stashes the result here; a follow-up call collects it by job id.
_PREVIEW_JOBS = {}
_JOB_TTL_SECONDS = 120.0
_MAX_PREVIEW_JOBS = 32
_MAX_STORED_PREVIEW_JOBS = 128
_MAX_JOB_ERROR_CHARS = 512

# Mid-gray checkerboard (16x9 cells). Self-contained fragment shader, no inputs/uniforms.
_CHECKER_FRAG = """out vec4 fragColor;
void main(){
    vec2 cell = floor(vUV.st * vec2(16.0, 9.0));
    float k = mod(cell.x + cell.y, 2.0);
    fragColor = vec4(mix(vec3(0.16), vec3(0.30), k), 1.0);
}
"""


def _save_png(node):
    """Return the node's PNG bytes, via saveByteArray with a temp-file fallback."""
    data = None
    try:
        data = node.saveByteArray(".png")
    except Exception:  # noqa: BLE001
        data = None

    if data is None:
        import os
        import tempfile

        tmp = os.path.join(tempfile.gettempdir(), "tdmcp_preview.png")
        node.save(tmp)
        with open(tmp, "rb") as handle:
            data = handle.read()

    return bytes(data)


def _checkerboard_png(node, width, height):
    """Composite `node` over a checkerboard and return the flattened PNG bytes.

    Creates a few temporary nodes in the node's parent and destroys them afterwards
    (even on error). Returns None if the composite could not be produced, so callers
    can fall back to a direct save.
    """
    parent = node.parent()
    if parent is None:
        return None

    temps = []
    try:
        frag = parent.create("textDAT", "__tdmcp_pv_frag")
        temps.append(frag)
        frag.text = _CHECKER_FRAG

        bg = parent.create("glslTOP", "__tdmcp_pv_bg")
        temps.append(bg)
        bg.par.pixeldat = frag.name
        bg.par.outputresolution = "custom"
        bg.par.resolutionw = width
        bg.par.resolutionh = height

        comp = parent.create("compositeTOP", "__tdmcp_pv_comp")
        temps.append(comp)
        comp.par.operand = "over"
        comp.par.outputresolution = "custom"
        comp.par.resolutionw = width
        comp.par.resolutionh = height
        comp.inputConnectors[0].connect(node)  # foreground (over)
        comp.inputConnectors[1].connect(bg)  # background (under)
        comp.cook(force=True)

        if comp.errors():
            return None
        return _save_png(comp)
    except Exception:  # noqa: BLE001
        return None
    finally:
        for t in reversed(temps):
            try:
                t.destroy()
            except Exception:  # noqa: BLE001
                pass


def capture(path, width=640, height=360):
    node = op(path)
    if node is None:
        raise LookupError("Node not found: %s" % path)
    if getattr(node, "family", None) != "TOP":
        raise ValueError("Preview is only supported for TOPs, got %s" % path)

    w = int(getattr(node, "width", width) or width)
    h = int(getattr(node, "height", height) or height)
    # Clamp to a sane preview ceiling so a hostile/huge request (or a TOP with an
    # extreme resolution) can't allocate a multi-gigapixel GPU texture and exhaust
    # VRAM / hang TD. A preview is a thumbnail; 4096 on a side is plenty.
    w = max(1, min(w, 4096))
    h = max(1, min(h, 4096))

    data = _checkerboard_png(node, w, h)
    if data is None:
        data = _save_png(node)

    encoded = base64.b64encode(data).decode("ascii")
    return {
        "path": node.path,
        "width": w,
        "height": h,
        "format": "png",
        "base64": encoded,
    }


def _finite_or_none(value):
    """Coerce to a JSON-safe float, mapping NaN/Inf (HDR TOPs) to None."""
    try:
        number = float(value)
    except Exception:  # noqa: BLE001
        return None
    return number if math.isfinite(number) else None


def _grid_indices(count, size):
    """Cell-center pixel indices for `count` evenly-spaced samples across `size`."""
    if size <= 0:
        return [0] * count
    return [min(size - 1, int((i + 0.5) / count * size)) for i in range(count)]


def _column_values(samples, channel_index):
    """Non-null samples for one channel across the whole grid."""
    values = []
    for row in samples:
        for cell in row:
            if channel_index < len(cell) and cell[channel_index] is not None:
                values.append(cell[channel_index])
    return values


def _stat(values):
    if not values:
        return {"min": None, "max": None, "mean": None}
    return {"min": min(values), "max": max(values), "mean": sum(values) / len(values)}


def _channel_stats(samples):
    """Per-channel {min,max,mean} over the sampled grid, ignoring None (NaN/Inf)."""
    return {key: _stat(_column_values(samples, index)) for index, key in enumerate(_CHANNELS)}


def _grid_from_array(arr, n):
    """Sample an HxWx(>=4) pixel array at n×n cell centers → nested RGBA lists."""
    height = len(arr)
    width = len(arr[0]) if height else 0
    ys = _grid_indices(n, height)
    xs = _grid_indices(n, width)
    samples = []
    for y in ys:
        row = []
        for x in xs:
            pixel = arr[y][x]
            row.append([_finite_or_none(pixel[c]) for c in range(min(4, len(pixel)))])
        samples.append(row)
    return samples, width, height


def _validate_pulse_targets(pre_pulses):
    """Resolve every {path, par} pulse target, raising BEFORE any is fired.

    All-or-nothing: if any target is missing we raise and pulse nothing, so a typo
    can never leave the network half-triggered.
    """
    targets = []
    for spec in pre_pulses or []:
        path = spec.get("path")
        par_name = spec.get("par")
        if not path or not par_name:
            raise ValueError("Each pre_pulse needs both a 'path' and a 'par'.")
        node = op(path)
        if node is None:
            raise LookupError("Pulse target not found: %s" % path)
        par = getattr(node.par, par_name, None)
        if par is None:
            raise ValueError("No such parameter %r on %s" % (par_name, path))
        targets.append(par)
    return targets


def _fire_pulses(targets):
    for par in targets:
        par.pulse()


def _fps():
    for source, attr in ((td.app, "fps"), (td.project, "cookRate")):
        try:
            rate = float(getattr(source, attr, None))
        except Exception:  # noqa: BLE001
            rate = 0.0
        if rate > 0:
            return rate
    return 60.0


def _schedule(callback, frames):
    """Run `callback` after `frames` TD frames. Overridable/patchable in tests.

    TD's global `run()` executes a script string with extra positional args exposed as
    `args`, so `run("args[0]()", cb, delayFrames=n)` defers a callable. Off-TD (no
    `run`) we invoke it immediately so the job still resolves.
    """
    run = getattr(td, "run", None)
    if run is None:
        callback()
        return
    run("args[0]()", callback, delayFrames=int(frames))


def _capture_now(path, width, height, sample_grid_n):
    if sample_grid_n:
        return sample_grid(path, sample_grid_n)
    return capture(path, width, height)


def _prune_jobs(now):
    for job_id in [
        jid
        for jid, job in _PREVIEW_JOBS.items()
        if now - job["created"] > _JOB_TTL_SECONDS
    ]:
        del _PREVIEW_JOBS[job_id]


def _job_receipt(job_id, job):
    status = job["status"]
    receipt = {"status": status, "job_id": job_id}
    if status == "ready":
        receipt["preview"] = job["result"]
    elif status == "error":
        receipt["error"] = job["error"]
    return receipt


def _schedule_deferred(path, width, height, delay_frames, sample_grid_n):
    now = time.monotonic()
    _prune_jobs(now)
    active_jobs = sum(1 for job in _PREVIEW_JOBS.values() if job["status"] == "pending")
    if active_jobs >= _MAX_PREVIEW_JOBS:
        raise RuntimeError(
            "Deferred preview capacity reached (%d active jobs); collect, cancel, or wait for expiry."
            % _MAX_PREVIEW_JOBS
        )
    if len(_PREVIEW_JOBS) >= _MAX_STORED_PREVIEW_JOBS:
        raise RuntimeError(
            "Deferred preview receipt capacity reached (%d stored jobs); collect or wait for expiry."
            % _MAX_STORED_PREVIEW_JOBS
        )
    job_id = uuid.uuid4().hex
    job = {"created": now, "status": "pending", "result": None, "error": None}
    _PREVIEW_JOBS[job_id] = job

    def _run():
        current = _PREVIEW_JOBS.get(job_id)
        if current is not job or current["status"] != "pending":
            return
        if time.monotonic() - job["created"] > _JOB_TTL_SECONDS:
            del _PREVIEW_JOBS[job_id]
            return
        try:
            result = _capture_now(path, width, height, sample_grid_n)
        except Exception as exc:  # noqa: BLE001
            if _PREVIEW_JOBS.get(job_id) is not job or job["status"] != "pending":
                return
            job["status"] = "error"
            job["error"] = str(exc)[:_MAX_JOB_ERROR_CHARS]
            return
        if _PREVIEW_JOBS.get(job_id) is not job or job["status"] != "pending":
            return
        job["result"] = result
        job["status"] = "ready"

    _schedule(_run, delay_frames)
    return {
        "status": "pending",
        "job_id": job_id,
        "delay_frames": int(delay_frames),
        "wait_ms": int(delay_frames * 1000 / _fps()),
        "expires_in_ms": int(_JOB_TTL_SECONDS * 1000),
    }


def capture_advanced(path, width=640, height=360, pre_pulses=None, delay_frames=0, sample_grid_n=None):
    """Capture with optional same-tick pre-pulses and an optional deferred delay.

    Pulses (validated all-or-nothing) fire in THIS bridge tick, immediately before the
    capture. With delay_frames>0 the capture is scheduled N frames later and a
    {status:"capturing", job_id} is returned to collect afterwards; otherwise it
    captures immediately.
    """
    targets = _validate_pulse_targets(pre_pulses)
    _fire_pulses(targets)
    if delay_frames and int(delay_frames) > 0:
        return _schedule_deferred(path, width, height, int(delay_frames), sample_grid_n)
    return _capture_now(path, width, height, sample_grid_n)


def cancel_preview_job(job_id):
    """Cancel a pending capture without allowing a late callback to resurrect it."""
    _prune_jobs(time.monotonic())
    job = _PREVIEW_JOBS.get(job_id)
    if job is None:
        return {"status": "expired", "job_id": job_id}
    if job["status"] == "pending":
        job["status"] = "cancelled"
        job["result"] = None
        job["error"] = None
    return _job_receipt(job_id, job)


def collect_preview_job(job_id):
    """Collect a deferred capture by id.

    Ready/error/cancelled results are one-shot (removed on collection); pending is
    non-consuming, and an unknown or TTL-expired id reports 'expired'.
    """
    _prune_jobs(time.monotonic())
    job = _PREVIEW_JOBS.get(job_id)
    if job is None:
        return {"status": "expired", "job_id": job_id}
    if job["status"] == "pending":
        return {"status": "pending", "job_id": job_id}
    receipt = _job_receipt(job_id, job)
    del _PREVIEW_JOBS[job_id]
    return receipt


def sample_grid(path, n=8):
    """Return an n×n grid of RGBA samples + per-channel stats for a TOP.

    A 10–50× cheaper alternative to a full preview when the agent only needs to know
    "is this output alive / roughly what colour is it" — no image is encoded, just
    n² pixel reads. NaN/Inf (from HDR/float TOPs) are sanitized to null so the result
    always JSON-serializes.
    """
    node = op(path)
    if node is None:
        raise LookupError("Node not found: %s" % path)
    if getattr(node, "family", None) != "TOP":
        raise ValueError("sample_grid is only supported for TOPs, got %s" % path)
    n = max(2, min(int(n), 16))
    arr = node.numpyArray(delayed=False)
    samples, width, height = _grid_from_array(arr, n)
    return {
        "path": node.path,
        "width": width,
        "height": height,
        "grid": n,
        "samples": samples,
        "stats": _channel_stats(samples),
    }
