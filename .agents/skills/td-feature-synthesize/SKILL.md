---
name: td-feature-synthesize
description: "Consolidate the five tdmcp surveyor reports into one prioritized FEATURE_BACKLOG.md — dedupe cross-surface overlaps, reconcile every candidate against the roadmap (NEW vs planned vs extension), rank by a selectable impact×effort weighting profile into P0/P1/P2 (high-confidence first), and emit per-surface tables + a recommended-next shortlist that hands straight to the build pipeline. Use when a td-synthesizer agent is consolidating surveys during the feature-discovery harness."
---

# td-feature-synthesize — merge, reconcile, prioritize

You consolidate up to five independent surveys into the single artifact the user wants: an honest, prioritized list of new features, organized by surface, ranked by value vs. effort under a selectable weighting profile, and ready to feed the build pipeline. Surveyors brought vetted depth; you bring judgment.

## Procedure

### 1. Gather inputs
Read every `_workspace/discovery/01_survey_{controls,library,cli,ai,td-depth}.md` that exists, plus `docs/ROADMAP.md`, `AGENTS.md`, `CHANGELOG.md`, and the `project-td-mcp-competitive-landscape` memory if present. If a survey is missing, proceed and record the gap in a coverage line.

### 2. Dedupe
Merge duplicates and near-duplicates into one entry under its best-fit surface, with a `(also raised under <surface>)` cross-ref. A control that's really a TD capability, or a CLI command that just exposes a tool, is **one** feature — not two.

### 3. Reconcile against the roadmap (honestly)
Sort every surviving candidate into three buckets and keep all three visible:
- **NEW / unlisted** — the headline value. These are what the user can't already see in the roadmap.
- **Already planned** — cite the phase (Phase 13 / deferred-v0.6.0+). Report them so the user sees what's queued and can re-prioritize, but never relabel them as discoveries.
- **Extensions** — concrete extensions of shipped tools/commands/prompts.

The credibility of the backlog *is* the deliverable — the user owns this repo and will notice inflation.

### 4. Prioritize
Score each item on impact (High/Med/Low) × effort (S/M/L), then assign a single priority:

| | S effort | M effort | L effort |
|---|---|---|---|
| **High impact** | **P0** (quick win) | P0 | P1 |
| **Med impact** | P1 | P1 | P2 |
| **Low impact** | P2 | P2 | **P2 (trap — flag it)** |

**Weighting profile.** How you weight *impact* is the most consequential call you make. Use a named profile — default unless the orchestrator passes one in the run:

| Profile | Leads with | When the user wants… |
|---|---|---|
| **`live-show`** (default) | Does this make a real set better? (audio/beat/camera-reactive, mixing, recovery, hands-free) → **quick-wins (S effort) as the tie-breaker** | the core VJ thesis — the safe default |
| `quick-win` | Lowest effort first; rank by impact÷effort, S before M before L | momentum, a release this week |
| `parity` | Competitor gaps first (8beeeaaat / Embody / dotsimulate LOPs) | closing a perceived feature deficit |
| `agent-dx` | Token-cost / agent-ergonomics wins first (cheap reads, batch, surgical edits) | making the agent cheaper & faster |

Whatever the profile, two rules always hold: a feature that makes a real show better or an agent dramatically cheaper outranks a generic nicety; and within a priority tier, **list higher-`Confidence` items first** (a vetted P1 beats a speculative P1). Respect the project's deliberate broad-tool-surface stance: propose only *additive* features, never consolidation-for-score.

### 5. Emit `FEATURE_BACKLOG.md`
Structure:

```
# tdmcp — Feature Backlog (discovery <YYYY-MM-DD>)

## Executive summary
<5–8 lines: how many candidates, how many genuinely NEW, the 3–5 strongest
themes, and the single highest-leverage recommendation. Skimmable in under a minute.>

## Coverage
<which surfaces were surveyed; any gap.>

## Recommended next — Top N
<a ranked shortlist (≈8–12) with: feature · surface · priority · effort · one-line why ·
and a "pipeline-ready" phrasing the user could paste into the build harness.>

## By surface
### Artist controls & creative tools
<table: Feature | Delivers | Effort | Impact | Conf | Priority | Novelty | Probe-first>
### Library, packaging & distribution
<table …>
### CLI & developer DX
<table …>
### AI & LLM integration
<table …>
### TouchDesigner depth (bridge + operators)
<table …>
### Cross-cutting
<table … — items that span surfaces>

## Roadmap alignment
<short: which already-planned items the surveys re-surfaced (confirming priority),
and which NEW items, if any, deserve to be promoted into the roadmap.>
```

### 6. Make it pipeline-ready
Phrase each recommended item so it can be handed straight to `tdmcp-pipeline` (e.g. "Build `create_sdf_text` — Layer 1 GLSL SDF text generator with beat-flash"). Carry any `probe-first` / `UNVERIFIED` flag through so the build harness knows to validate live first.

## Output + return
- Write `_workspace/discovery/FEATURE_BACKLOG.md`.
- Return a tight, self-contained prose summary (the orchestrator relays it): the headline NEW ideas, the recommended shortlist, and any coverage gap.

## Quality bar
- **Decide, don't hedge** — one surface, one priority, one effort per item. If surveys disagreed, pick the more conservative effort and note it in one line.
- **Tables over prose** in the per-surface sections; reserve prose for the summary and roadmap-alignment.
- **No invented operators** survive into the backlog without a `probe-live` flag.
- **Honest buckets** — if most candidates are already on the roadmap, say so plainly; the NEW set's size is a finding, not a target.
