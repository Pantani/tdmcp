---
name: tdmcp-feature-discovery
description: "Survey the whole tdmcp project and produce a prioritized list of NEW features it could implement — across artist controls, CLI/DX, AI/LLM integration, and TouchDesigner depth. Use whenever the user wants to brainstorm, discover, survey, list, or audit what features/tools/effects/controls/commands/prompts/capabilities tdmcp *could* add, asks 'what could we build / what's missing / what are the opportunities / ideas for the project', or wants a feature backlog or gap analysis. Also for follow-ups: re-run, refresh, update, re-survey, deepen, or re-prioritize the backlog, or survey just one surface (e.g. 'CLI ideas only'). This is the IDEATION harness — it produces a list to decide from; it does NOT build. When the user has already chosen a feature and wants it implemented/shipped/added, use tdmcp-pipeline instead."
---

# tdmcp-feature-discovery — new-feature ideation orchestrator

Coordinate a fan-out of surveyors + one synthesizer to produce a single prioritized **feature backlog** for tdmcp, deduped and reconciled against the roadmap. This harness *finds and ranks* ideas; the `tdmcp-pipeline` harness *builds* the chosen ones. Keep the boundary crisp: discovery answers "what should we consider next?", pipeline answers "build this."

## Execution mode: sub-agent fan-out → fan-in

