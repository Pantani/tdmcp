---
name: tdmcp-roadmap-campaign
description: >-
  Drive the ENTIRE tdmcp roadmap-to-1.0 to completion as a resumable,
  wave-by-wave campaign — Milestone 4 (generative-AI bridge wave), Milestone 5
  (mixer scene arming), and the v1.0 consolidation gates G1–G6 — routing each
  class of work to the right existing sub-harness. Use whenever the user wants to
  "implement everything / all the milestones / the whole roadmap / finish the
  road to 1.0", run the next milestone, close the consolidation gates, or build a
  long autonomous campaign across M4/M5/G1–G6. ALSO use for every follow-up:
  continue/resume the roadmap campaign, run the next wave, re-run a failed wave,
  fold in QA results, check campaign status, re-prioritize, or scope to one
  milestone/gate. This is the CAMPAIGN layer ABOVE tdmcp-pipeline /
  tdmcp-feature-lead / tdmcp-backlog-campaign — it sequences across MULTIPLE
  sub-harnesses (tools, mixer, coverage, docs, bridge, recipes, submission),
  which the generic backlog-campaign does not. For a SINGLE feature use
  tdmcp-pipeline; for one tool-shaped backlog file use tdmcp-backlog-campaign.
  Simple questions can be answered directly.
---

# tdmcp Roadmap-to-1.0 Campaign

Drives `_workspace/campaign_roadmap_v1/ROADMAP_1.0_BACKLOG.md` to completion,
gated by `_workspace/campaign_roadmap_v1/ledger.json` (idempotent, resumable,
merge-safe). This is **orchestration only** — it never writes product code
itself; it routes each ledger item to the existing specialist sub-harness and
records the outcome back into the ledger.

## Why this exists (vs tdmcp-backlog-campaign)

`tdmcp-backlog-campaign` drives a *tool-shaped* backlog through one pipeline
(design→build→integrate→QA→release). The road to 1.0 is **not** uniform: it mixes
new tools (M4), a policy-bounded mixer slice (M5), a coverage CI gate (G2), a
bridge exec→REST sweep (G4), docs/governance (G1/G5/G6 prep), and live-validated
recipes (G3). Each needs a *different* specialist. This skill is the thin router
that sequences them and keeps one ledger of truth.

## Confirmed campaign policy (2026-06-21)

- **Release:** commit + push, **NO tag/bump**. Everything lands in CHANGELOG
  `[Unreleased]`. Cutting the version is a manual user step — never tag
  autonomously (`[[no-premature-release-tag]]`).
- **Blocked items** (GPU/CUDA, live-TD, external service): **build offline +
  quarantine**. Implement, pass the offline gates, set `live` to the right
  `UNVERIFIED-pending-*` marker, keep going. Quarantine never blocks the campaign.
- **Checkpoint:** after Wave 1 only, then autonomous to the end. On repeat
  failure: retry once → quarantine-and-continue (note it in the wave report).

## Routing table (ledger `route` → sub-harness)

| `route` | Sub-harness | Agents |
|---------|-------------|--------|
| `docs` | `tdmcp-docs-roadmap-update` | roadmap-docs-editor, docs-cookbook-sync, docs-roadmap-qa |
| `tools` | `tdmcp-feature-lead` | tdmcp-tool-builder ×N + single-writer integration |
| `mixer` | `tdmcp-pipeline` | mixer-scene-contract-architect, soundcraft-ui24r-adapter-architect, mixer-policy-safety-qa |
| `coverage` | `tdmcp-test-coverage` | tdmcp-coverage-writer, tdmcp-coverage-qa |
| `bridge` | `tdmcp-bridge-endpoint` | tdmcp-bridge-engineer (sequential — bridge slices share files) |
| `recipes` | `tdmcp-pipeline` | td-architect, td-builder, td-qa (needs live TD) |
| `submission` | `tdmcp-submission` | submission-architect, submission-qa |
| planning | — | tdmcp-backlog-planner (wave computation + ledger transitions) |

## Workflow

### Phase 0 — Context check (resume vs fresh)

