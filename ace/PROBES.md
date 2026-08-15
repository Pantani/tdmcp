# ACE-Step live-probe runbook

The tdmcp ACE-Step integration (P0+P1+P2) is fully built and green on **offline**
gates, but a set of claims can only be confirmed against a real ACE-Step server +
GPU (and, for the reactive tool, a running TouchDesigner bridge). This file maps
every `UNVERIFIED — probe live` item to the exact command that resolves it and the
pass criterion. Run it on a machine that has: an NVIDIA GPU (or Apple-Silicon MPS),
`acestep` installed, and — for P-6 — TouchDesigner with the tdmcp bridge on `:9980`.

## Prerequisites

```bash
# 1. Install ACE-Step per its README (github.com/ace-step/ACE-Step) — needs torch + CUDA/MPS.
python3 -c "import acestep, torch; print('cuda', torch.cuda.is_available())"

# 2. Install the wrapper's server deps (into the SAME env as acestep):
pip install fastapi uvicorn

# 3. Start the tdmcp-owned warm-pipeline wrapper (loads the model ONCE):
export TDMCP_ACE_CHECKPOINT_DIR=/path/to/ACE-Step/checkpoints   # if not default
python3 -m uvicorn ace.wrapper:app --host 127.0.0.1 --port 8000

# 4. Point tdmcp at it and enable the feature:
export TDMCP_ACE_ENABLED=1
export TDMCP_ACE_HOST=127.0.0.1 TDMCP_ACE_PORT=8000
export TDMCP_ACE_OUTPUT_DIR="$(pwd)/_ace_out"    # ABSOLUTE — TD must read it too
mkdir -p "$TDMCP_ACE_OUTPUT_DIR"
```

> NOTE: `:8000` in some environments is an unrelated JSON-RPC service. Confirm the
> wrapper is the thing answering: `curl -s localhost:8000/health` must return the
> `ace/wrapper.py` health JSON (`{status, model_loaded, ...}`), not a `jsonrpc` error.

## Probes

| # | Claim under test | Command | PASS criterion |
|---|---|---|---|
| **P-1** | Warm-cache: the pipeline loads ONCE, not per request | Hit `/health`, then time two back-to-back `generate_music` calls | First call pays model-load; 2nd is much faster; `health.model_loaded==true` stays true; only one load line in the server log |
| **P-2** | Sync-branch round-trip: `generate_music` (mode sync) returns real `{wavPath,seconds,seed}` and leaks no job | `tdmcp ... music generate --prompt "lofi hip hop, mellow" --audio_duration 8` | Returns a real playable WAV at `wavPath` under `TDMCP_ACE_OUTPUT_DIR`; `seconds≈8`; `GET /jobs` shows the job cleaned up (no dangling entry) |
| **P-3** | Async job lifecycle: submit → poll → done | `music submit ...` → capture `job_id` → `music job <job_id>` until done | Status goes `queued/running → done`; `wavPath` on done matches a real file |
| **P-4** | Cancel frees VRAM: `cancel_music_job` kills the worker | Start a long `music submit --audio_duration 240`; `nvidia-smi` mid-run; `music cancel <job_id>`; `nvidia-smi` after | Worker PID gone; GPU mem returns to the warm-pipeline baseline (not zero — the warm model stays); job status `cancelled` |
| **P-5** | `observed_rtf` accuracy → F6 calibration | Read `observed_rtf` from a sync `music generate`; set `TDMCP_ACE_RTF` to it; run `mode:auto` with a long duration | With RTF set, `auto` routes a >`TDMCP_ACE_SYNC_MAX_SECONDS` estimate to `job`; a short one stays `sync` |
| **P-6** | End-to-end reactive: generated WAV drives a TD network | With TD bridge up on `:9980`: `music reactive --prompt "driving techno, 128bpm" --audio_duration 16` | An `audiofilein` CHOP in TD points at the generated WAV; the reactive network cooks; preview image returned; no post-cook errors |
| **P-7** | Progress → client timeout reset (the honesty gate) | Run `generate_music` under an MCP client that surfaces `notifications/progress`, with a duration long enough to approach the client's tool-call timeout | If the client resets its timeout on progress and the call completes → progress IS a timeout extension (update CHANGELOG to say so). If it times out anyway → progress stays "informational only"; keep the current caveat |
| **P-8** | Native mode shape: `TDMCP_ACE_MODE=native` against `infer-api.py` | Start ACE's own `infer-api.py` on `:8000`; `export TDMCP_ACE_MODE=native`; `music generate ...`; then `music submit ...` | `generate` works and adapts `ACEStepOutput`; the job tools return a friendly "not supported in native mode" errorResult (never throw) |

## After a passing run

- Move the confirmed items out of the `UNVERIFIED — probe live` lists in
  `CHANGELOG.md` and `docs/ROADMAP.md` (Milestone 4b), graduating 🧪 → ✅.
- For **P-7 specifically**: only claim "progress extends the tool-call timeout"
  in the CHANGELOG if the probe confirms the client actually resets it. Until
  then the wording stays "client-dependent / informational."
- Record the machine + GPU + `observed_rtf` per tier so the RTF default can be
  documented per hardware class.
