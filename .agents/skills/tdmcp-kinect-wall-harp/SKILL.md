---
name: tdmcp-kinect-wall-harp
description: "Orchestrates the dedicated Kinect wall harp implementation team. Use whenever the user asks to build, implement, continue, fix, QA, document, or ship the Kinect wall harp, Kinect v2 wall-depth harp, FreenectTD depth-blob hand tracking, projected wall strings, pluck synth harp, or this feature's Layer 1 tool/recipe/docs. Use this before the generic tdmcp-pipeline for this feature."
---

# tdmcp-kinect-wall-harp - implementation orchestrator

Coordinate the dedicated team for the approved Kinect wall harp prototype. This
skill specializes the generic tdmcp pipeline for a physical Kinect v2 +
projector wall instrument where FreenectTD depth behavior, manual calibration,
two-hand blob tracking, internal audio, and honest live validation all matter.

## Execution mode

This repo documents that the current environment runs teams as coordinated
sub-agents rather than `TeamCreate`. Use a hybrid sub-agent workflow:

| Phase | Mode | Reason |
|---|---|---|
| Plan | local lead or `kinect-wall-harp-lead` | keep scope tied to the approved spec and wall setup. |
| Prototype + tool build | parallel sub-agents when write scopes are disjoint | live TD prototype and isolated tool file can advance separately. |
| Integrate/docs | single-writer sub-agent | registries, CLI, recipes, and docs are shared files. |
| QA/fix loop | sub-agent fan-in | QA routes precise defects to the owner; live hardware gets PASS / UNVERIFIED accounting. |

All spawned agents use the inherited model unless the user explicitly asks for a
different one.

## Agent roster

| Agent | Role | Skills | Output |
|---|---|---|---|
| `kinect-wall-harp-lead` | scope owner and wave captain | this skill | `_workspace/kinect-wall-harp/00_plan.md` |
| `kinect-wall-harp-prototyper` | live FreenectTD/Kinect wall prototype and calibration findings | tdmcp bridge/tools | `_workspace/kinect-wall-harp/01_prototype.md` |
| `kinect-wall-harp-tool-builder` | new Layer 1 tool file + focused unit test | `td-feature-build` | `_workspace/kinect-wall-harp/02_build_tool.md` |
| `kinect-wall-harp-integrator` | single-writer registry, CLI, recipe, docs | `td-feature-integrate` | `_workspace/kinect-wall-harp/03_integrate.md` |
| `kinect-wall-harp-qa` | offline gates, boundary QA, live TD/Kinect validation | `td-feature-qa` | `_workspace/kinect-wall-harp/04_qa.md` |

Use existing `tdmcp-bridge-engineer` only if implementation proves that a new
bridge REST endpoint is necessary. The default plan should avoid a new endpoint
and use the existing bridge execution path.

## Source of truth

Read these before changing code:

1. `docs/superpowers/specs/2026-06-23-kinect-wall-harp-design.md`
2. `CLAUDE.md`
3. Prior live Kinect validation notes from the current workspace/conversation if
   available: FreenectTD v1.0.1, `FreenectTOP`, Kinect v2 depth buffer at Render
   Select index `1`, point cloud index `2`, IR index `3`.
4. Nearby Layer 1 tools:
   - `src/tools/layer1/createBlobReactive.ts`
   - `src/tools/layer1/createMotionReactive.ts`
   - `src/tools/layer1/createProjectionMapping.ts`
   - audio-reactive or waveform tools under `src/tools/layer1/` when present.
5. Existing recipes that show visual/audio/reactive output patterns.

## Workflow

### Phase 0 - context check

1. Read `git status --short`.
2. Check `_workspace/kinect-wall-harp/`.
3. Decide run mode:
   - no workspace -> fresh run;
   - workspace exists + user says continue/fix/update -> resume only affected
     phase;
   - workspace exists + new feature direction -> archive the old folder with a
     timestamp before starting a new one.
4. Check TouchDesigner bridge with `/api/info` before any live prototype or QA
   claim.
5. Check whether `FreenectTOP` is registered if the bridge permits live probes.

### Phase 1 - plan the wave

Create `_workspace/kinect-wall-harp/00_plan.md` with:

- target slice: live prototype, Layer 1 tool, integration, recipe/docs, QA, or
  all;
