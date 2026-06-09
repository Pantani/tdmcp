---
name: tdmcp-hype-scout
description: "Scout the TouchDesigner community for what's HYPED right now — community showcases, recent tutorials, generative-AI bridges, hardware interaction trends, visual-aesthetic trends of 2025-2026 — then propose tdmcp tools that ride those trends AND are easy to build. Use whenever the user wants to brainstorm new feature ideas based on what's trending in TouchDesigner, asks for 'hype' or 'trending' features, asks 'what are people doing in TD right now / what's hot / what's hype', wants tools inspired by community trends, asks to scout TD trends/aesthetics/integrations, or says things like 'ideias hype', 'novas ideias', 'o que está em alta', 'criar ferramentas para o que está bombando', 'tendências do TouchDesigner'. Also for follow-ups: refresh, rescout one surface, re-rank under another profile, deepen a trend, or filter for buildable-easy items. This is an EXTERNAL trend ideation harness — complementary to tdmcp-feature-discovery (which is INTERNAL gap analysis). It produces `_workspace/hype-scout/HYPE_TOOL_BACKLOG.md` ranked by Hype × Build-Ease; it does NOT build. Once a feature is chosen from the backlog, hand it to tdmcp-pipeline."
---

# tdmcp-hype-scout — external trend ideation orchestrator

Coordinate a fan-out of trend scouts + one synthesizer to produce a single prioritized **hype tool backlog** for tdmcp, grounded in cited community evidence and vetted against the real codebase. This harness *finds and ranks trend-driven tool ideas*; the `tdmcp-pipeline` harness *builds* the chosen ones. Keep the boundary crisp: hype-scout answers "what's the TD community hyped about, and which of that could we easily turn into a tool?", pipeline answers "build this tool".

**Boundary vs `tdmcp-feature-discovery`:** that skill does *internal* gap analysis (what's missing in tdmcp vs roadmap). This skill does *external* hype analysis (what's trending in the TD community). They are complementary — both can run and feed into each other.

## Execution mode: sub-agent fan-out → fan-in

| Stage | Mode | Why |
|---|---|---|
| Scout (×5) | sub-agent (fan-out, parallel) | scouts are fully isolated — each owns one surface, no inter-comms needed; mirrors the proven `tdmcp-feature-discovery` shape |
| Synthesize | sub-agent (×1) | a single reasoning-heavy consolidation pass over result files — no producer↔reviewer loop, so no team needed |

No `TeamCreate` here — scouts pass results via files, so sub-agents are the right tool over team overhead. All `Agent` calls use `model: "opus"`.

## Agent roster

| Agent | Type | Skill | Output |
|---|---|---|---|
| `td-trend-scout` (×up to 5) | custom | `td-trend-scout` | `_workspace/hype-scout/01_scout_<surface>.md` |
| `td-hype-synthesizer` | custom | `td-hype-synthesize` | `_workspace/hype-scout/HYPE_TOOL_BACKLOG.md` |

