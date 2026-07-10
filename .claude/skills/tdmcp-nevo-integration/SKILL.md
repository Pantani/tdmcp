---
name: tdmcp-nevo-integration
description: Study whether/how the external NEvo research project (EPFL/JHU — Neural-Guided Evolutionary Video Synthesis, arXiv 2607.02317, nevo-project.epfl.ch) can be integrated into tdmcp, then draft the resulting project. Use whenever the user wants to survey/raise the integration points for NEvo (or a similar external AI-video / evolutionary-synthesis research project), assess feasibility for generating video / real-time use / any interaction, or draft a tdmcp project from it — AND every follow-up: re-run, continue, refresh after a new NEvo release, scope to one surface (e.g. "só o LTX-Video", "só o método evolutivo"), fold in a decision, or go from the points map to the project draft ("agora rascunha o projeto", "levantar os pontos", "montar o build do nevo"). Runs a fan-out of nevo-integration-scouts → 1 nevo-integration-architect. This is a STUDY+DRAFT harness — it produces INTEGRATION_POINTS.md then PROJECT_DRAFT.md; it does NOT build. Once a deliverable is chosen, hand it to tdmcp-pipeline.
---

# tdmcp-nevo-integration

Two-phase, resumable study of a NEvo→tdmcp integration. **Levantar os pontos** first
(map every integration surface from primary sources), **rascunhar o projeto** second
(scope concrete tdmcp deliverables). It maps and drafts — it never edits product
source. Buildable deliverables are handed off to `tdmcp-pipeline` afterward.

Why a harness and not a single pass: the surfaces (hosted media lane, TD realtime
materialization, the evolutionary method, the scoring backbone, availability/license)
are independent and each needs primary-source verification. Parallel scouts cover them
faster and more honestly than one agent recalling facts; one architect then reconciles.

Execution mode: **sub-agents (fan-out/fan-in)** — this environment has no TeamCreate.
All Agent calls use `model: "opus"`. Data flows file-based under `_workspace/nevo/`.

## Phase 0 — context check

- `_workspace/nevo/` absent → initial run.
- `_workspace/nevo/` present + user asks to draft → skip to Phase 3 (architect Phase B).
- `_workspace/nevo/` present + user scopes one surface → re-run only that scout, then
  re-synthesize.
- New NEvo release / new input → move `_workspace/nevo/` to `_workspace/nevo_prev/`, fresh run.

## Phase 1 — brief

Write `_workspace/nevo/00_brief.md`: the goal, the confirmed NEvo reality (research
method, off-the-shelf LTX-Video/V-JEPA 2, no code/API, CC BY 4.0), the five surfaces,
and whether the user wants only-points or points+draft this run.

## Phase 2 — fan-out scouts (levantar os pontos)

Spawn one `nevo-integration-scout` per surface, in parallel (`run_in_background: true`,
`model: "opus"`): `media-lane`, `td-realtime`, `evolutionary-method`,
`scoring-backbone`, `availability-license`. Each writes `10_scout_<surface>.md`.
Scope to a subset when the user asked for one surface.

## Phase 3 — synthesize + draft

Spawn `nevo-integration-architect` (`model: "opus"`). Phase A always →
`INTEGRATION_POINTS.md`. Phase B only if the brief says draft → `PROJECT_DRAFT.md`.
Relay the verdict, the ranked points, the realtime/license honesty, and the open
questions back to the user. Recommend which deliverable (if any) to hand to
`tdmcp-pipeline`.

## Data & error handling

- File-based under `_workspace/nevo/`; keep intermediates for audit.
- One retry per failed scout, then proceed noting the gap in the synthesis.
- Conflicting facts across scouts are kept with both sources, never silently dropped.
- Never claim a runtime/latency behavior as verified — mark probe-first.

## Test scenarios

- Normal: initial run → 5 scouts → architect Phase A → points map; user says "rascunha"
  → architect Phase B → project draft.
- Scoped: "só a lane de vídeo hospedado" → only `media-lane` scout re-runs → architect
  updates the media rows of INTEGRATION_POINTS.md.
- Error: `availability-license` source 404s → scout marks rows UNVERIFIED → architect
  flags license as an open question blocking the evolutionary/backbone deliverables.
