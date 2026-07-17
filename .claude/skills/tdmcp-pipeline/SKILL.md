---
name: tdmcp-pipeline
description: "Orchestrates the tdmcp feature team end-to-end: design/wireframe → build → integrate → QA → release. Use whenever the user wants to build, implement, develop, ship, or add one or more tdmcp features/tools/effects/controls/AI-prompts for TouchDesigner, or to run them through a coordinated design→develop→QA→deploy pipeline. Also use for follow-ups: re-run, continue, update, fix, or improve a feature/batch, ship the next version, or rebuild just one part of a previous run. Single feature or a whole batch."
---

# tdmcp-pipeline — feature delivery orchestrator

Coordinate the tdmcp specialists from spec through build, integration, and QA, then perform only the release actions explicitly authorized for this run.

## Execution mode: hybrid

| Stage | Mode | Why |
|---|---|---|
| Design | sub-agent (fan-out if many features) | the architect is an isolated one-shot producer; specs land in `_workspace/` |
| Build | hybrid routing | new-tool builders fan out; existing-file extensions fan out only with disjoint leases; bridge slices run serially |
| Integrate → QA → optional Release | coordinated sub-agents by default | producer↔reviewer feedback loops need live messaging; release is a separate policy gate |

Why this split: new-tool builders are isolated by new files, extension builders are isolated by disjoint leases, and bridge work is serialized. Integrate/QA/fix lives on a tight fix-and-re-verify loop; use coordinated sub-agents even when a native team API is unavailable.

## Agent roster

| Agent | Type | Skill | Output |
|---|---|---|---|
| `td-architect` | custom | `td-feature-design` | `_workspace/01_design_<feature>.md` |
| `td-builder` (×N) | custom | `td-feature-build` | new tool + test files; `_workspace/02_build_<feature>.md` |
| `td-extension-builder` (×N) | custom | `td-feature-extend` | leased existing-file patch + tests; `_workspace/02_extend_<feature>.md` |
| `tdmcp-bridge-engineer` (×1 serial) | custom | `tdmcp-bridge-endpoint` | bridge + client + validator vertical slice |
| `td-integrator` | custom | `td-feature-integrate` | wired `index.ts`/`agent.ts`; `_workspace/03_integrate.md` |
| `td-qa` | custom | `td-feature-qa` | `_workspace/04_qa_<batch>.md` (PASS/FAIL/UNVERIFIED) |
| `td-releaser` (policy-gated) | custom | `td-feature-release` | only authorized release actions; `_workspace/05_release.md` |

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
3. Resolve and record one canonical `release_policy` object: `{ version_bump, commit, push, tag, publish, deploy }`. Each field is boolean and defaults false unless the current user request explicitly authorizes it or an enclosing campaign passes it. Campaign policy always wins; a prior run never carries authority forward.

### Phase 2 — design (sub-agent fan-out)

Spawn one `td-architect` per feature (or one for the whole small batch) via `Agent`, `subagent_type: "td-architect"`, `model: "opus"`, `run_in_background: true` for parallelism. Each writes `_workspace/01_design_<feature>.md` and classifies `build_mode` as `new-tool`, `extension`, or `bridge`, with an explicit `ownership[]` lease. Wait for all, then read the specs and resolve any flagged overlaps/contention before building.

### Phase 3 — build (mode-routed)

Partition specs before spawning:

1. **`new-tool`** — fan out `td-builder` in one message. New files only; never edit shared registries/CLI/docs.
2. **`extension`** — spawn `td-extension-builder`. Parallelize only when every `ownership[]` set is disjoint; serialize overlapping leases. Each builder baselines the slice, edits only leased existing files, adds focused tests, and writes `_workspace/02_extend_<feature>.md`.
3. **`bridge`** — run `tdmcp-bridge-engineer` one at a time. Bridge slices share `td/` routing, `touchDesignerClient.ts`, and validators, so parallel execution is forbidden. Before integration, run `python3 -m py_compile` on every changed `td/**/*.py` file plus the focused bridge tests, Biome, typecheck, and build.

Keep each concurrent sub-batch to ~3–5 items. A feature whose mode or lease is ambiguous returns to `td-architect` before code is written.

### Phase 4 — integrate + QA + policy-gated release

Run the convergence loop without assuming a native team API:

1. Spawn coordinated `td-integrator`, `td-qa`, `td-builder` fixer, and `td-extension-builder` fixer sub-agents. If `TeamCreate`/shared task APIs are actually available, they may be used; otherwise the leader owns the dependency list and relays file:line fixes with agent messaging.
2. Track these dependencies explicitly:
   - integrate all built features (`integrator`)
   - QA each feature **incrementally** as it integrates (`qa`, depends on integrate) — not one big pass at the end
   - fix defects (`builder-fixer` / `extension-fixer` / `integrator`, depends on QA findings)