| Stage | Mode | Why |
|---|---|---|
| Survey | sub-agent (fan-out, parallel) | the five surveyors are fully isolated — each owns one surface, no inter-comms needed; the textbook fan-out case (mirrors the pipeline's design/build stages) |
| Synthesize | sub-agent (×1) | a single reasoning-heavy consolidation pass over result files — no producer↔reviewer loop, so no team needed |

No `TeamCreate` here — surveys are pure result-passing via files, so sub-agents are the right tool over team overhead. All `Agent` calls use `model: "opus"`.

## Agent roster

| Agent | Type | Skill | Output |
|---|---|---|---|
| `td-surveyor` (×up to 5) | custom | `td-feature-survey` | `_workspace/discovery/01_survey_<surface>.md` |
| `td-synthesizer` | custom | `td-feature-synthesize` | `_workspace/discovery/FEATURE_BACKLOG.md` |

The five surfaces: `controls` (Layer 1/2 creation & performance), `library` (vault + recipes + `.tox`/component packaging + distribution), `cli` (CLI/DX), `ai` (prompts + local-LLM copilot), `td-depth` (Layer 3 + bridge + operator KB).

## Workflow

### Phase 0 — context check (follow-up support)

1. Check whether `_workspace/discovery/` exists.
2. Decide the run mode:
   - **No `_workspace/discovery/`** → fresh run. Go to Phase 1.
   - **Exists + user asks to refresh/deepen/re-prioritize part** → partial re-run. Re-invoke only the affected surveyor(s) and/or the synthesizer, passing prior artifact paths so they refine rather than rewrite.
   - **Exists + a materially new ask (e.g. post-release, new competitor)** → new run. Move the old dir to `_workspace/discovery_<YYYYMMDD_HHMMSS>/`, then Phase 1.

### Phase 1 — prepare

1. Determine **scope**: by default survey all five surfaces. If the user scoped it ("just CLI ideas", "AI features only"), survey only those surface(s).
2. Determine the **weighting profile** for synthesis: default `live-show`; if the user signals otherwise ("favour quick wins", "what closes competitor gaps", "make the agent cheaper"), pass `quick-win` / `parity` / `agent-dx` to the synthesizer in Phase 3.
3. Create `_workspace/discovery/`.

### Phase 2 — survey (sub-agent fan-out, parallel)

Spawn one `td-surveyor` per in-scope surface **in a single message** (`subagent_type: "td-surveyor"`, `model: "opus"`). Each prompt states its surface assignment (`controls` / `library` / `cli` / `ai` / `td-depth`), the hard rule **stay inside your surface; write `_workspace/discovery/01_survey_<surface>.md` incrementally**, and asks for a short summary return (counts + headline ideas) so the leader's context stays lean.

**Resilience (transient errors are common at this fan-out width).** When the batch returns, *verify by file, not by return value*: check that each in-scope `01_survey_<surface>.md` exists and looks complete (has a tally). For any surface whose agent returned a socket/API error or left a missing/truncated file, **re-spawn just that one surveyor once** before synthesis — the incremental writes mean a retry resumes cheaply. If a surface still fails after one retry, proceed without it and record the gap (the synthesizer notes coverage). Do not block the whole run on one surface.

### Phase 3 — synthesize (sub-agent ×1)

Spawn one `td-synthesizer` (`model: "opus"`), telling it the **weighting profile** from Phase 1 (default `live-show`). It reads every `01_survey_*.md`, plus `docs/ROADMAP.md` / `AGENTS.md` / `CHANGELOG.md` / competitive memory, dedupes, reconciles against the roadmap, prioritizes under that profile (high-confidence first within each tier), and writes `_workspace/discovery/FEATURE_BACKLOG.md`. It returns a self-contained prose summary.

*Single-surface shortcut:* if only one surface was in scope, you may skip the synthesizer and relay that survey directly — but still run it through synthesis if the user wants priority/roadmap reconciliation.

### Phase 4 — report + handoff

1. Relay the synthesizer's summary to the user (in their language): headline NEW ideas, the recommended shortlist, and any coverage gap. Point to `_workspace/discovery/FEATURE_BACKLOG.md`.
2. Offer the handoff: any chosen items can go straight to the **`tdmcp-pipeline`** build harness.
3. Offer the Phase-7 evolution loop (feedback → tune the surveyor/synthesizer skills). Preserve `_workspace/discovery/` for audit.

## Data flow

```
[leader] ──scope──▶ td-surveyor ×5 (parallel, one message)
   controls │ library │ cli │ ai │ td-depth
        └── each writes _workspace/discovery/01_survey_<surface>.md ──┐
            (leader retries any that errored, once)                   ▼
                                          td-synthesizer (reads 5 + roadmap, weighting profile)
                                                      │
                                       _workspace/discovery/FEATURE_BACKLOG.md
                                                      │
                                   summary relayed ──▶ user ──▶ (optional) tdmcp-pipeline
```

## Error handling

| Situation | Strategy |
|---|---|
| One surveyor returns thin/empty | Keep its (small) report; synthesizer notes the lean surface. Don't block the batch. |
| One surveyor returns a socket/API error or a missing/truncated file | **Re-spawn just that one surveyor once** (incremental writes make the retry cheap). Only if it fails again, synthesize from the surveys that landed and name the uncovered surface in the coverage line. |
| Surveyor cites an unconfirmed operator | Idea is kept with `UNVERIFIED — probe live`; the flag rides through into the backlog so the build pipeline validates first. |
| Two surveys overlap on the same idea | Synthesizer merges into one entry under the best-fit surface with a cross-ref; not an error. |
| User scoped to one surface | Spawn only that surveyor; skip or keep synthesis per whether they want prioritization. |
| `_workspace/discovery/` already exists | Phase 0 decides partial-refresh vs. new-run; never silently overwrite a prior backlog. |

## Test scenarios

**Normal:** user asks "what new features could we add?" → Phase 1 sets scope = all five, profile = `live-show` → 5 `td-surveyor` fan out in one message, each writing its `01_survey_*.md` incrementally → leader verifies all five files landed (re-spawns any that errored, once) → `td-synthesizer` merges, dedupes against ROADMAP Phase 13 / deferred-v0.6.0+, ranks into P0/P1/P2 (high-confidence first), writes `FEATURE_BACKLOG.md` → leader relays the executive summary + Top-N shortlist and offers to feed picks into `tdmcp-pipeline`.

**Error / scoped:** user asks "just give me CLI feature ideas" → scope = `cli` only → one `td-surveyor` runs → synthesizer (or direct relay) reconciles the CLI candidates against the roadmap and reports; the other three surfaces are explicitly out of scope, noted in the coverage line.
