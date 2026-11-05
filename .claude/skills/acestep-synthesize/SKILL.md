---
name: acestep-synthesize
description: "Consolidate the five ACE-Step-in-tdmcp axis explorations into one decision-grade STUDY.md — reconcile cross-axis dependencies, build a per-axis option matrix, choose ONE recommended reference architecture end-to-end, define the minimum-viable atomic slice, phase the build against real tdmcp files, and carry every probe-first risk into a checklist handoff-ready to tdmcp-pipeline. Use when the acestep-study-synthesizer agent consolidates explorations during the tdmcp-acestep-study harness."
---

# acestep-synthesize — reconcile axes into one reference architecture

You consolidate five axis explorations (`runtime`, `async-contract`, `td-integration`, `gpu-perf`, `tool-surface`) into the study the user asked for: **how to implement ACE-Step in tdmcp**, deciding one path without hiding the alternatives. The explorers enumerated options with honest trade-offs; you cross-reconcile and **decide**.

## Procedure

### 1. Read the inputs
All five `_workspace/acestep-study/01_explore_*.md`, plus `CLAUDE.md` and `docs/reference/architecture.md`. If a file is missing, proceed and record the coverage gap.

### 2. Build the per-axis option matrix
One table per axis: rows = options, columns = Latency / Stability / Maintenance / Offline / Hardware / Effort / Confidence. This is the "whole space at a glance" the reader needs before your recommendation.

### 3. Reconcile cross-axis dependencies (the core reasoning)
The axes are coupled — score options as a *stack*, not in isolation:
- **runtime → async-contract:** a subprocess/CLI runtime forces a job model; a warm FastAPI wrapper can serve short clips synchronously.
- **gpu-perf → td-integration:** if a single GPU can't run TD render + inference concurrently, `td-integration` MUST be generate-then-play, and any "live jam" option is struck.
- **runtime → tool-surface:** the client shape (`src/ace-client/`) and `TDMCP_ACE_*` config follow from how the service is hosted.
- **async-contract → tool-surface + CLI:** a job model implies a `get_music_job` poll tool and a CLI that polls; a sync model doesn't.
Make each binding coupling explicit. An option that wins its own axis but conflicts with a neighbour loses — say so.

### 4. Choose ONE reference architecture
Pick a single coherent end-to-end stack (one option per axis that cohere) and state the trade-off accepted vs. the runner-up in a line. This is the headline deliverable. Anchor the choice in the project thesis (live AV/VJ, artist-easy install, offline-degradable) — not generic elegance.

### 5. Define the minimum-viable slice
The smallest atomic tool that proves the riskiest contract before any orchestration: a Layer 3 `generate_music(prompt, duration, seed) → { wavPath }` calling `aceClient`, with an offline msw test. Everything else composes on top. Name its exact files.

### 6. Phase the build (risk-first, handoff-ready)
Sequence phases so coupled/risky pieces validate first. Each phase names a concrete file set in the tdmcp pattern. Suggested spine (adapt to what the explorers found):
- **P0 — contract slice:** `src/ace-client/aceStepClient.ts` + `validators.ts` envelope + `TDMCP_ACE_*` in `config.ts` + Layer 3 `generate_music` + msw test. Probe against a real ACE-Step server.
- **P1 — TD handoff:** WAV → `audiofilein` CHOP; reuse `createAudioReactive`; live-validate cook + preview in TD.
- **P2 — Layer 1 orchestration:** `generate_music_reactive` via `orchestration.ts` (build → verify → preview); optional recipe.
- **P3 — depth:** `generate_music_loop` / extend / repaint; CLI command; prompt.
Mark each phase's gating probe-first risk.

### 7. Risk checklist
Collect every `UNVERIFIED — probe live` and every "must validate against real ACE-Step / real GPU / TouchDesigner" into one explicit checklist, ordered so the earliest phase's risks are validated first.

## Output — `_workspace/acestep-study/STUDY.md`

1. **Executive summary** — the recommended stack in under a minute: one line per axis + the MVP slice + the first phase.
2. **Per-axis option matrices** (§2).
3. **Cross-axis reconciliation** (§3) — the couplings and what they struck out.
4. **Recommended reference architecture** (§4) — the chosen stack, a small ASCII data-flow diagram (MCP client → tdmcp → ace-client → ACE-Step server → WAV → TD bridge → audiofilein → reactive net), and the runner-up in a line.
5. **Minimum-viable slice** (§5) — exact files.
6. **Phased build plan** (§6) — a table: phase / deliverable / file set / gating probe.
7. **Probe-first risk checklist** (§7).
8. **Handoff** — the P0 slice phrased so it hands straight to `tdmcp-pipeline`.

Also return a tight self-contained prose summary for the orchestrator to relay: the recommended architecture, the MVP slice, and the first build phase.

## Quality bar

- **Decide, don't co-recommend.** One reference architecture, one MVP slice, one phase order. Runner-up gets a line, not equal billing.
- **Honesty over impressiveness.** If the honest verdict is "offline bed generator, not a live real-time jam," lead with it — it reshapes the design.
- **Hard gates.** A recommendation that breaks never-throw, offline-usable, same-machine, the `…Impl`+`register…` pattern, `TDMCP_*` config, or Zod envelopes is wrong regardless of other merits.
- **Skimmable.** Matrices over prose; the exec summary must stand alone.
- **Handoff-ready.** The P0 slice must be phrased so `tdmcp-pipeline` can build it without re-deriving the design.
