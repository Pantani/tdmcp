---
name: tdmcp-backlog-campaign
description: "Drive a whole tdmcp feature BACKLOG to completion as resumable, wave-by-wave releases — the campaign layer ABOVE tdmcp-pipeline/tdmcp-feature-lead. Use whenever the user wants to implement an ENTIRE backlog or discovery file (e.g. _workspace/discovery*/FEATURE_BACKLOG*.md), 'all the features', many features across multiple releases, or a long autonomous build campaign, AND for every follow-up: continue/resume the campaign, run the next wave, re-run a failed wave, fold in QA results, or check campaign status. Backed by a ledger.json so re-running is idempotent (skips shipped work, resumes interrupted work) and resilient (retry-once then quarantine-and-continue). For a SINGLE feature or one small batch, use tdmcp-pipeline instead; this skill is for the whole ledger."
---

# tdmcp-backlog-campaign — whole-backlog delivery

A single feature-build wave is already handled well by **`tdmcp-pipeline`** (the
five specialists) and **`tdmcp-feature-lead`** (parallel builders + single-writer
integrate). This skill is the layer they do not provide: driving an entire **backlog**
of dozens of features to completion across **multiple themed releases**, *resumably*.
It is a thin, ledger-driven loop over the existing pipeline — it adds idempotency,
resilience, shared-schema sequencing, and a checkpoint/release policy; it does **not**
re-implement building.

> **When NOT to use this:** one feature, or one small ad-hoc batch → `tdmcp-pipeline`.
> A whole survey/backlog file, "all the features", or "continue the campaign" → here.

## The two things this skill owns

1. **The ledger** (`_workspace/campaign_<id>/ledger.json`, in the **main repo
   checkout** — resolve with `dirname "$(git rev-parse --path-format=absolute
   --git-common-dir)"`, never the worktree, so state survives worktree cleanup and is
   shared across sessions). One row per feature; `build-ledger.mjs` beside it
   regenerates the static plan **merge-safely** (preserves live state). This is the
   idempotency + resilience substrate. Status vocabulary:
   ```
   pending → designing → building → integrating → qa → shipped
   side: blocked-dep | blocked-td | quarantined | merged | tracked-elsewhere
   ```
2. **The wave/release loop** — pick the next ready wave (via `tdmcp-backlog-planner`),
   run it through the pipeline foundations-first, release it under policy, fold the
   results back into the ledger, then checkpoint or continue.

## Execution policy — read it from `ledger.policy`, do not assume

The ledger carries the policy the user chose; honor it literally. For the current
campaign (`beyond_20260530`):

