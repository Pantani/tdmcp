# Local ComfyUI + LTX-Video for `create_ai_video`

The `comfyui` provider of `create_ai_video` / `create_ai_video_backdrop` runs
**LTX-Video locally on your GPU — zero cost per generation, fully offline**. It is a
plain HTTP client to a running ComfyUI server; it does **not** use the TD-side
frame-streaming bridge that `connect_comfyui` builds. It POSTs an API-format
workflow to `/prompt`, polls `/history`, and downloads the finished mp4 from `/view`.

This folder ships a matching workflow: [`ltx-video-t2v.api.json`](./ltx-video-t2v.api.json).

## 1. Requirements (one-time)

- **GPU:** NVIDIA ~24 GB VRAM (you have this). LTX-Video 2B fits comfortably.
- **ComfyUI** installed and launchable (`python main.py`, serves `http://127.0.0.1:8188`).
- **Custom node:** [ComfyUI-VideoHelperSuite](https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite)
  (provides `VHS_VideoCombine`, the mp4 saver this workflow uses).
- **Model weights** in `ComfyUI/models/checkpoints/` — an LTX-Video checkpoint, e.g.
  `ltx-video-2b-v0.9.5.safetensors` (from Lightricks' Hugging Face repo).

  **License (verified):** LTX-Video 2B is Apache-2.0 code with OpenRAIL-M weights;
  the newer **LTX-2** ships open weights under the **LTX-2 Community License** — free
  for academic use and for commercial/production use by organizations **under $10M
  ARR**, no usage/token/inference fees. Above $10M ARR needs a commercial license.
  Running locally is free per generation regardless. (Sources: Lightricks/LTX-2
  `LICENSE`; Lightricks LTX-2 open-weights announcement, Jan 2026.)

> If your checkpoint filename differs, edit node `"8".inputs.ckpt_name` in the JSON.

## 2. Point tdmcp at it

```bash
export TDMCP_VIDEO_GEN_PROVIDER=comfyui
export TDMCP_COMFYUI_URL=http://127.0.0.1:8188          # default; override if remote
export TDMCP_COMFYUI_VIDEO_WORKFLOW=/abs/path/to/assets/comfyui/ltx-video-t2v.api.json
export TDMCP_VIDEO_GEN_MODEL=ltx-video                  # default
```

## 3. How injection works (why this JSON is shaped this way)

The provider is tolerant of node ids — it injects by **well-known input keys**, so any
API-format LTX graph works as long as it exposes them:

| Request field | Injected into | Node in this workflow |
|---|---|---|
| `prompt` | any node with a `text` input | `"6"` CLIPTextEncode (Positive) |
| `negative_prompt` | a `text` node whose `_meta.title` contains "negative" | `"7"` CLIPTextEncode (Negative) |
| `seed` / `steps` / `guidance_scale` | `seed` / `steps` / `cfg` | `"3"` KSampler |
| `duration_seconds` | `length` (**FRAMES**, converted `sec*24` → `k*8+1`) | `"10"` EmptyLTXVLatentVideo |
| `init_image` (i2v) | `image`, after `/upload/image` | add a `LoadImage` node (see below) |

Output is read from the first `videos[]`/`gifs[]` entry in `/history` — `VHS_VideoCombine`
emits an mp4 there.

> **Frames, not seconds.** LTX's latent `length` is a frame count and must satisfy
> `length % 8 === 1`. The provider converts `duration_seconds` for you (5 s → 121 frames
> at 24 fps). `ltx-video` base is fixed ~5 s; the schema rejects other durations for it.

## 4. Image-to-video (optional)

For `init_image` (still → animate), add a `LoadImage` node (its `image` input is filled
with the uploaded filename) and feed it through an `LTXVImgToVideo` conditioning node in
place of `EmptyLTXVLatentVideo`. Keep the `text` / `seed` / `steps` / `cfg` / `length`
keys exposed so injection still lands. Export via **Save (API Format)**.

## 5. Test it

The tools run through the **agent CLI** (`src/cli/agent.ts`, bin `tdmcp-agent`), NOT the
server entry (`src/index.ts`). Args are one JSON object via `--params`.

**Step A — offline sanity (no ComfyUI, no TouchDesigner).** Confirms the command,
schema, and defaults resolve:

```bash
npx tsx src/cli/agent.ts create-ai-video \
  --params '{"prompt":"a slow neon bloom unfurling in the dark"}' --dry-run
```

**Step B — ComfyUI reachable + custom node installed:**

```bash
curl -s http://127.0.0.1:8188/object_info/VHS_VideoCombine | head -c 80   # non-empty = installed
```

**Step C — real local generation (ComfyUI running, LTX weights loaded).** With the env
from §2 exported (`TDMCP_VIDEO_GEN_PROVIDER=comfyui`, `TDMCP_COMFYUI_VIDEO_WORKFLOW=…`),
run for real — this generates the clip AND creates the TD node, so a **TouchDesigner
bridge must also be up** (`127.0.0.1:9980`):

```bash
npx tsx src/cli/agent.ts create-ai-video \
  --params '{"prompt":"a slow neon bloom unfurling in the dark","duration_seconds":5}'
```

The JSON result includes the cached `.mp4` path and the created `moviefileinTOP` — proof
the local lane works end to end. The wired backdrop variant is `create-ai-video-backdrop`.

> Provider is chosen by `TDMCP_VIDEO_GEN_PROVIDER` (config), not a CLI arg — export it
> before running. Override the bridge for one call with `--td-host` / `--td-port`.

## Probe-first (verify on first real run)

- Exact `EmptyLTXVLatentVideo` / sampler node names for your ComfyUI + LTX version.
- `VHS_VideoCombine` history JSON puts the file under `gifs[]` vs `videos[]` (the provider
  reads either).
- `moviefileinTOP` first-frame hitch / H.264 decode cost on a freshly written clip.
