---
name: acestep-explore
description: "Explore ONE axis of integrating the ACE-Step music-generation model into tdmcp — enumerate every viable implementation option on that axis (runtime/serving, async tool contract, TD audio integration, GPU/perf coexistence, or tool/UX surface), ground each in the real tdmcp source and a verifiable ACE-Step source, score its trade-offs, and emit a structured option report to _workspace/acestep-study/. Use when an acestep-explorer agent is scouting one axis during the tdmcp-acestep-study harness."
---

# acestep-explore — enumerate & score one implementation axis

You are exploring **one** axis of putting **ACE-Step** (Apache-2.0 diffusion+linear-transformer music generator; text/tags/lyrics → WAV up to ~4 min; GPU-bound; ships a Gradio app, a `pip`/Python API, and Docker) behind **tdmcp** (Node/TS MCP server → Python TD bridge; tools must never throw and must stay usable when the external service is offline). Breadth + grounding is the goal; `acestep-study-synthesizer` reconciles and decides later. The user explicitly asked to explore *all* implementation types — enumerate the option space, don't converge early.

## Procedure

### 1. Confirm the axis
Your assignment is one of `runtime`, `async-contract`, `td-integration`, `gpu-perf`, `tool-surface`. Explore only that axis. If a strong option belongs to another axis, drop a one-line "cross-axis" footnote — don't work it up.

### 2. Ground the ACE-Step facts (once, at the start)
Confirm what ACE-Step actually offers before designing on top of it. Read the source of truth — the GitHub repo `github.com/ace-step/ACE-Step` (README, `docker-compose.yaml`, `acestep` CLI flags, any `infer`/API docs) — via WebFetch/WebSearch or Context7. Pin down: serving surfaces (Gradio `--port`, Python API, Docker), inputs (tags/genre prompt, `[verse]`/`[chorus]` lyrics, duration, seed, reference audio for edit/extend/repaint modes), outputs (WAV path), and hardware (8GB VRAM floor with CPU offload; A100/4090/3090 recommended; M2 Max fallback; RTF figures). **Cite every claim.** Mark anything unconfirmed `UNVERIFIED — probe live`.

### 3. Inventory the tdmcp side of your axis
Read the real source so every option maps to a concrete pattern that already exists. Axis map below. The house patterns you'll mirror:
- **External-service client** → `src/td-client/touchDesignerClient.ts` (typed methods, one per REST endpoint), envelopes Zod-validated in `src/td-client/validators.ts`, typed errors in `types.ts` (`TdApiError`/`TdConnectionError`/`TdTimeoutError`).
- **Tool file pattern** → `…Impl(ctx, args)` (pure, msw-testable) **and** `register…: ToolRegistrar`; never throw, `errorResult`/`guardTd`/`runBuild` for failures (`src/tools/result.ts`).
- **DI** → `ToolContext` assembled in `buildToolContext` (`src/server/context.ts`); a new `aceClient` would be added here.
- **Orchestration** → `src/tools/layer2/orchestration.ts` (`NetworkBuilder`, `finalize` = create → verify → preview).
- **Config** → `src/utils/config.ts`, all vars `TDMCP_*`.
- **Events** → the TD WebSocket → MCP logging-notification forwarding (`TDMCP_EVENTS`) is the precedent for progress streaming.

### 4. Axis map — where to look

| Axis | tdmcp source to read | Core question |
|---|---|---|
| **runtime** | `src/td-client/*` (client+validators+types), `td/` (how the TD bridge is served), `docs/reference/architecture.md` | How is ACE-Step hosted and called, and how does a `src/ace-client/` mirror the TD client? |
| **async-contract** | `src/tools/result.ts`, a Layer-1 tool + `orchestration.ts`, the events forwarding in the server, `src/cli/agent.ts` | What MCP tool contract survives a minutes-long generation without throwing or blocking? |
| **td-integration** | `src/tools/layer1/createAudioReactive*`, `src/tools/layer2/orchestration.ts`, `recipes/` + `src/recipes/schema.ts`, the `audiofilein` KB entry | How does the WAV become an `audiofilein` CHOP driving the reactive network, incl. loop/extend? |
| **gpu-perf** | `docs/reference/architecture.md`, `CLAUDE.md` (same-machine assumption), any perf/preview notes | Can TD render and ACE-Step inference share one GPU, and what's the honest live verdict? |
| **tool-surface** | `src/tools/layer{1,3}/` (tool shapes), `src/utils/config.ts`, `src/prompts/`, `src/cli/agent.ts` | Which tools/config/CLI/prompts to expose, and how do they degrade offline? |