| Policy | Value | Meaning |
|---|---|---|
| `scope` | `staged-by-priority` | Run waves in order; **pause after `checkpoint_after_wave`** for a go/no-go before continuing. |
| `checkpoint_after_wave` | `1` | After wave 1 (P0 + Top-12) ships, **stop and report**; wait for the user to say continue. |
| `release` | `commit-and-push-NO-tag` | The releaser writes CHANGELOG + bumps version + commits + **pushes the branch**, but must **NOT `git tag`** (the repo's tags diverged; tagging is held). |
| `td_required_before_build_waves` | `true` | A wave touching `needs_td` features only runs when `get_td_info` reports connected. If offline, hold those features (`blocked-td`) and say so; never fake a live pass. |
| `builder_retry` | `1` | One retry per failing builder/feature. |
| `on_repeat_fail` | `quarantine-and-continue` | After the retry, mark `quarantined`, record the gap, and **keep the wave moving** — one stuck tool never blocks the rest. |

## Agent roster (all reused except the planner)

| Role | Agent / skill | New? |
|---|---|---|
| Campaign brain / ledger steward | `tdmcp-backlog-planner` | **NEW** |
| Per-feature design spec | `td-architect` (`td-feature-design`) | reused |
| Isolated tool builder (×N parallel) | `td-builder` / `tdmcp-tool-builder` | reused |
| Single-writer integrator | `td-integrator` (`td-feature-integrate`) | reused |
| Live + gate QA (incremental) | `td-qa` (`td-feature-qa`) | reused |
| Release (CHANGELOG/bump/commit/push) | `td-releaser` (`td-feature-release`) | reused |

All `Agent` calls use `model: "opus"` for design/integrate/QA/release/planner;
**builders** follow the project convention — `sonnet` for prescriptive tools, `opus`
for the ones needing design judgment (probe-live / novel topology). This env has **no
`TeamCreate`** — the integrate↔QA↔fix loop runs as coordinated `Agent`-tool sub-agents
(spawn integrator, then QA, then a builder-fixer on each defect), exactly as
`tdmcp-feature-lead` and `tdmcp-submission` do.

## Workflow

### Phase 0 — locate + decide run mode (idempotency entry point)

1. Resolve `CAMPAIGN_DIR = <main-root>/_workspace/campaign_<id>/`. If no `ledger.json`,
   run `build-ledger.mjs` to create it (or, for a brand-new backlog, author a
   `build-ledger.mjs` for it first — see "Starting a campaign for a new backlog").
2. Read `ledger.json`. Decide:
   - **All buildable features `shipped`** → campaign complete; report and stop.
   - **A wave is mid-flight** (features in `designing`/`building`/`integrating`/`qa`)
     → resume: spawn the planner to reconcile reality first (it verifies files/wiring
     against the tree and repairs lying statuses), then continue that wave.
   - **Otherwise** → start the next ready wave.
3. Ensure a working branch exists and record it in `ledger.policy.branch` (commits land
   here; never commit straight to `main`).

### Phase 1 — plan the wave

Spawn **`tdmcp-backlog-planner`** (`model: "opus"`). It reconciles the ledger against
the tree, computes the next ready wave (deps + shared-schema-first satisfied,
`needs_td` honored against live bridge state), and writes `wave_<N>_manifest.json` +
`wave_<N>_planner_report.md`. Read the manifest; respect its `foundations` →
`parallel` sub-batch order and its `blocked[]` exclusions.

### Phase 2 — TD gate

If the wave has `needs_td` features, call `get_td_info`. Connected → proceed with full
live validation. Offline → build only the wave's offline-safe features now, mark the
`needs_td` ones `blocked-td`, and tell the user which tools await TD (per
`td_required_before_build_waves`). Never block the whole campaign on a missing bridge,
and never claim a live pass you could not observe.

### Phase 3 — run the wave (foundations first, then fan out)

For the **foundations** sub-batch (shared schemas / promoted primitives), run them
**first and serially-ish** so their contract is fixed before dependents consume it:
`td-architect` spec → 1 builder → integrate → QA → mark `shipped`. Update the ledger
after each transition.

Then the **parallel** sub-batch, exactly the `tdmcp-pipeline` Phase 2–4 loop:
1. `td-architect` fan-out (one per feature, `run_in_background`), specs to
   `_workspace/01_design_<id>.md`. Resolve any flagged cross-feature contention
   (especially shared-schema consumers) before building.
2. `td-builder` fan-out in a **single message** (~4–6 at a time; a larger ready set
   becomes ordered sub-batches). Each: **new files only**, green-in-isolation (vitest
   + biome + typecheck). Set each feature `building`.
3. `td-integrator` as the **single writer** wires every built tool into the layer
   `index.ts` / `src/cli/agent.ts` / `src/prompts/index.ts`, then the four gates
   (`typecheck`, `build`, `./node_modules/.bin/biome check .`, `test`; +
   `validate:recipes` if a recipe changed). Set features `integrating`.
4. `td-qa` **incrementally** as each feature integrates — gate pass + (TD up) live
   create→cook→`get_td_node_errors`→`get_preview`. Defects go back to a builder-fixer
   (`file:line` + fix), re-validate, cap ~2–3 rounds. Set `qa`, then `shipped` on PASS.
5. Update each feature's `status/qa/files/history` in the ledger as it resolves.

### Phase 4 — release the wave, fold results, checkpoint

1. **Docs/CHANGELOG/ROADMAP** for everything that shipped this wave (the integrator/QA
   already do per `tdmcp-feature-lead`; confirm `docs/reference/tools.md` is generated
   not hand-edited, build the docs).
2. **Release under policy** — spawn `td-releaser` with the explicit override:
   *write the CHANGELOG entry, bump to `version_target`, commit, **push the branch** —
   but do **NOT** create a git tag.* (Honor `commit-and-push-NO-tag`.)
3. **Fold outcomes** — re-spawn `tdmcp-backlog-planner` to apply this wave's results
   (`shipped` / `quarantined` / `blocked`) to the ledger and compute the next wave.
4. **Checkpoint** — if this wave == `checkpoint_after_wave`, **stop**: report shipped /
   quarantined / blocked-td, the new version + pushed SHA (no tag), and what wave 2
   holds. Wait for the user to continue. Otherwise loop to Phase 1.

## Idempotency rules (never redo finished work)

- Trust the tree over the ledger on resume: the planner promotes built+wired+green
  features to `shipped` and resets file-less in-flight ones to `pending`.
- A feature is rebuilt only from `pending`. `shipped` is never demoted; `quarantined`
  is retried only on an explicit re-run request for that id.
- **Recoverable side states never strand a wave:** on reconcile the planner clears
  `blocked-td` → `pending` when TD is reachable and `blocked-dep` → `pending` once deps
  ship (re-entering the ready pool), and wave selection **skips past** a wave whose only
  leftover rows are `quarantined`/permanently-blocked — so a half-shipped wave can never
  loop on an empty manifest.
- `build-ledger.mjs` is merge-safe — editing the plan and regenerating preserves live
  state. Always go through it (or live-field edits), never blow away `ledger.json`.

## Resilience / error handling

| Situation | Strategy |
|---|---|
| Builder fails in isolation | One retry (re-spawn with the precise failure). Then `quarantined` + continue; ship the rest of the wave. |
| Integrate breaks the build | Integrator bisects, wires the rest, sends the offender a fix; campaign continues with the green subset. |
| QA finds a boundary bug | Fix request to **both** sides; re-validate; cap ~3 rounds, else `quarantined` with the blocker noted. |
| Bridge offline mid-wave | `needs_td` features → `blocked-td`, ship offline-safe ones, report; resume the blocked set next time TD is up. |
| Dependency not yet shipped | Planner marks `blocked-dep`, excludes from the wave; it becomes ready once its dep ships. |
| A whole wave regresses on re-run | Treat feedback as a diff: re-spawn only affected builders / re-touch only affected shared files; don't rebuild green tools. |
| Context window fills mid-campaign | The ledger IS the handoff. A fresh session re-enters at Phase 0 and resumes exactly where it stopped. |

## Release specifics — NO tag

The releaser's default tags; for this campaign it must not. Pass it: *"Per campaign
policy `commit-and-push-NO-tag`: do CHANGELOG + version bump + commit + `git push` the
branch; skip `git tag` entirely. Honor the repo's hard git safety rails otherwise."*
If the user later flips the policy to allow tags, update `ledger.policy.release` and
the releaser brief together.

## Starting a campaign for a new backlog

If pointed at a backlog file with no campaign yet: create `_workspace/campaign_<slug>/`,
author a `build-ledger.mjs` that encodes that backlog's features (id, surface, priority,
`probe_live`, `needs_td`, `depends_on`, `shared_schema`, `wave`, `version_target`) and
its `policy`, run it, then enter Phase 0. Mirror the `beyond_20260530` generator's
shape; keep merge-safe seeding so re-runs preserve progress.

