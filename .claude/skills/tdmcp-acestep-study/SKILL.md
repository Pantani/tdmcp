---
name: tdmcp-acestep-study
description: "Explore ALL ways to implement the ACE-Step music-generation model inside tdmcp and produce a decision-grade study. Use whenever the user wants to study, explore, scope, or compare how to integrate ACE-Step (github.com/ace-step/ACE-Step, AI music generation) into tdmcp — 'como implementar ACE-Step', 'explorar todos os tipos de implementação', 'estudar integração de geração de música', 'começar o estudo do ACE-Step'. ALSO for every follow-up: continue/re-run the study, re-explore one axis, deepen a trade-off, re-decide the reference architecture after new info, or refresh an ACE-Step claim after a release. This is the EXPLORATION/IDEATION harness — it produces a STUDY.md with a recommended architecture + phased build plan; it does NOT build. Once the path is chosen, hand the P0 slice to tdmcp-pipeline. Simple questions can be answered directly."
---

# tdmcp-acestep-study — orchestrate the ACE-Step implementation study

**Goal:** explore *all* the ways ACE-Step (AI music generation) could be implemented inside tdmcp, across five coupled axes, and converge on one decision-grade `STUDY.md` — a per-axis option matrix, a recommended reference architecture, a minimum-viable atomic slice, and a phased build plan handoff-ready to `tdmcp-pipeline`. This harness **studies and decides; it does not build.**

**Execution mode:** sub-agents (this environment runs the team as sub-agents — no `TeamCreate`). Fan-out/fan-in: 5 parallel `acestep-explorer`s (one per axis) → 1 `acestep-study-synthesizer`. All agents spawned with the `Agent` tool, `model: "opus"`, `run_in_background: true` for the parallel wave.

## Phase 0 — context check

Decide the run mode before spawning:
- `_workspace/acestep-study/` **absent** → **initial run** (Phase 1 full fan-out).
- present + user asks to **re-explore/deepen one axis** → **partial re-run**: re-spawn only that `acestep-explorer`, then re-run the synthesizer.
- present + user gives **new info / a new release to fold in** → move `_workspace/acestep-study/` → `_workspace/acestep-study_prev/`, then initial run.
- present + user asks to **re-decide / re-prioritize** only → re-spawn just the synthesizer over the existing explorations.

Report the detected mode in one line before proceeding.

## Phase 1 — fan-out: explore all five axes (parallel)

Spawn **five** `acestep-explorer` sub-agents in a single message (so they run concurrently), each with `model: "opus"`, `run_in_background: true`, and exactly one axis assignment:

| Axis | Owns |
|---|---|
| `runtime` | how ACE-Step is hosted & called (Gradio HTTP, gradio_client, FastAPI wrapper, subprocess/CLI, Docker, ComfyUI, remote GPU) + the `src/ace-client/` client shape |
| `async-contract` | the MCP tool contract for a minutes-long generation (sync+timeout, job+poll, progress notifications, hybrid) |
| `td-integration` | WAV → `audiofilein` CHOP → reuse `createAudioReactive`/`orchestration.ts`; loop/extend/repaint; recipe fit |
| `gpu-perf` | single-GPU contention (TD render vs diffusion), generate-then-play vs concurrent, VRAM tiers, Mac/remote fallback, live verdict |
| `tool-surface` | which tools/config (`TDMCP_ACE_*`)/CLI/prompts to expose + offline-degradation UX |

Each explorer loads the `acestep-explore` skill, grounds ACE-Step facts against `github.com/ace-step/ACE-Step` (cite), inventories the real tdmcp source for its axis, enumerates the full option space, scores trade-offs, and writes `_workspace/acestep-study/01_explore_<axis>.md`.

**Prompt each explorer with:** its axis string, the path to write, the reminder to load `acestep-explore` first, and the hard constraints (never-throw handlers, offline-usable, same-machine, house file pattern). Keep scopes disjoint per the axis boundaries.

## Phase 2 — fan-in: synthesize the study

After all five explorations land (collect the background results), spawn one `acestep-study-synthesizer` (`model: "opus"`, foreground). It loads `acestep-synthesize`, reads all `01_explore_*.md`, reconciles cross-axis dependencies, and writes `_workspace/acestep-study/STUDY.md` with the recommended reference architecture, MVP slice, phased plan, and probe-first risk checklist.

If an exploration file is missing or a background agent failed, retry that explorer **once**; if it fails again, proceed and have the synthesizer note the coverage gap (don't block the whole study on one axis).

## Phase 3 — relay & offer the handoff

Relay the synthesizer's summary to the user: the recommended architecture (one line per axis), the MVP slice, and the first build phase. Then offer the two natural next steps:
- **build it** → hand the P0 slice to `tdmcp-pipeline` (design→build→integrate→QA→release for the atomic `generate_music` tool + `src/ace-client/`).
- **go deeper** → partial re-run of any axis, or a live probe against a real ACE-Step server / GPU / TouchDesigner.

Do **not** start building from this harness — it ends at the study. Building is `tdmcp-pipeline`'s job.

## Data flow

- **File-based** (sub-agent mode): all intermediate artifacts under `_workspace/acestep-study/`. Convention: `01_explore_<axis>.md` (explorers) → `STUDY.md` (synthesizer). Middle files are preserved for audit.
- **Return-value-based**: the synthesizer's prose summary is what the orchestrator relays.

## Error handling

- A background explorer dies → retry once; on second failure, synthesize from the axes present and note the gap (never invent an axis's findings).
- An ACE-Step capability can't be confirmed → it stays in the study flagged `UNVERIFIED — probe live`, carried into the risk checklist; it is not dropped or oversold.
- Explorers conflict across axes → the synthesizer resolves it in cross-axis reconciliation, picks one, and states why.

## Test scenarios

- **Normal flow:** "explorar todos os tipos de implementação do ACE-Step no tdmcp e começar o estudo" → Phase 0 detects initial run → 5 explorers fan out → synthesizer writes `STUDY.md` → relay + offer `tdmcp-pipeline` handoff.
- **Follow-up flow:** "aprofunda o eixo de GPU/performance" → Phase 0 detects partial re-run → re-spawn only the `gpu-perf` explorer → re-run synthesizer → relay the updated decision.
- **Error flow:** the `runtime` explorer times out twice → synthesizer proceeds over the other four axes and records `runtime` as a coverage gap in `STUDY.md`.