3. QA sends `file:line` + fix to the owner immediately; boundary bugs go to both sides; QA re-validates after each fix (cap ~2–3 rounds/feature). The leader monitors and replaces stalled agents without discarding their diffs.
4. After QA, inspect `release_policy`. If every action is false (or the enclosing campaign requested `through_qa_only`), skip `td-releaser` and record an unreleased QA checkpoint. Otherwise spawn it with exactly the enabled booleans; commit, push, tag, publish, deploy, and version bump are independent permissions.

### Phase 5 — cleanup + report

1. Confirm `_workspace/05_release.md` exists only when release actions ran; otherwise confirm the unreleased QA checkpoint is recorded.
2. Close coordinated agents/team resources. Preserve `_workspace/` for audit.
3. Report features completed, only the release artifacts actually produced, anything held back, and live validation marked UNVERIFIED.

## Data flow

```
[leader] → architect(s) ─ specs → builders (mode-routed) ─ files+notes →
   ┌─ coordinated sub-agents (native team optional) ───────┐
   │  integrator wires → qa validates (live if bridge up)  │
   │     ↑ fix requests (SendMessage) ↓                    │
   │  builder-fixer / extension-fixer / integrator → QA    │
   │  qa PASS → release_policy gate → optional releaser    │
   └───────────────────────────────────────────────────────┘
                         ↓
              _workspace/0*_*.md + authorized outputs only
```

## Error handling

| Situation | Strategy |
|---|---|
| One builder fails in isolation | Ship the rest; route its spec to builder-fixer in Phase 4 (or re-spawn). Don't block the batch. |
| Extension ownership overlaps | Serialize those extensions; never let two agents edit the same existing file concurrently. |
| Extension hits unknown dirty work | Preserve it, mark the feature blocked, and continue with disjoint work. |
| Bridge slice is requested | Route to one `tdmcp-bridge-engineer`; never run bridge engineers in parallel. |
| Build breaks on integrate | Integrator bisects, wires the rest, sends the offender a precise fix; team continues. |
| QA finds a boundary bug | SendMessage to **both** producer and consumer; re-validate after fix; cap ~2–3 rounds, else report blocker. |
| Bridge offline | QA runs offline gates and marks live checks UNVERIFIED-pending; the explicit release policy decides whether any release action may still run. |
| QA = FAIL on a feature | Releaser holds it for next cycle; ships only PASS features; report what was held. |
| Concurrent agent's WIP breaks compile project-wide | Validate the slice in isolation (`vitest run <file>`); wait for their tree to go green before the full build/release. |

## macOS TouchDesigner process safety

- Inventory every running TouchDesigner PID, project path and listening bridge port before live work. Bind probes to one explicitly disposable PID and re-check that binding before and after each mutation.
- Never pass discovery flags such as `--help`, `--version` or guessed headless/project flags to the TouchDesigner app binary. This binary does not provide a conventional CLI contract; an unknown flag opens a modal and exits. Use verified Derivative documentation or inspect the app bundle without launching it.
- Never use Accessibility, menu clicks, clipboard paste or Textport automation when more than one TouchDesigner process exists. PID-targeted Accessibility can still resolve a window from the artist process. Use authenticated structured bridge routes or a PID-guarded disposable bootstrap.
- Never save, quit, kill, focus or mutate the artist process while a disposable sandbox is available. Teardown must target the exact disposable PID, verify its listener disappeared and verify the artist PID remains alive.
- A source reload is mandatory after bridge Python changes. Prove the loaded controller/service file paths and `TDMCP_BRIDGE_ALLOW_EXEC=0` before product probes; temporary exec is permitted only for authenticated disposable bootstrap and must be disabled before structured feature validation.

## Test scenarios

**Normal:** a batch contains one new tool, one CLI extension, and one bridge promotion → architect labels modes/leases → new-tool and disjoint extension run in parallel → bridge engineer runs serially with py_compile → integrator and QA converge through coordinated sub-agents → only QA-PASS work reaches the explicit release-policy gate.

**Error:** in a 4-feature batch, builder-3's tool cooks to a TD error caught by QA (a Level TOP `gain` no-op) → QA SendMessages builder-fixer with `file:line` + use `brightness1` → fix re-validates PASS → the other 3 already PASS → releaser ships all 4. If builder-3 can't be fixed in 3 rounds, releaser ships the 3 PASS features and the report holds builder-3 for next cycle.
