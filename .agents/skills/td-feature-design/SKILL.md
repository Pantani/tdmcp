---
name: td-feature-design
description: "Design a tdmcp feature into an implementable spec before any code is written — choose the layer, define the Zod input schema, lay out the TD network topology, plan the bridge/Python approach, sketch a UI wireframe when relevant, and list probe-first risks + the test plan. Use whenever a tdmcp feature idea needs a design/wireframe/spec, or when someone asks to plan/scope/architect a new tool, generator, effect, control, or AI prompt for the TouchDesigner MCP server."
---

# td-feature-design — turn an idea into an implementable spec

A spec is good when a builder can implement it in one file + one test without re-deciding anything. Aim for that bar.

## Procedure

1. **Read the context first.** `docs/ROADMAP.md` (the idea is usually already scoped there), `AGENTS.md` (the conventions), and 1–2 neighbour tools in the target `src/tools/layer*/` for the exact file pattern.
2. **Pick the layer / altitude:**
   - Layer 1 (`src/tools/layer1/`) — an artist tool that builds a whole wired+arranged network (goes through `orchestration.ts`).
   - Layer 2 (`src/tools/layer2/`) — a building block (connect, control panel, animate, external IO).
   - Layer 3 (`src/tools/layer3/`) — atomic node CRUD / inspection / raw-Python escape hatch.
   - `src/tools/vault/` — Obsidian-vault bridge. A `src/prompts/` entry — when the value is guidance to the model, not a deterministic build (multimodal / natural-language / critique ship as prompts).
   - Decide the file path now: `src/tools/layer<N>/<camelCaseName>.ts`.
3. **Design the Zod input schema** — a param table: name, type, default, enum values, notes. Defaults matter: device-sourced inputs (camera/audio) default to a **synthetic/file source** (live device is opt-in) because device capture can hang TD on a macOS permission modal.
4. **Lay out the TD network topology** — the operators it creates, how they wire, and the live controls it exposes. Reactive features must end on a **Null CHOP ready for `bind_to_channel`**, reusing the shipped binding path instead of inventing one. Verify every operator type against the KB (`tdmcp://operators/…` or `search_operators`) — never invent a type.
5. **Plan the bridge approach** — almost always a Python payload via `buildPayloadScript` (`__PAYLOAD_B64__`) executed through the client and parsed with `parsePythonReport`. Propose a new REST endpoint only when streaming or performance genuinely demands it.
6. **Sketch a UI wireframe** when the feature has a surface (control panel / control surface / phone remote / web dashboard / chat UI): an ASCII layout or component list naming each control and what parameter it drives.
7. **List probe-first risks** — anything to validate live before locking the API: platform-specific operators (Syphon/Spout/NDI/Video-Stream-Out exist only on some OS/licenses), KB-missing operators (the KB lags ~14 recent ops; ~22 dir(td) names aren't createable), device permissions, and time-dependent chains that read 0 on a paused timeline.
8. **Write the test plan** — what the offline msw unit test should assert (operators created, params set, wiring, the returned shape).
9. **Write integration notes** — exactly which shared files the integrator must edit (`layer*/index.ts`, `src/cli/agent.ts` command name + flags, docs regenerate automatically).

## Output

One file per feature at `_workspace/01_design_<feature>.md` with these sections in order: Summary · Layer + target path · Input schema (param table) · Network topology · Bridge/Python approach · UI wireframe (if any) · Probe-first risks · Test plan · Integration notes.

## Anti-patterns

- Don't design a feature that needs the builder to edit shared files — that's the integrator's job; note it instead.
- Don't specify operators you haven't confirmed exist; mark them `UNVERIFIED — probe live`.
- Don't rebuild a shipped primitive (binding, tempo clock, preset/cue engine) — wire into it.
- Don't over-specify defensive params for states that can't occur; match the feature's real surface.