- owner per slice;
- exact write scopes;
- expected commands/gates;
- live hardware assumptions;
- PASS / UNVERIFIED criteria for real Kinect wall tracking.

Default slice order:

1. live/synthetic prototype and calibration notes;
2. synthetic-safe Layer 1 tool;
3. CLI + optional recipe/docs;
4. offline QA;
5. live FreenectTD/Kinect wall QA when hardware and bridge are ready.

### Phase 2 - parallel prototype and isolated build

Run in parallel when both are in scope and write scopes are disjoint:

- `kinect-wall-harp-prototyper`: use the live bridge to build or validate
  `/project1/kinect_wall_harp`, prove the depth-wall mask, and record
  calibration/hand-channel findings. If bridge is offline, produce a live
  checklist instead.
- `kinect-wall-harp-tool-builder`: create only the new tool file and focused
  unit test. Do not edit shared files.

Both agents must write their `_workspace/kinect-wall-harp/0*_*.md` notes.

### Phase 3 - single-writer integration

Invoke `kinect-wall-harp-integrator` after the tool builder reports export
names. It owns all shared files:

- `src/tools/layer1/index.ts`;
- `src/cli/agent.ts`;
- `recipes/kinect_wall_harp.json` if the recipe slice is active;
- docs/cookbook pages if docs are active.

The integrator must run `npm run typecheck` and `npm run build`. If docs/recipes
changed, also run `npm run validate:recipes` and the docs generation/build gate
that matches the touched files.

### Phase 4 - QA and fix loop

Invoke `kinect-wall-harp-qa` incrementally:

1. schema/tool/test shape;
2. registry and CLI command;
3. recipe validation if touched;
4. docs honesty if touched;
5. synthetic live build when bridge is reachable;
6. real Kinect/FreenectTD wall-touch validation only when hardware is available.

QA sends precise defects to the owner and re-validates after fixes. Cap repeated
fix loops at 2-3 rounds, then report the blocker.

### Phase 5 - report and next wave

Report:

- files changed;
- commands run and outcomes;
- PASS / FAIL / UNVERIFIED buckets;
- whether the prototype is ready for physical calibration;
- what remains for a polished `.tox`, MIDI/OSC, or production audio.

Do not tag, release, or push unless the user explicitly asks.

## Data flow

```text
approved spec
  -> lead plan
  -> live prototype notes -----+
  -> isolated tool builder ----+-> integrator -> qa -> fixes -> final report
```

## Error handling

| Situation | Strategy |
|---|---|
| Bridge offline | Build/test offline; mark live checks UNVERIFIED pending bridge. |
| FreenectTD unavailable | Keep synthetic fallback green; report plugin install/load state. |
| Kinect connected but depth not cooking | Stop live claims; surface raw node errors and next hardware checks. |
| Two blobs merge | Treat as one blob and document limitation; do not claim two-hand pass. |
| Shared-file conflict | Stop shared edits and ask the lead to reconcile. |
| QA fail after 3 rounds | Hold failing slice; report evidence and next fix. |

## Test scenarios

### Normal flow

User says "implementar a harpa Kinect." The orchestrator reads the approved
spec, creates `_workspace/kinect-wall-harp/00_plan.md`, runs prototype and tool
build slices, integrates the tool and CLI, runs typecheck/build/focused tests,
validates synthetic TD output if the bridge is up, and reports live Kinect wall
tracking as PASS or UNVERIFIED.

### Error flow

The bridge is up but `FreenectTOP` is not registered. The orchestrator still
builds the synthetic-safe tool and docs, QA marks FreenectTD/Kinect checks
UNVERIFIED, and the final report names the exact plugin/load step to rerun.

## Trigger validation

Should trigger:

- "implemente a harpa Kinect"
- "continue o kinect wall harp"
- "vamos fazer as cordas projetadas com Kinect"
- "arrume o tracking das maos da harpa"
- "QA da harpa Kinect"
- "documenta a feature Kinect wall harp"
- "faz o Layer 1 tool da harpa de parede"
- "plucked synth com FreenectTD e depth blobs"

Should not trigger:

- generic Kinect setup question with no implementation request;
- unrelated projection mapping feature work;
- Soundcraft Ui24R mixer scene work;
- broad backlog campaign across many features;
- test coverage work not specific to this feature;
- directory/MCPB submission work.
