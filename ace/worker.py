"""Killable per-generation worker: ``python -m ace.worker <job-spec.json>``.

Reads a JSON job spec ``{ "body": {...}, "out": "<path>" }`` from argv, runs
``ACEStepPipeline.__call__`` with the mapped kwargs, and writes the result JSON
(``{ wavPath, seconds, seed }`` or ``{ error }``) to the ``out`` path.

Isolating the generation in its own process is what lets the wrapper SIGKILL a
run to free VRAM in P1. In tests the pipeline import is patched, so this runs
offline with no GPU.
"""

from __future__ import annotations

import json
import os
import sys
import wave
from typing import Any, Optional


def _build_kwargs(body: dict[str, Any]) -> dict[str, Any]:
    """Map the wrapper request body to ``ACEStepPipeline.__call__`` kwargs.

    ``manual_seeds`` is scalar-or-null on the wire; ACE wants a list, so a set
    seed becomes ``[seed]`` and an omitted seed stays ``None`` (random).
    """
    manual_seeds = body.get("manual_seeds")
    seeds_arg: Optional[list[int]] = None
    if manual_seeds is not None:
        seeds_arg = [int(manual_seeds)]
    return {
        "prompt": body.get("prompt", ""),
        "lyrics": body.get("lyrics") or "",
        "audio_duration": float(body.get("audio_duration", -1)),
        "manual_seeds": seeds_arg,
        "infer_step": int(body.get("infer_step", 27)),
        "guidance_scale": float(body.get("guidance_scale", 15.0)),
        "save_path": body.get("save_path"),
        "format": "wav",
    }


def _first_wav(paths: Any) -> Optional[str]:
    """Pick the first ``.wav`` from the pipeline's returned path list."""
    if isinstance(paths, str):
        return paths
    if isinstance(paths, (list, tuple)):
        for item in paths:
            text = str(item)
            if text.lower().endswith(".wav"):
                return text
        if paths:
            return str(paths[0])
    return None


def _wav_seconds(path: Optional[str]) -> Optional[float]:
    """Realized clip duration read from the written WAV (soundfile-free)."""
    if not path or not os.path.exists(path):
        return None
    try:
        with wave.open(path, "rb") as handle:
            frames = handle.getnframes()
            rate = handle.getframerate()
            if rate:
                return frames / float(rate)
    except (wave.Error, OSError):
        return None
    return None


def _resolve_seed(kwargs: dict[str, Any], pipeline_result: Any) -> Optional[int]:
    """Resolve the seed actually used, preferring what the pipeline reports."""
    if isinstance(pipeline_result, dict) and pipeline_result.get("actual_seeds"):
        seeds = pipeline_result["actual_seeds"]
        if isinstance(seeds, (list, tuple)) and seeds:
            return int(seeds[0])
    seeds_arg = kwargs.get("manual_seeds")
    if isinstance(seeds_arg, (list, tuple)) and seeds_arg:
        return int(seeds_arg[0])
    return None


def generate(body: dict[str, Any]) -> dict[str, Any]:
    """Run the pipeline and return ``{ wavPath, seconds, seed }``.

    Split from ``main`` so a test can call it directly with a fake pipeline.
    """
    from acestep.pipeline_ace_step import ACEStepPipeline  # type: ignore

    pipeline = ACEStepPipeline(
        checkpoint_dir=os.environ.get("ACE_CHECKPOINT_DIR"),
        dtype=os.environ.get("TDMCP_ACE_DTYPE", "bfloat16"),
    )
    kwargs = _build_kwargs(body)
    result = pipeline(**kwargs)

    paths = result.get("output_paths") if isinstance(result, dict) else result
    wav_path = _first_wav(paths)
    seconds = _wav_seconds(wav_path)
    if seconds is None:
        seconds = float(body.get("audio_duration", -1))
    seed = _resolve_seed(kwargs, result)
    return {
        "wavPath": wav_path,
        "seconds": seconds if seconds is not None else 0.0,
        "seed": seed if seed is not None else 0,
    }


def main(argv: Optional[list[str]] = None) -> int:  # pragma: no cover - process entrypoint
    args = list(sys.argv[1:] if argv is None else argv)
    if not args:
        sys.stderr.write("usage: python -m ace.worker <job-spec.json>\n")
        return 2
    with open(args[0], "r", encoding="utf-8") as handle:
        spec = json.load(handle)
    out_path = spec["out"]
    try:
        payload = generate(spec["body"])
    except Exception as exc:  # noqa: BLE001 - surface as a terminal job error
        payload = {"error": str(exc)}
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