The five surfaces:
- `community-showcase` — TD forum, Instagram, Vimeo (finished work)
- `tutorials` — YouTube channels + courses (what's being taught now)
- `generative-ai` — StreamDiffusion/ComfyUI/realtime-ML bridges into TD
- `hardware-interactive` — LiDAR / depth / hand-tracking / sensors
- `vfx-aesthetics` — dominant visual languages of 2025-2026

## Workflow

### Phase 0 — context check (follow-up support)

1. Check whether `_workspace/hype-scout/` exists.
2. Decide the run mode:
   - **No `_workspace/hype-scout/`** → fresh run. Go to Phase 1.
   - **Exists + user asks to refresh / rescout one surface / re-rank** → **partial re-run**. Re-invoke only the affected scout(s) and/or the synthesizer, passing prior artifact paths so they refine rather than rewrite.
   - **Exists + a materially new ask** (e.g. "rescout 6 months later", new aesthetic moment) → **new run**. Move the old dir to `_workspace/hype-scout_<YYYYMMDD_HHMMSS>/`, then Phase 1.

### Phase 1 — prepare

1. Determine **scope**: by default scout all five surfaces. If the user scoped it ("just AI integration trends", "only aesthetic trends", "só hardware"), scout only those surface(s).
2. Determine **profile** for the synthesizer ranking: default is `Hype × Build-Ease`. The user can pick `hype-only`, `quick-wins`, `strategic`, or `conservative` (see `td-hype-synthesize` skill).
3. Create `_workspace/hype-scout/` (or reuse, per Phase 0).
4. Briefly tell the user: "Scouting <N> surfaces in parallel, then synthesizing. Expected output: `_workspace/hype-scout/HYPE_TOOL_BACKLOG.md`."

### Phase 2 — fan-out scouts (parallel sub-agents)

Spawn one `td-trend-scout` per in-scope surface, **in parallel** (a single message with multiple `Agent` tool calls). Each call:

```
subagent_type: td-trend-scout
model: opus
description: "Scout <surface> for TD hype trends"
prompt: |
  You are the td-trend-scout for surface = "<surface>".

  Load your skill (`td-trend-scout`) and follow it. Produce
  `_workspace/hype-scout/01_scout_<surface>.md` with cited candidates
  ranked per the entry format.

  If `_workspace/hype-scout/01_scout_<surface>.md` already exists, read
  it first and apply only the requested change: "<change-request-or-fresh>".

  Cite real URLs from 2025-2026 where possible. ≥2 citations per entry.
  Write incrementally so a partial run is still useful.
```

While scouts run, do not work on the synthesis — wait for all to return.

**Failure policy (per scout):** if a scout returns an error, retry it **once** with the same prompt. If it fails again, mark that surface as `SCOUT MISSING` and proceed to synthesis without it. Do not block the whole run on one surface.

### Phase 3 — synthesize (single sub-agent)

After all scouts return (or are quarantined), spawn one `td-hype-synthesizer`:

```
subagent_type: td-hype-synthesizer
model: opus
description: "Synthesize hype scouts into HYPE_TOOL_BACKLOG.md"
prompt: |
  You are the td-hype-synthesizer.

  Load your skill (`td-hype-synthesize`) and follow it. Read every
  `_workspace/hype-scout/01_scout_*.md`, dedupe across surfaces, vet
  feasibility against the real codebase, rank under profile = "<profile>",
  and produce `_workspace/hype-scout/HYPE_TOOL_BACKLOG.md`.

  If a scout file is missing, note `SCOUT MISSING: <surface>` at the top
  of the output and proceed.

  If `HYPE_TOOL_BACKLOG.md` already exists, read it first and apply only
  the requested change: "<change-request-or-fresh>".
```

### Phase 4 — user-facing summary

Once the synthesizer returns, present a concise summary to the user:

1. One-line headline: "Top trend = X, top buildable = Y."
2. The **Top 5 "Ready for tdmcp-pipeline"** list (just names + 1-line value each).
3. Any **Force multipliers** identified.
4. Pointer to the full file: `_workspace/hype-scout/HYPE_TOOL_BACKLOG.md`.
5. Next-step prompt: "To build one of these, run `tdmcp-pipeline` with the chosen tool. To re-rank, ask for a different profile (hype-only / quick-wins / strategic / conservative). To rescout one surface, name it."

Keep it short — the file holds the depth.

## Data flow

- **File-based** between scouts and synthesizer (each scout writes its own file; synthesizer reads them all).
- **Return-value-based** from synthesizer to orchestrator (file path + 1-line headline).
- All artifacts live under `_workspace/hype-scout/`. Never under the project root.

## Error handling

| Failure | Strategy |
|---|---|
| Scout sub-agent errors out | retry once with same prompt; on second failure, mark `SCOUT MISSING: <surface>` and proceed |
| Scout returns but `01_scout_<surface>.md` is missing | retry once; on second failure, treat as `SCOUT MISSING` |
| Scout tags file `PARTIAL-DUE-TO-NETWORK` | accept; synthesizer will propagate the flag |
| Synthesizer errors out | retry once; on second failure, ask the user (rare — synthesis is offline file work) |
| Conflict between scouts | synthesizer averages + annotates per skill — do not intervene |

## Follow-up handling (re-invocation)

Common follow-ups and how to route them:

- **"refresh the backlog"** → re-run all scouts (Phase 2) + synthesizer (Phase 3) with `<change-request-or-fresh>` = "refresh citations and add any new 2026 trends; preserve prior numbering where possible".
- **"rescout only <surface>"** → re-run that one scout + the synthesizer (skip the other scouts).
- **"re-rank by quick-wins"** → skip scouts, re-run synthesizer with `<profile> = quick-wins`.
- **"deepen trend X"** → re-run the scout for trend X's surface with `<change-request-or-fresh>` = "deepen entry X with more citations and a sharper tool sketch"; then re-run synthesizer.
- **"build #N"** → do **not** build here. Hand off to `tdmcp-pipeline` with the candidate id and detail block as input.

## What this skill does NOT do

- It does **not** build tools — `tdmcp-pipeline` does.
- It does **not** do internal gap analysis — `tdmcp-feature-discovery` does.
- It does **not** drive a multi-release campaign — `tdmcp-backlog-campaign` does.
- It does **not** spawn the build agents (`td-architect`, `td-builder`, etc.). Only spawns `td-trend-scout` and `td-hype-synthesizer`.

## Test scenario (normal flow)

> User: "ideias hype — o que está bombando no TouchDesigner agora? quero ferramentas fáceis de criar com o tdmcp"
>
> 1. Phase 0: no `_workspace/hype-scout/` yet — fresh run.
> 2. Phase 1: scope = all 5 surfaces, profile = default.
> 3. Phase 2: spawn 5 `td-trend-scout` sub-agents in parallel (one Agent call per surface, single message).
> 4. Phase 3: spawn 1 `td-hype-synthesizer` with the 5 scout outputs.
> 5. Phase 4: present Top-5 + Force multipliers + pointer to backlog file.

## Test scenario (error flow — one scout fails)

> 1. 4 scouts return cleanly; `generative-ai` scout errors out.
> 2. Retry `generative-ai` scout once → still fails (e.g. WebFetch rate-limited).
> 3. Note `SCOUT MISSING: generative-ai` and proceed to Phase 3.
> 4. Synthesizer notes the gap at the top of `HYPE_TOOL_BACKLOG.md`.
> 5. Phase 4 summary mentions the missing surface and suggests "rescout generative-ai later".