### 5. Enumerate the option space
List **every** viable option on your axis a competent engineer would weigh — then score. Examples of the breadth expected (illustrative, not exhaustive, not a checklist to copy):
- `runtime`: Gradio HTTP `/api/predict`, `gradio_client`, thin FastAPI wrapper, subprocess/CLI, Docker-Compose service, ComfyUI graph, remote GPU box.
- `async-contract`: sync + long timeout (short clips), job-submit + `get_*_job` poll, progress via MCP logging notifications, hybrid (sync under N seconds, else job).
- `td-integration`: reuse `createAudioReactive`, new `audiofilein` placement, seamless-loop via extend/repaint, recipe template, live re-trigger on new file.
- `gpu-perf`: generate-then-play (sequential), concurrent with VRAM budget, CPU-offload tier, MPS/Mac path, remote-GPU offload, pre-render queue.
- `tool-surface`: Layer 1 `generate_music_reactive`, Layer 3 `generate_music`, `generate_music_loop`, `extend`/`repaint`, lyric/voice edit, `TDMCP_ACE_*` config, CLI command, prompt.

### 6. Trade-off dimensions (score every option on all six)
| Dimension | Question |
|---|---|
| **Latency** | Time-to-first-audio; does it block the MCP call? |
| **Stability** | How brittle is the contract across ACE-Step / Gradio / dep versions? |
| **Maintenance** | How much tdmcp-side code to own and keep working? |
| **Offline degradation** | What happens when ACE-Step is down? (must be a friendly `errorResult`, never a throw) |
| **Hardware reach** | Consumer GPU / 8GB / Mac / remote — who can actually run it? |
| **UX** | Artist-facing simplicity; setup friction; fits the live-show thesis? |

### 7. Entry format
Write each option exactly like this so the synthesizer can parse it:

```
### <option_name>
- **What:** <one line — the implementation approach>
- **Wires into tdmcp via:** <concrete files/patterns — e.g. new src/ace-client/aceStepClient.ts mirroring touchDesignerClient.ts; Zod envelope in validators.ts>
- **Latency:** <note>   **Stability:** <note>   **Maintenance:** <note>
- **Offline degradation:** <what the user sees when ACE-Step is down>
- **Hardware reach:** <who can run it>
- **UX:** <artist-facing note>
- **Effort:** S | M | L   <!-- S ≤1 day · M 2–4 days · L ~1 week -->
- **Confidence:** High | Med | Low   <!-- High = grounded in confirmed tdmcp pattern AND confirmed ACE-Step capability -->
- **Probe-first risk:** <what must be validated live before locking the API — or "none">
```

## Output

Write the file **incrementally** so a mid-run interruption still leaves usable partial work: create `_workspace/acestep-study/01_explore_<axis>.md` early with its header, then append each option as you confirm it.

The finished file contains:
1. A one-line header naming the axis and the ACE-Step facts you pinned (with citations).
2. The option entries.
3. An **axis recommendation**: the option(s) you'd carry forward and the trade-off you accepted.
4. A closing **tally**: option count, count by effort, count by confidence.
5. A short **cross-axis** footnote list, if any.

## Quality bar

- **Enumerate before you judge.** A report with one option fails the brief; the point is the full option space on your axis.
- **Trade-offs stated directly.** Name the real downside of every option — the synthesizer decides on the honest costs.
- **Ground both sides.** Every option cites a tdmcp file/pattern it mirrors AND a verifiable ACE-Step fact. No hand-waving on either side.
- **Offline-first is a gate.** Score every option against tdmcp staying usable when ACE-Step is down.
- **Confidence honestly.** High only when both the tdmcp pattern and the ACE-Step capability are confirmed; drop to Med/Low and flag `UNVERIFIED — probe live` otherwise.
