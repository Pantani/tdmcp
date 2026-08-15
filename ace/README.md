# `ace/` — tdmcp ACE-Step warm-pipeline wrapper

A minimal local FastAPI service that holds ONE warm
[`ACEStepPipeline`](https://github.com/ace-step/ACE-Step) and exposes it to the
tdmcp `generate_music` tool. Same-machine, headless, offline bed generator — not
real-time. Mirrors the `td/` bridge ethos: plain Python modules, no binary
artifact, a one-line install/run note.

## Why a wrapper (not native `infer-api.py`)

The native `infer-api.py` is `:8000`, sync, no-auth, **cold-loads** the model
inside `/generate`, and is text2music-only. This wrapper keeps the model **warm**
in a module global (loaded once at startup) and adds optional bearer auth.

Two execution paths, by design:

- **Sync `POST /generate`** runs the generation **in-process on the warm global
  pipeline** — reusing the loaded model, no subprocess. This is what the warm
  wrapper is for: no per-request cold load, no VRAM doubling.
- **Async `/jobs` (submit/poll/cancel)** runs each generation in a **killable
  worker subprocess** so `cancel` can SIGKILL it to free VRAM (ACE has no
  in-pipeline abort). Warmth and killability can't coexist on one process, so an
  async job deliberately pays a cold load as the cost of being cancellable.

The native server is the demoted `TDMCP_ACE_MODE=native` on-ramp (out of P0 scope).

## Install & run

```bash
pip install ace-step fastapi uvicorn        # ACE-Step + the wrapper deps
export ACE_CHECKPOINT_DIR=/path/to/checkpoints   # optional; ACE resolves a default otherwise
python -m ace.wrapper                        # serves on 127.0.0.1:8000
```

Configure the tdmcp side with the `TDMCP_ACE_*` env block (see
`src/utils/config.ts`): set `TDMCP_ACE_ENABLED=1`, and optionally
`TDMCP_ACE_HOST`/`TDMCP_ACE_PORT` (default `127.0.0.1:8000`),
`TDMCP_ACE_OUTPUT_DIR`, `TDMCP_ACE_TOKEN` (bearer, off-loopback),
`TDMCP_ACE_TIMEOUT_MS` (default 600000 = 10 min), and `TDMCP_ACE_DEFAULT_STEPS`
(default **27** — the tdmcp faster default; ACE upstream is 60).

## Endpoints

- `POST /generate` — body
  `{ prompt, lyrics?, audio_duration, manual_seeds?, infer_step, guidance_scale, save_path }`.
  Maps to `ACEStepPipeline.__call__` (scalar `manual_seeds` → `[seed]`), reads the
  **actual written path** back, and returns `{ wavPath, seconds, seed }`.
- `GET /health` — `{ status, model_loaded, device }`; `model_loaded` reflects
  whether the warm global pipeline finished constructing.

`save_path` is injected by the tdmcp client from `TDMCP_ACE_OUTPUT_DIR`; the
wrapper reports the real path it wrote (never predicted).

## Auth

If `TDMCP_ACE_TOKEN` is set in the wrapper's env, both routes require
`Authorization: Bearer <token>`. Loopback default: unset → open.

## Tests (offline, no GPU)

```bash
python -m unittest ace.tests.test_wrapper
```

The pipeline import is patched with a fake, so request-mapping and `/health` are
exercised without the model or a GPU.

## Probe-first (UNVERIFIED — validate on a live install)

Warm-cache residency (loads once, not per request), VRAM coexistence with TD on
the same GPU, per-tier RTF, and the exact `wavPath`/`seconds`/`seed` round-trip
against a live wrapper. None block the offline build.
