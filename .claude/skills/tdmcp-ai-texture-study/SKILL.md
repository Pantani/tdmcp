---
name: tdmcp-ai-texture-study
description: Orchestrate the AI texture/image-generation implementation STUDY for tdmcp (WAN 2.5, fal.ai, Replicate, ComfyUI, StreamDiffusion, ElevenLabs image, Spout/NDI delivery, etc.) — fan out one td-impl-explorer per implementation axis, then one td-impl-synthesizer into a decision-ready IMPLEMENTATION_STUDY.md. Use when asked to study/explore/compare/survey HOW to implement AI image or texture generation in tdmcp, "explorar todos os tipos de implementação", evaluate providers or delivery modes, AND for every follow-up: re-run the study, refresh/deepen one axis, re-synthesize, update the study after new info, or check study status. This harness DECIDES; it does not build — hand the chosen architecture to tdmcp-pipeline.
---

# tdmcp-ai-texture-study — orchestrator

**Execution mode:** sub-agents (no TeamCreate in this environment). Fan-out explorers in parallel → one synthesizer. Data flows via files in `_workspace/ai-texture-study/`.

## Phase 0: context check
- `_workspace/ai-texture-study/` missing → initial run (all axes).
- Reports exist + user asks to refresh/deepen one axis → re-spawn only that explorer, then re-synthesize.
- Reports exist + IMPLEMENTATION_STUDY.md exists + user brings new info → re-synthesis only, unless the info belongs to an axis (then refresh that axis first).

## Phase 1: fan-out (parallel, background, model opus)
Spawn one `td-impl-explorer` per axis, each told to load the `td-impl-explore` skill, its axis, and its output file:

| N | axis | scope |
|---|------|-------|
| 01 | hosted-apis | fal.ai (WAN 2.x, Flux, Seedream…), Replicate, ElevenLabs image, Stability — API shape, queue/polling, pricing, licensing, region limits |
| 02 | local-generation | ComfyUI (API + TD integrations), StreamDiffusion(TD), A1111, MLX/CoreML on macOS — install burden, GPU needs, latency |
| 03 | td-delivery | how pixels reach TD: file→moviefileinTOP, URL, scriptTOP/TopArray, Spout/Syphon, NDI, websocket — incl. what the bridge must add |
| 04 | tdmcp-architecture | provider abstraction in src/services, ToolContext wiring, config/env/security, caching, msw testing, layer 1 vs 2 placement |
| 05 | workflows-and-precedent | asset-gen vs realtime workflows artists actually use; what Milestone 4 already plans; prior art in other TD MCP/AI projects |

Prompt template per explorer: axis name + scope row + output path `_workspace/ai-texture-study/0N_explorer_<axis>.md` + "load skill td-impl-explore".

## Phase 2: synthesis (after all explorers finish)
Spawn `td-impl-synthesizer` (model opus, skill `td-impl-synthesize`) → `_workspace/ai-texture-study/IMPLEMENTATION_STUDY.md`.

## Phase 3: report + handoff
Summarize the recommendation to the user (decision matrix headline + P0). Offer to hand P0 to `tdmcp-pipeline`. Do NOT build here.

## Error handling
- Explorer fails/dies → retry once; on second failure synthesize without it (gap listed in Open questions).
- Synthesizer fails → retry once with explicit list of report paths.
- Partial reports are acceptable input (explorers write incrementally).

## Test scenarios
- Normal: initial run → 5 reports + study → user picks P0 → pipeline handoff.
- Error: axis 02 explorer dies twice → study ships with 4 axes + gap noted; user later says "refresh local-generation" → Phase 0 routes to single-axis re-run + re-synthesis.