## Data flow

```
ledger.json ──▶ planner ──▶ wave_N_manifest.json
                                  │ foundations first
        ┌─────────────────────────┴───────────────────────────┐
        │ architect(s) → builders(∥) → integrator(1) → qa(∥)   │  ← per wave
        │      ↑ fix (file:line) ↓   gates + live (TD up)       │     = tdmcp-pipeline
        └─────────────────────────┬───────────────────────────┘
                                  ▼
        releaser (CHANGELOG/bump/commit/PUSH, NO tag) ──▶ planner folds results
                                  ▼
              ledger.json updated ──▶ checkpoint? stop : next wave
```

## Test scenarios

**Normal (resume):** session 2 opens, reads `ledger.json` — 9 of wave 1 `shipped`, 3
`building` with files present, 4 `pending`. Planner reconciles: the 3 `building`+green
→ `shipped`; computes the remaining 4 ready. Campaign builds the 4, integrates, QA
PASS, releaser commits+pushes v0.7.0 (no tag), planner folds, wave 1 == checkpoint →
stop and report. No shipped feature was rebuilt.

**Error (quarantine + offline TD):** wave 1, `create_euclidean_sequencer` cooks to a TD
error QA catches; builder-fixer's two rounds don't clear it → `quarantined`, gap
recorded, the other 15 ship. Mid-wave the bridge drops; `create_glsl_material`
(`needs_td`) can't be live-validated → `blocked-td`, reported as awaiting TD. Releaser
ships the 14 PASS features as v0.7.0 (commit+push, no tag). Report names the 1
quarantined + 1 blocked-td; both are picked up on the next run automatically.
