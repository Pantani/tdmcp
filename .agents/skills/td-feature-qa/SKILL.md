---
name: td-feature-qa
description: "Quality-assure integrated tdmcp features: run the four PR gates + recipe/bridge tests, cross-boundary coherence checks (tool schema↔CLI↔docs↔registry, operator↔createable, bridge↔client), and live TouchDesigner validation (preview + post-cook error check) when the bridge is reachable. Use when validating/QA-ing/testing tdmcp tools, checking a feature actually cooks in TD, verifying CLI matches a tool, or gating a release."
---

# td-feature-qa — verify it works, not just exists

Most defects here live at **boundaries**, and a tool that returns success can still cook to errors or a black frame. So: read both sides of every boundary together, and check errors **after the network cooks**, not just the `create_*` return flag. Run incrementally — validate each feature as it lands so an early boundary bug doesn't propagate.

## Gates + suites — always run (offline, no TD needed)

- `npm run typecheck` · `npm run build` · `npm test`
- biome via `./node_modules/.bin/biome check .` (NOT `npm run lint` — RTK proxy gives a false ESLint parse error)
- `npm run validate:recipes` · `npm run test:bridge` (`python3 -m unittest discover -s td/tests`)

## Cross-boundary checks — open both sides

| Boundary | Left (producer) | Right (consumer) | Compare |
|---|---|---|---|
| Tool ↔ CLI | tool's Zod `inputSchema` | command in `src/cli/agent.ts` | every param reachable from CLI; types/defaults align; name maps to the right handler |
| Tool ↔ registry | `register…` export | `layer*/index.ts` + `tools/index.ts` | actually registered + aggregated, not just written |
| Tool ↔ docs | live registry | generated `docs/reference/tools.md` | regenerates and includes the new tool |
| `…Impl` ↔ test | real return / `isError` shape | msw test assertions | test exercises the actual shape, not a cast-away generic |
| Code ↔ TD | operator types created | what this build can create | optype exists + is createable (dir(td) suffix-match over-counts; ~22 names not createable; KB lags ~14 ops) |
| Bridge ↔ client | `td/` endpoint/payload | `touchDesignerClient.ts` + `validators.ts` envelope | response shape matches the Zod validator |

## Live TD validation — when the bridge is up

Policy: **offline gates always; live when available.** Call `get_td_info` first.
- **Bridge up:** build the feature through the agent CLI against the live bridge, capture `get_preview`, and check `get_td_node_errors` **after it cooks**.
- **Bridge offline:** run offline gates, mark live validation **UNVERIFIED — pending bridge** in the report. Do not fail the pipeline for a missing TD.

Live gotchas to rule out before declaring a bug:
- Silent failures: a Level TOP has no `gain` (it's `brightness1`); no cross-container wires (Select TOP).
- Paused timeline: time-dependent chains (motion / frame-diff / feedback / beat) read **0** when `op('/').time.play` is false — check it before concluding a reactive chain is dead.
- Staleness: a connected `mcp__tdmcp__*` runs the **old build** until restarted; editing `td/` doesn't reload the running bridge (`reload_bridge` / restart) — suspect stale modules before "fixing" correct code.
- GLSL: needs `out vec4 fragColor` + a self-supplied time uniform.
- Device sources can hang TD on a macOS permission modal — validate the synthetic/file source first.

## Output

A report at `_workspace/04_qa_<feature|batch>.md` with three explicit buckets — **PASS**, **FAIL** (`file:line` + concrete fix + owning agent), **UNVERIFIED** (what wasn't checked + why, e.g. bridge offline). Never silently skip a check; list it as UNVERIFIED.

## Fix loop

- Send each defect immediately to its owner (`td-builder` for handler/schema/test, `td-integrator` for wiring/CLI/docs); boundary bugs go to **both**. Re-validate after each fix.
- Cap at ~2–3 rounds per feature; if still failing, report a blocker with full findings instead of looping.
- If a gate fails due to a concurrent agent's unrelated in-flight WIP, say so and validate your slice in isolation (`vitest run <yourfile>`).
