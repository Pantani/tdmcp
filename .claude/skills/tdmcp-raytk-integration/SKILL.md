---
name: tdmcp-raytk-integration
description: "Plan and implement native RayTK (t3kt/raytk) raymarching/SDF toolkit integration into tdmcp — beyond the existing package-manager staging, into AI-driven RayTK operator (ROP) node graphs. Use whenever the user wants to build, plan, design, implement, continue, fix, QA, or ship RayTK support: create/wire RayTK ROPs, a RayTK operator knowledge catalog, a RayTK-native raymarch/SDF scene tool, RayTK recipes, or the RayTK setup/doctor flow — including follow-ups (re-run, continue, refresh after a new RayTK release, re-QA, docs). Also triggers on 'raytk', 'raymarching toolkit', 'SDF toolkit', 't3kt', 'montar um build para o raytk', 'integrar o raytk'. This owns RayTK integration specifically; use it before the generic tdmcp-pipeline for this feature. Simple questions about RayTK can be answered directly."
---

# tdmcp-raytk-integration — orchestrator

Coordinate the dedicated team that integrates the external **RayTK** toolkit into
tdmcp as native operators. tdmcp already *stages* RayTK's `.tox` (the `raytk` manifest
in `src/packages/registry.ts`, via `manage_packages`) and ships its **own GLSL**
raymarching (`createRaymarchScene`/`createSdfField`/`createSdfText`). This harness
builds the missing layer: driving RayTK's ~300 ROPs as an **editable node graph**
(SDF primitives → combine → material → camera → render TOP) so the artist gets a
RayTK-native network, not another opaque GLSL string. The GLSL tools stay
complementary — never overwrite or shadow them.

## Execution mode