1. Read `ledger.json`. If absent, the harness isn't initialized — (re)generate it
   from `ROADMAP_1.0_BACKLOG.md` and `docs/ROADMAP.md`, then stop and report.
2. **Reconcile against the tree first** — a prior session or a merged PR may have
   already shipped a ledger item. For each `pending` item, cheaply verify it's
   genuinely undone (grep for the tool/file/gate) before assigning it. Flip
   already-done items to `shipped` with an `event: reconciled` history row.
3. Determine the next ready wave: lowest wave number with `pending`,
   non-`blocked` items whose `depends_on` are all `shipped`. Honor the
   `checkpoint_after_wave` gate.

### Phase 1 — Plan the wave (tdmcp-backlog-planner)

Spawn `tdmcp-backlog-planner` (opus) with the ledger + backlog. It returns: the
exact item set for this wave, their routes, dependency-safe ordering, and the
proposed ledger status transitions. Write its report to
`_workspace/campaign_roadmap_v1/wave_<n>_planner_report.md`.

### Phase 2 — Execute the wave (route to sub-harnesses)

For each item, invoke its `route` sub-harness with a precise spec. Within a wave:
- **Parallelize independent items** across routes (docs ∥ coverage ∥ tools).
- **Serialize same-file routes** — all `bridge` items run sequentially (they
  share `td-client`/`td/` files); within `tools`, builders are parallel but the
  integrator is the single writer of shared registries.
- **Blocked/needs-hardware items:** build to the offline boundary, then mark
  `live` quarantined per policy — do not wait on hardware.

Every sub-harness already runs its own gates; this skill does not re-implement
them. Record per-item QA (`typecheck/build/biome/vitest/recipes/bridge`) into the
ledger `qa` block, exactly like the project_rag campaign.

### Phase 3 — Gate, commit, record

1. Run the four PR gates + recipe + bridge tests at the wave boundary
   (`npm run typecheck && npm run build && npm run lint && npm test`,
   `npm run validate:recipes`, `npm run test:bridge`).
2. Commit + push the wave on its own branch (`feature/roadmap-<wave-theme>`).
   **No tag, no version bump** — CHANGELOG `[Unreleased]` only.
3. Update the ledger: flip items `pending → shipped` (or `quarantined`), stamp
   `qa`, `commit`, and a `history` row. Write `wave_<n>_report.md`.

### Phase 4 — Loop or checkpoint

- If the just-finished wave is the `checkpoint_after_wave` → **stop and report**;
  wait for the user before the next wave.
- Otherwise advance to the next ready wave (Phase 0 → 3) until no `pending`
  non-blocked item remains.

### Phase 5 — Hand-back

When only quarantine items remain, report **campaign complete (offline scope)**
and enumerate what the user must do to actually tag 1.0: provide GPU/TOX
components or a reachable TD for the `UNVERIFIED-pending-*` live validations,
run the bench/hardware M5 spikes, submit to the Connectors Directory, and — only
on the user's word — cut the tagged 1.0 minor (closing G1).

## Error handling

- A sub-harness that fails a gate: retry once with the failure fed back. On
  second failure, mark the item `quarantined` with the reason, leave the rest of
  the wave intact, and note it in the wave report — never delete partial work.
- Conflicting tree state vs ledger: trust the tree, reconcile the ledger, note
  the drift. Never silently overwrite shipped work.
- The ledger is the single source of truth and must stay valid JSON after every
  transition; write it atomically (full rewrite), never partial.

## Test scenarios

- **Happy path:** fresh ledger → Phase 0 picks Wave 1 → planner assigns 4 docs
  items → docs sub-harness ships all four → gates green → commit no-tag →
  checkpoint stop with a Wave-1 report.
- **Resume after merge:** a follow-up run finds `g2_coverage_ci_gate` already
  landed on main → reconcile to `shipped` (event: reconciled) → skip it → plan
  the remainder of Wave 2.
- **Blocked item:** Wave 4 `m4_drive_streamdiffusion` builds offline, gates green,
  but no GPU → ship with `live: UNVERIFIED-pending-gpu`, campaign continues.
- **Repeat failure:** a tool fails its gate twice → quarantined with reason, wave
  proceeds with the rest, report flags the gap.
