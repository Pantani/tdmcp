---
name: td-impl-synthesize
description: Consolidate all td-impl-explorer axis reports from _workspace/ai-texture-study/ into one decision-ready IMPLEMENTATION_STUDY.md — cross-axis decision matrix, single recommended architecture (provider abstraction, delivery mode, layer placement) verified against the tdmcp codebase and roadmap, phased P0/P1/P2 plan routed to build harnesses, and rejected alternatives. Use whenever a td-impl-synthesizer agent runs at the end of the AI-texture implementation study, including re-synthesis after refreshed axis reports ("re-synthesize", "update the study", "fold in the new axis report").
---

# td-impl-synthesize — decision document for the AI-texture study

## Method

1. **Read everything**: every `0*_explorer_*.md` in `_workspace/ai-texture-study/`, plus `docs/ROADMAP.md` (Milestone 4) and the code anchors the reports cite (spot-check at least: ToolContext wiring, orchestration finalize, config.ts). A recommendation that contradicts the code is invalid.
2. **Build the decision matrix**: rows = end-to-end approaches (provider × delivery × layer), not raw axis options. Columns: latency, cost, offline story, effort, risk, roadmap fit.
3. **Decide**: pick ONE recommended architecture. Where axes conflict, resolve with a stated reason and keep the alternative documented. Typical tensions to resolve explicitly:
   - hosted API vs local generation (cost/quality vs latency/privacy)
   - file-based delivery vs URL vs streaming (Spout/NDI/websocket)
   - Layer 2 building block vs Layer 1 one-shot vs both
4. **Phase the plan**:
   - P0 = smallest shippable MVP (S effort), P1 = hardening/expansion, P2 = ambitious (realtime etc.).
   - Each item: effort, files touched, and which harness builds it (`tdmcp-pipeline`, `tdmcp-bridge-endpoint`, `tdmcp-feature-lead`).
5. **Reconcile with roadmap**: mark each phase item as NEW / already-planned-M4 / extension-of-planned.
6. **Write** `_workspace/ai-texture-study/IMPLEMENTATION_STUDY.md`:
```
# AI Texture Generation — Implementation Study
## Executive summary (≤15 lines)
## Decision matrix
## Recommended architecture (with file paths)
## Phased plan (P0/P1/P2)
## Rejected alternatives (and why)
## Roadmap reconciliation
## Open questions for the user
```
7. Missing axis report → synthesize without it, list under Open questions. Never block.

On re-runs, diff against the existing study and update sections in place, noting what changed at the top.