Sub-agents, not `TeamCreate` (this repo's convention). Hybrid:

| Phase | Mode | Reason |
|---|---|---|
| Map | `raytk-cartographer` sub-agent | external toolkit facts must be researched + cited before design |
| Plan | `raytk-integration-lead` (or local lead) | dependency-order the waves, set write scopes |
| Build | parallel `td-builder` sub-agents (disjoint new files) | one ROP tool + msw test each |
| Bridge | `tdmcp-bridge-engineer`, sequential | only if exec→REST is justified; bridge slices share files |
| Integrate/docs | `raytk-integration-lead` single-writer | registries, CLI, registry manifest, recipes, docs are shared |
| QA/fix | `td-qa` fan-in | offline gates + live TD PASS/UNVERIFIED accounting |

Spawned agents use the inherited model unless the user asks otherwise.

## Agent roster

| Agent | Role | Skills | Output |
|---|---|---|---|
| `raytk-cartographer` | map RayTK release, TD version gate, ROP taxonomy, wiring mechanism | web research | `_workspace/raytk-integration/01_map.md` |
| `raytk-integration-lead` | wave plan, briefs, single-writer integration, live validation | this skill, `td-feature-integrate` | `_workspace/raytk-integration/00_plan.md` + final report |
| `td-architect` | Layer 1 scene spec (schema, topology, test plan) | `td-feature-design` | `_workspace/raytk-integration/spec_*.md` |
| `td-builder` | one isolated ROP/scene tool file + msw test | `td-feature-build` | new files only |
| `tdmcp-bridge-engineer` | REST endpoint + client + validator, only if needed | `tdmcp-bridge-endpoint` | bridge slice |
| `td-qa` | gates, boundary QA, live TD validation | `td-feature-qa` | `_workspace/raytk-integration/04_qa.md` |
| `td-releaser` | CHANGELOG/version/tag — only when user asks to ship | `td-feature-release` | release commit |

## Source of truth

Read before changing code:

1. `_workspace/raytk-integration/01_map.md` (cartographer). If absent, run W0 first.
2. `src/packages/registry.ts` (`raytk` manifest) + `src/tools/layer3/managePackages.ts`.
3. `src/tools/layer1/createRaymarchScene.ts`, `createSdfField.ts`, `createSdfText.ts`,
   `recipes/raymarch_*.json` — the complementary GLSL surface, to avoid collisions.
4. `.claude/skills/tdmcp-tool-builder/SKILL.md` — the builder contract.

## Workflow

### Phase 0 — context check

1. `git status --short`.
2. Check `_workspace/raytk-integration/`.
3. Run mode: no workspace → fresh run; workspace + "continue/fix/update" → resume the
   affected wave only; workspace + a **new RayTK release** or new direction → re-run
   W0 (cartographer) first, then diff downstream.
4. Check the bridge with `get_td_info` before any live claim; note the TD build so the
   RayTK version gate can be evaluated.

### Phase 1 — map (W0)

Spawn `raytk-cartographer`. It pins the release, the TD version gate (e.g. 0.46 → TD
2025.30770+, not the 2023 builds), the ROP taxonomy, the instancing/wiring mechanism,
and the gap vs. what tdmcp already ships. Gate: `01_map.md` written with cited facts.

### Phase 2 — plan (W1 scope)

`raytk-integration-lead` writes `00_plan.md`: waves W1–W5 (setup/doctor → knowledge
import → ROP instancing → Layer 1 scene + recipes → docs), owners, write scopes, gates,
PASS/UNVERIFIED criteria. **Checkpoint with the user after the plan** before large build
waves, unless they said to run autonomously.

### Phase 3 — implement, wave by wave

For each wave: spawn the owner(s) — parallel for disjoint new files, sequential for
bridge slices — then the lead integrates as single writer and runs the gates
(typecheck, build, `./node_modules/.bin/biome check .`, test, `validate:recipes` /
`import:bottobot` when relevant). Do not start a wave whose dependency wave is not green.

### Phase 4 — QA + fix loop

Spawn `td-qa` incrementally after each integration: schema↔CLI↔docs↔registry coherence,
offline synthetic behavior, then live TD validation **only when a compatible TD build +
staged RayTK `.tox` are present** — wait for the async shader compile, check
`get_td_node_errors` after the cook, `get_preview` the output. Cap fix loops at 2–3
rounds, then report the blocker. Live checks without a compatible TD stay UNVERIFIED.

### Phase 5 — report + optional release

Report: files changed, commands + outcomes, PASS/FAIL/UNVERIFIED buckets, whether a real
RayTK node graph rendered, and what remains. Release (`td-releaser`) only when the user
explicitly asks; honor the no-premature-tag rule.

## Data flow

```text
RayTK docs/release  ->  raytk-cartographer (01_map)
  ->  raytk-integration-lead (00_plan)
  ->  td-architect spec ->  td-builder(s) [+ tdmcp-bridge-engineer]
  ->  raytk-integration-lead single-writer integration + gates
  ->  td-qa (offline + live) -> fixes -> final report
```

## Error handling

| Situation | Strategy |
|---|---|
| TD offline | Build/test offline; mark live checks UNVERIFIED pending bridge. |
| TD build predates RayTK version gate | Feature builds offline; live validation UNVERIFIED; state the required TD build. |
| RayTK `.tox` not staged/loaded | Run `manage_packages install raytk`; if still absent, surface the exact stage/load step. |
| Async shader still compiling | Wait/retry preview; never claim a green raymarch from a black frame. |
| ROP connector/master name varies by release | Probe live; keep both candidates with source in the report, don't guess. |
| Overlap with existing GLSL raymarch tools | Keep RayTK tools distinct (name + scope); document the complementary split. |
| Shared-file conflict | Only the lead edits shared files; stop and reconcile. |
| QA fail after 3 rounds | Hold the slice; report evidence + next fix. |

## Test scenarios

### Normal flow
User: "montar um build para integrar o RayTK." Orchestrator runs the cartographer,
writes the plan, checkpoints, then builds `create_raytk_op` + `create_raytk_scene` +
knowledge catalog wave by wave, integrates + gates each, QAs offline, and reports live
RayTK render as PASS or UNVERIFIED depending on the TD build.

### Error flow
TD build is a 2023 release (below the 0.46 gate). Orchestrator still ships the offline
tools + knowledge catalog + recipes with green gates, QA marks live RayTK checks
UNVERIFIED, and the report names the required TD build to validate on.

## Trigger validation

Should trigger:
- "montar um build para o raytk" / "integrar o raytk no tdmcp"
- "implementa suporte a RayTK / operadores de raymarching nativos"
- "cria a ferramenta create_raytk_scene" / "catálogo de ROPs do RayTK"
- "continua a integração do raytk" / "atualiza depois do novo release do RayTK"
- "QA da integração RayTK" / "documenta o RayTK"
- "t3kt raytk SDF toolkit no tdmcp"

Should not trigger:
- generic "instala um pacote do TD" with no RayTK intent (that's `manage_packages`)
- work on the existing GLSL `createRaymarchScene` unrelated to RayTK
- Shader Park / MediaPipe / other package integrations
- broad feature discovery or backlog campaigns across many features
- Kinect wall harp, mixer, or directory-submission work
