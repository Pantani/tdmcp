---
name: tdmcp-pipeline
description: "Orchestrates the tdmcp feature team end-to-end: design/wireframe → build → integrate → QA → release. Use whenever the user wants to build, implement, develop, ship, or add one or more tdmcp features/tools/effects/controls/AI-prompts for TouchDesigner, or to run them through a coordinated design→develop→QA→deploy pipeline. Also use for follow-ups: re-run, continue, update, fix, or improve a feature/batch, ship the next version, or rebuild just one part of a previous run. Single feature or a whole batch."
---

# tdmcp-pipeline — feature delivery orchestrator

Coordinate the five tdmcp specialists to take feature ideas from spec to a pushed release, following the project's proven workflow: parallel isolated builders + a single-writer integrator + live-validated QA + an autonomous release.

## Execution mode: hybrid

| Stage | Mode | Why |
|---|---|---|
| Design | sub-agent (fan-out if many features) | the architect is an isolated one-shot producer; specs land in `_workspace/` |
| Build | sub-agent (fan-out, parallel) | builders are fully isolated by design (new files only, no inter-comms) — the textbook sub-agent case |
| Integrate → QA → Release | **agent team** | producer↔reviewer feedback loops (QA ↔ builder-fixer/integrator) and the release gate need live messaging |

Why this split: builders must NOT touch shared files so they can run concurrently; that isolation removes any need for build-time team comms. The integrate/QA/release trio, by contrast, lives on a tight fix-and-re-verify loop, which is exactly what an agent team is for.

## Agent roster

| Agent | Type | Skill | Output |
|---|---|---|---|
| `td-architect` | custom | `td-feature-design` | `_workspace/01_design_<feature>.md` |
| `td-builder` (×N) | custom | `td-feature-build` | new tool + test files; `_workspace/02_build_<feature>.md` |
| `td-integrator` | custom | `td-feature-integrate` | wired `index.ts`/`agent.ts`; `_workspace/03_integrate.md` |
| `td-qa` | custom | `td-feature-qa` | `_workspace/04_qa_<batch>.md` (PASS/FAIL/UNVERIFIED) |
| `td-releaser` | custom | `td-feature-release` | CHANGELOG + version bump + commit/tag/push; `_workspace/05_release.md` |

All `Agent` / `TeamCreate` calls use `model: "opus"`.

## Workflow

### Phase 0 — context check (follow-up support)

1. Check whether `_workspace/` exists.
2. Decide the run mode:
   - **No `_workspace/`** → fresh run. Go to Phase 1.
   - **`_workspace/` exists + user asks to fix/continue/re-run part** → partial re-run. Re-invoke only the affected agent(s), passing the prior artifact paths so they refine rather than rewrite.
   - **`_workspace/` exists + a new batch of ideas** → new run. Move the old `_workspace/` to `_workspace_<YYYYMMDD_HHMMSS>/`, then Phase 1.

### Phase 1 — prepare

1. Parse the request into a concrete feature list. If the user named a roadmap cluster (e.g. "the cue sequencer + stage dashboard"), pull scope from `docs/ROADMAP.md`.
2. Create `_workspace/` and write the feature list to `_workspace/00_input/features.md`.

### Phase 2 — design (sub-agent fan-out)

Spawn one `td-architect` per feature (or one for the whole small batch) via `Agent`, `subagent_type: "td-architect"`, `model: "opus"`, `run_in_background: true` for parallelism. Each writes `_workspace/01_design_<feature>.md`. Wait for all, then read the specs and resolve any flagged overlaps/contention before building.

### Phase 3 — build (sub-agent fan-out, parallel)

Spawn N `td-builder` sub-agents in a single message (`run_in_background: true`), one per spec. Each prompt includes its spec path and the hard rule: **new files only, never edit shared registries/CLI/docs**. Each returns green-in-isolation files (`vitest` + biome) and a build note. Size N to the batch; keep it to a manageable parallel set (~3–5 at a time for a large batch, then a second wave).

### Phase 4 — integrate + QA + release (agent team)

Form the team and run the convergence loop:

1. `TeamCreate(team_name: "tdmcp-delivery", members: [`
   `{ name: "integrator", agent_type: "td-integrator", model: "opus" },`
   `{ name: "qa", agent_type: "td-qa", model: "opus" },`
   `{ name: "builder-fixer", agent_type: "td-builder", model: "opus" },`
   `{ name: "releaser", agent_type: "td-releaser", model: "opus" }])`
   (builder-fixer closes QA's fix requests on handler/schema/test bugs without re-spawning.)
2. `TaskCreate` the pipeline with dependencies:
   - integrate all built features (`integrator`)
   - QA each feature **incrementally** as it integrates (`qa`, depends on integrate) — not one big pass at the end
   - fix defects (`builder-fixer`/`integrator`, depends on QA findings)
   - release (`releaser`, depends on QA = PASS for everything shipping)
3. Team self-coordinates via `SendMessage`: QA sends `file:line` + fix to the owner the instant a defect is found; boundary bugs go to both sides; QA re-validates after each fix (cap ~2–3 rounds/feature).
4. Leader monitors with `TaskGet`, intervenes if a member stalls.

### Phase 5 — cleanup + report

1. Confirm `_workspace/05_release.md` exists (or that release was intentionally held).
2. `TeamDelete`. Preserve `_workspace/` for audit.
3. Report to the user: features shipped, the released version + tag + SHA, anything held back (with reason), and any live-validation marked UNVERIFIED because the bridge was offline.

## Data flow

```
[leader] → architect(s) ─ specs → builders (parallel) ─ files+notes →
   ┌─ TeamCreate(integrator, qa, builder-fixer, releaser) ─┐
   │  integrator wires → qa validates (live if bridge up)  │
   │     ↑ fix requests (SendMessage) ↓                    │
   │  builder-fixer / integrator patch → qa re-checks      │
   │  qa PASS → releaser cuts + pushes                     │
   └───────────────────────────────────────────────────────┘
                         ↓
              _workspace/0*_*.md + pushed tag
```

## Error handling

| Situation | Strategy |
|---|---|
| One builder fails in isolation | Ship the rest; route its spec to builder-fixer in Phase 4 (or re-spawn). Don't block the batch. |
| Build breaks on integrate | Integrator bisects, wires the rest, sends the offender a precise fix; team continues. |
| QA finds a boundary bug | SendMessage to **both** producer and consumer; re-validate after fix; cap ~2–3 rounds, else report blocker. |
| Bridge offline | QA runs offline gates, marks live checks UNVERIFIED-pending; release may still ship (note it) — never fail the pipeline for a missing TD. |
| QA = FAIL on a feature | Releaser holds it for next cycle; ships only PASS features; report what was held. |
| Concurrent agent's WIP breaks compile project-wide | Validate the slice in isolation (`vitest run <file>`); wait for their tree to go green before the full build/release. |

## Test scenarios

**Normal:** user asks to build the cue-sequencer feature → Phase 1 lists 1 feature → architect writes the spec → 1 builder produces a green tool+test → team forms → integrator wires + builds green → QA validates live (preview + post-cook errors clean) = PASS → releaser bumps minor, writes CHANGELOG, commits/tags/pushes → report names the new version.

**Error:** in a 4-feature batch, builder-3's tool cooks to a TD error caught by QA (a Level TOP `gain` no-op) → QA SendMessages builder-fixer with `file:line` + use `brightness1` → fix re-validates PASS → the other 3 already PASS → releaser ships all 4. If builder-3 can't be fixed in 3 rounds, releaser ships the 3 PASS features and the report holds builder-3 for next cycle.
