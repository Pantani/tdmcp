---
name: tdmcp-interactive-projection-mapping
description: "Orchestrates the dedicated interactive projection mapping implementation team. Use whenever the user asks to build, implement, continue, fix, QA, document, or ship create_interactive_projection_mapping, interactive_projection_mapping, USB webcam/projector projection mapping, optical-flow hand interaction, blob/post-it tracking, or this feature's recipe/docs. For this feature, use this skill before the generic tdmcp-pipeline."
---

# tdmcp-interactive-projection-mapping - implementation orchestrator

Coordinate the dedicated team for the approved interactive projection mapping
feature. This skill specializes the generic tdmcp pipeline for a physical
camera/projector feature where synthetic tests, live TD checks, and honest
calibration language all matter.

## Execution mode

This repo documents that the current environment runs teams as coordinated
sub-agents rather than `TeamCreate`. Use a hybrid sub-agent workflow:

| Phase | Mode | Reason |
|---|---|---|
| Plan | local lead or `interactive-projection-lead` | keep scope tied to the approved spec. |
| Prototype + tool build | parallel sub-agents | live prototype and isolated tool file have disjoint write scopes. |
| Integrate/docs | single-writer sub-agent | registries, CLI, recipes, and docs are shared files. |
| QA/fix loop | sub-agent fan-in | QA routes precise defects to the owner; no release without PASS/UNVERIFIED accounting. |

All spawned agents use `model: "opus"` unless the user explicitly asks for a
different model.

## Agent roster

| Agent | Role | Skills | Output |
|---|---|---|---|
| `interactive-projection-lead` | scope owner and wave captain | this skill | `_workspace/interactive-projection/00_plan.md` |
| `interactive-projection-prototyper` | TD live/synthetic prototype and calibration findings | tdmcp tools | `_workspace/interactive-projection/01_prototype.md` |
| `interactive-projection-tool-builder` | new Layer 1 tool file + focused unit test | `td-feature-build` | `_workspace/interactive-projection/02_build_tool.md` |
| `interactive-projection-integrator` | single-writer registry, CLI, recipe, docs | `td-feature-integrate` | `_workspace/interactive-projection/03_integrate.md` |
| `interactive-projection-qa` | offline gates, boundary QA, live TD validation | `td-feature-qa` | `_workspace/interactive-projection/04_qa.md` |

Use existing `tdmcp-bridge-engineer` only if implementation proves that a new
bridge REST endpoint is necessary. The default plan should avoid a new endpoint.

## Source of truth

Read these before changing code:

1. `docs/superpowers/specs/2026-06-05-interactive-projection-mapping-design.md`
2. `CLAUDE.md`
3. Nearby Layer 1 tools:
   - `src/tools/layer1/createMotionReactive.ts`
   - `src/tools/layer1/createBlobReactive.ts`
   - `src/tools/layer1/createProjectionMapping.ts`
   - `src/tools/layer1/createOpticalFlow.ts` when present
4. Existing recipe examples:
   - `recipes/optical_flow_particles.json`
   - `recipes/projection_mapping.json`
   - `recipes/particle_system_basic.json`

## Workflow

### Phase 0 - context check

1. Read `git status --short`.
2. Check `_workspace/interactive-projection/`.
3. Decide run mode:
   - no workspace -> fresh run;
   - workspace exists + user says continue/fix/update -> resume only the
     affected phase;
   - workspace exists + new feature direction -> archive the old folder with a
     timestamp before starting a new one.
4. Check TouchDesigner bridge with `get_td_info` before any live prototype or QA
   claim.

### Phase 1 - plan the wave

Create `_workspace/interactive-projection/00_plan.md` with:

- target slice: prototype, tool, integration, docs/recipe, QA, or all;
- owner per slice;
- exact write scopes;
- commands/gates expected;
- live hardware assumptions;
- blocked or deferred blob/post-it items.

Default slice order:

