---
name: td-impl-explore
description: Explore ONE implementation axis for bringing AI image/texture generation (WAN 2.5, fal.ai, Replicate, ComfyUI, StreamDiffusion, etc.) into tdmcp — inventory the options on that axis, ground them in the real tdmcp codebase and in official external docs, score latency/cost/offline/effort/risk, and emit a structured axis report to _workspace/ai-texture-study/. Use whenever a td-impl-explorer agent is assigned an axis in the AI-texture implementation study, including re-runs ("refresh the hosted-API axis", "deepen the local-generation report").
---

# td-impl-explore — one axis of the AI-texture implementation study

You study ONE axis (named in your spawn prompt). Produce a comparison, not a pitch: the synthesizer will make the final call across axes.

## Method

1. **Scope the axis** — restate in 2-3 lines what is in/out of your axis, so overlaps with sibling axes are explicit.
2. **Ground internally first.** Read the tdmcp pieces your axis touches before searching the web. Common anchors:
   - `src/tools/types.ts` (ToolContext), `src/server/context.ts` (buildToolContext)
   - `src/tools/layer2/orchestration.ts` (NetworkBuilder + finalize: layout→controls→checkErrors→preview)
   - `src/utils/config.ts` (`TDMCP_*` env pattern), `src/tools/result.ts` (errorResult, never-throw)
   - `td/` bridge endpoints + exec fallback; `src/td-client/touchDesignerClient.ts`
   - `docs/ROADMAP.md` Milestone 4 (generative-AI bridge wave) — note what is already planned
3. **Ground externally.** Prefer official docs/repos (fal.ai model pages, Replicate docs, ComfyUI/StreamDiffusion GitHub, Derivative docs for TOPs/Spout/NDI). Record the URL per claim. Pricing/limits: quote only what a source states; otherwise write "not published".
4. **Score each option** — table columns: option, how it works (1 line), latency class (realtime / seconds / tens-of-seconds), cost model, offline behavior, effort (S/M/L against house patterns), risks.
5. **Recommend 1-2 options** for your axis with the trade-off stated plainly.
6. **Write incrementally** to `_workspace/ai-texture-study/0{N}_explorer_{axis}.md` — create the file with Scope early, append as you learn. On re-runs, update in place.

## House constraints every option must respect
- Secrets only via `TDMCP_*` env; never in the TD process or bridge args.
- Tools never throw: missing key / TD offline / provider error → friendly `errorResult`.
- Offline CI: any network call must be msw-mockable.
- Bridge work follows the endpoint + exec-fallback slice pattern (`tdmcp-bridge-endpoint`).

## Report skeleton
```
# Axis: <name>
## Scope
## Options
| option | how | latency | cost | offline | effort | risks |
## Evidence
- claim → source (file:line or URL)
## Recommendation
## Open questions
```