1. synthetic-safe Layer 1 tool;
2. live/synthetic prototype feedback folded into the tool;
3. CLI + recipe + docs;
4. synthetic QA;
5. USB camera/projector QA when hardware and bridge are ready.

### Phase 2 - parallel prototype and isolated build

Run in parallel when both are in scope:

- `interactive-projection-prototyper`: use tdmcp live tools to prove or plan the
  TD network. If bridge is offline, produce a live-prototype checklist instead.
- `interactive-projection-tool-builder`: create only the new tool file and its
  focused unit test. Do not edit shared files.

Both agents must write their `_workspace/interactive-projection/0*_*.md` notes.

### Phase 3 - single-writer integration

Invoke `interactive-projection-integrator` after the tool builder reports export
names. It owns all shared files:

- `src/tools/layer1/index.ts`;
- `src/cli/agent.ts`;
- `recipes/interactive_projection_mapping.json` if the recipe slice is active;
- EN/PT docs/cookbook pages if docs are active.

The integrator must run `npm run typecheck` and `npm run build`. If docs/recipes
changed, also run `npm run validate:recipes` and the docs generation/build gate
that matches the touched files.

### Phase 4 - QA and fix loop

Invoke `interactive-projection-qa` incrementally:

1. schema/tool/test shape;
2. registry and CLI command;
3. recipe validation;
4. docs honesty and EN/PT parity if touched;
5. synthetic live build when bridge is reachable;
6. USB camera/projector validation only when the user confirms hardware is ready.

QA sends precise defects to the owner and re-validates after fixes. Cap repeated
fix loops at 2-3 rounds, then report the blocker.

### Phase 5 - report and next wave

Report:

- files changed;
- commands run and outcomes;
- PASS / FAIL / UNVERIFIED buckets;
- whether the feature is ready for physical calibration;
- what remains for blob/post-it upgrade.

Do not tag, release, or push unless the user explicitly asks.

## Data flow

```text
approved spec
  -> lead plan
  -> prototyper notes ---------+
  -> isolated tool builder ----+-> integrator -> qa -> fixes -> final report
```

## Error handling

| Situation | Strategy |
|---|---|
| Bridge offline | Build/test offline; mark live checks UNVERIFIED pending bridge. |
| Camera permission modal | Pause live camera claims; keep synthetic source path green. |
| Blob tracker unavailable | Ship motion-first MVP with warning; keep blob branch as follow-up. |
| Shared-file conflict | Stop shared edits and ask the lead to reconcile. |
| QA fail after 3 rounds | Hold the failing slice; report evidence and next fix. |

## Test scenarios

### Normal flow

User says "continue the interactive projection mapping implementation." The
orchestrator reads the spec, creates `_workspace/interactive-projection/00_plan.md`,
spawns prototype and tool-builder work, integrates the tool and CLI, runs
typecheck/build/focused tests, validates synthetic TD output if the bridge is up,
and reports physical projector QA as PASS or UNVERIFIED.

### Error flow

The bridge is offline and the blob tracker is not known to be createable. The
orchestrator still builds the synthetic-safe tool and docs, QA marks live camera
and blob checks UNVERIFIED, and the final report names the exact command to rerun
when TouchDesigner is open.

## Trigger validation

Should trigger:

- "implemente interactive_projection_mapping"
- "continue o create_interactive_projection_mapping"
- "vamos fazer a parte de camera/projetor"
- "adicione a recipe desse projection mapping interativo"
- "arrume o QA da feature de post-it tracking"
- "documenta o interactive projection mapping no cookbook"
- "roda o time para terminar essa feature"
- "faz o MVP do optical-flow hand projection"

Should not trigger:

- generic projection mapping question with no implementation request;
- unrelated prompt cookbook expansion;
- Soundcraft Ui24R mixer scene work;
- broad backlog campaign across many features;
- test coverage work not specific to this feature;
- directory/MCPB submission work.
