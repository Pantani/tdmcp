# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

tdmcp is an MCP (Model Context Protocol) server for TouchDesigner. Three programs
talk to each other on one machine:

```
MCP client ──stdio/HTTP──▶ tdmcp server (Node/TS, this repo) ──HTTP REST──▶ TD bridge (Python, td/)
(Claude / Cursor / Codex)   tools + operator knowledge base      runs inside TouchDesigner on :9980
```

The Node server exposes TouchDesigner "tools" + an embedded operator knowledge
base to an AI; the Python bridge running inside TD actually creates/connects/
inspects/previews nodes. The server stays usable when TD is offline (tools return
friendly errors).

## Commands

```bash
# First-time setup (knowledge base must be generated before build/test)
npm install
npm run import:bottobot      # populates src/knowledge/data from @bottobot/td-mcp
npm run build                # tsc + tsup + copy-assets -> dist/

# The four PR gates (CI runs these + validate:recipes + test:bridge)
npm run typecheck            # tsc --noEmit
npm run build
npm run lint                 # biome check .  (npm run format to auto-fix)
npm test                     # vitest run

npm run dev                  # run the server from TS (tsx src/index.ts), no build
npm run validate:recipes     # validate recipes/*.json against RecipeSchema

# Tests (offline; the bridge is mocked with msw — no TouchDesigner needed)
npx vitest run tests/unit/createWaveform.test.ts   # single file
npx vitest run -t "edge-blend"                      # single test by name
npm run test:bridge          # Python bridge tests: python3 -m unittest discover -s td/tests

# Local coverage harness (not a CI gate unless the workflow is updated)
npm run test:coverage        # vitest run --coverage, TS sources only
npm run coverage:harness     # coverage report + ranked next test gaps

# Docs (VitePress site under docs/)
npm run docs:dev             # docs:gen then vitepress dev
npm run build:mcpb           # bundle the one-click Claude Desktop .mcpb (formerly .dxt)
```

## Architecture

**Entry & wiring.** `src/index.ts` dispatches subcommands (`install-bridge`,
`chat`/`llm-run`) then `loadConfig` → `startTransport` → `createTdmcpServer`
(`src/server/tdmcpServer.ts`), which builds a `ToolContext` and registers all
tools, resources, and prompts.

**Dependency injection.** Every tool handler receives a `ToolContext`
(`src/tools/types.ts`): `{ client, knowledge, recipes, logger, vault?,
allowRawPython }`. It is assembled once in `buildToolContext`
(`src/server/context.ts`) — both the MCP server and the agent/chat CLIs build
their context here, so all surfaces share one core.

**Three tool layers** (`src/tools/layer{1,2,3}/`), so the AI can pick altitude:
- **Layer 1** — artist tools that build a whole wired+arranged network
  (`createAudioReactive`, `createFeedbackNetwork`, …). These go through
  `src/tools/layer1/orchestration.ts`.
- **Layer 2** — building blocks (`connectNodes`, `createControlPanel`,
  `animateParameter`, `createExternalIo`, …).
- **Layer 3** — atomic node CRUD + inspection + the raw-Python escape hatches
  (`createTdNode`, `findTdNodes`, `getTdNodeErrors`, `executePythonScript`, …).
- A separate `src/tools/vault/` group bridges an Obsidian vault.

**Tool file pattern (important — every tool follows it).** Each file exports an
`…Impl(ctx, args)` function (pure, unit-testable with a mocked client) **and** a
`register…: ToolRegistrar` that calls `server.registerTool(name, { …, inputSchema:
schema.shape }, (args) => …Impl(ctx, args))`. The registrar is added to that
layer's `index.ts` array; `src/tools/index.ts` aggregates all layers. To add a
tool: create the file, export both, add to the layer index.

**Never throw out of a handler.** Inputs are validated by a Zod `inputSchema`; TD
failures become friendly `isError` results via `errorResult`
(`src/tools/result.ts`), `runBuild`, and `friendlyTdError`.

**Layer 1 orchestration (`orchestration.ts`).** `createSystemContainer` makes a
fresh `baseCOMP`; `NetworkBuilder` adds/connects/sets-params **fail-forward**
(connection and param failures are collected as `warnings`, not thrown, so a
partial build still returns useful info); `buildFromRecipe` instantiates a recipe;
`finalize` runs the **create → verify → preview** loop: auto-layout left→right →
expose live controls → `checkErrors` → capture a preview image of the output TOP.

**TD client.** `src/td-client/touchDesignerClient.ts` is the HTTP client; each
method maps to one bridge REST endpoint and all failures surface as typed
`TdError`s (`TdApiError`/`TdConnectionError`/`TdTimeoutError`, `types.ts`).
Response envelopes are Zod-validated in `validators.ts`.

**Knowledge base.** Committed under `src/knowledge/data` (629 operators, 68 Python
classes, patterns, GLSL, tutorials), exposed as MCP resources
(`tdmcp://operators/…`, `tdmcp://recipes/…`, …). It is **regenerated** by
`npm run import:bottobot`, not hand-edited — Biome ignores that directory.

**Recipes.** Validated network templates as JSON in `recipes/` matching
`RecipeSchema` (`src/recipes/schema.ts`); instantiated by `apply_recipe`. A
parameter `value` that equals another node's name resolves to that node's path at
build time. Validate with `npm run validate:recipes`.

**Transports & events.** stdio (default) or Streamable HTTP
(`TDMCP_TRANSPORT=http`, loopback-only). Optionally subscribes to a TD WebSocket
event stream and forwards events as MCP logging notifications
(`TDMCP_EVENTS`); high-frequency events are dropped unless opted in.

**Config.** All env vars are `TDMCP_*`, parsed/validated in `src/utils/config.ts`.
Notable: `TDMCP_TD_HOST`/`TDMCP_TD_PORT` (bridge, default `127.0.0.1:9980`),
`TDMCP_RAW_PYTHON=off` (hides exec tools server-side; `allowRawPython` in ctx),
`TDMCP_BRIDGE_TOKEN` (bearer auth, must match TD's env), `TDMCP_VAULT_PATH`,
`TDMCP_LLM_*` (local copilot).

## Conventions

- **ESM + strict TypeScript (NodeNext).** Relative imports **must** use `.js`
  extensions. `noUncheckedIndexedAccess` is on.
- **Biome** formats and lints: 2-space indent, double quotes, semicolons,
  trailing commas, 100-col width, organize-imports on. `npm run format` to fix.
- **`docs/reference/tools.md` is generated** by `scripts/gen-tool-docs.ts` from the
  live tool registry — never hand-edit it; it regenerates on every docs build.
- **Python bridge (`td/`):** keep all TD-global usage (`op`, `app`, `project`)
  inside functions so modules import cleanly, and run `python3 -m py_compile` on
  changed files. The bridge is plain modules + a callbacks template (no binary
  `.tox` from source); the one-line installer assembles it.

## Security note

The bridge runs **arbitrary Python inside the TD process** and listens on `9980`
on all interfaces. For untrusted networks, set `TDMCP_BRIDGE_TOKEN` (both sides)
and/or `TDMCP_BRIDGE_ALLOW_EXEC=0` in TD's environment. See
`docs/reference/architecture.md`.

## Harness: feature delivery

**Goal:** take a feature idea through design/wireframe → build → integrate → QA → deploy, as a coordinated agent team that follows this repo's patterns.

**Trigger:** when asked to build, implement, develop, ship, or add one or more tdmcp features/tools, or to run them through the design→develop→QA→deploy pipeline — including follow-ups (re-run, continue, fix, update a feature/batch, or cut the next release) — use the `tdmcp-pipeline` skill. Simple questions can be answered directly. Agents live in `.claude/agents/`, skills in `.claude/skills/`.

## Harness: directory submission

**Goal:** prepare (and re-prepare) tdmcp's submission to the Anthropic Connectors
Directory via the Desktop Extension (MCPB) path.

**Trigger:** for any work on the directory/marketplace submission — writing the
privacy page, migrating `.dxt`→`.mcpb`, drafting form answers, or re-running after
a rejection — use the `tdmcp-submission` skill (it drives a 4-agent pipeline:
architect → docs-author ∥ bundle-engineer → QA, defined in `.claude/agents/` and
`.claude/skills/`). Simple questions can be answered directly. Note: this
environment runs the team as sub-agents (no `TeamCreate`).

## Harness: feature discovery

**Goal:** survey the whole project and produce a prioritized list of NEW features
tdmcp could implement — across artist controls, library/packaging, CLI/DX, AI/LLM
integration, and TouchDesigner depth — deduped and reconciled against `docs/ROADMAP.md`.

**Trigger:** when asked to brainstorm, discover, survey, list, or audit what
features/tools/effects/controls/commands/prompts/capabilities tdmcp *could* add
("what could we build", "what's missing", "ideas", "gap analysis", "feature
backlog") — including follow-ups (refresh, re-survey, re-prioritize, or scope to
one surface) — use the `tdmcp-feature-discovery` skill (a fan-out of 5
`td-surveyor`s → 1 `td-synthesizer`, in `.claude/agents/` and `.claude/skills/`).
This is the **ideation** harness — it produces a list to choose from; it does
**not** build. Once a feature is chosen, hand it to `tdmcp-pipeline`. Simple
questions can be answered directly.

**Change log:**
| Date | Change | Target | Reason |
|------|--------|--------|--------|
| 2026-05-27 | Initial harness | all (5 agents + 6 skills) | design→develop→QA→deploy pipeline for the open post-0.3.0 feature backlog |
| 2026-05-27 | Initial build | full harness | prep tdmcp Connectors Directory submission |
| 2026-05-28 | Initial harness | feature discovery (2 agents + 3 skills) | ideation: survey 4 surfaces → prioritized FEATURE_BACKLOG; feeds tdmcp-pipeline |
| 2026-05-28 | Tuned (Phase 7) | discovery (all 5 files) | run robustness (incremental writes + auto-retry); weighting profiles (live-show default); 5th surface `library`; breadth→depth + Confidence field |

## Harness: feature build

**Goal:** implement batches of new tdmcp tools (e.g. Phase 13 / v0.5.0) as parallel
one-tool-per-agent waves with a single-writer integrator — the repo's established
parallel-feature-build workflow, codified.

**Trigger:** for any work that adds new tdmcp tools in bulk — "build the Phase 13
tools", "implement these new tools", or re-running a wave after a gate failure —
use the `tdmcp-feature-lead` workflow (`.claude/agents/tdmcp-feature-lead.md`):
plan waves, spawn one `tdmcp-tool-builder` per tool in parallel (each loads the
`tdmcp-tool-builder` skill and creates only its two new files — tool + msw test),
then be the SINGLE WRITER of all shared files (layer `index.ts`, `src/cli/agent.ts`,
`src/prompts/index.ts`), live-validate in TD, run the gates, and update
docs/CHANGELOG/ROADMAP. Single new tools or questions can be handled directly.
Note: this environment runs the team as sub-agents (no `TeamCreate`); the
orchestrator spawns builders with the `Agent` tool. Builder model is chosen per
spawn (sonnet for prescriptive tools, opus for the ones needing design judgment).

**Change log:**
| Date | Change | Target | Reason |
|------|--------|--------|--------|
| 2026-05-28 | Initial build | full harness | implement Phase 13 (v0.5.0) tool backlog as parallel waves |
| 2026-05-28 | Built Phase 13 | 14 tools + body-tracking merge + recipe | 3 parallel waves (10 builders) + lead integration; live-validated; targets v0.5.0 (next release after main's 0.4.0) |
| 2026-05-28 | Hardened builder skill | `tdmcp-tool-builder` SKILL | builders ran vitest but not `tsc`; added "defaulted fields are required when calling the impl; run typecheck too" |
| 2026-05-28 | Built Phases 14–15 | 32 tools + 11 prompts + `tdmcp://prompts` resource + `apply_post_processing` +5 effects | discovery backlog wave; Wave 0 reconciled out already-shipped Phase-13 items; 5 parallel waves (33 builders) + single-writer integration; offline-gated (1395 tests / 14 recipes / 51 bridge), TD offline so live-validation UNVERIFIED-pending; CLI/copilot-infra + hardware/GPU items deferred to v0.6.0+ |
| 2026-05-28 | CLI/config/copilot follow-on | config files + profiles, doctor --fix/--json, CLI ergonomics, copilot creative tier, +3 tool extensions | single-writer pass (no builders — all shared files: config.ts/agent.ts/doctor.ts/llm); committed in 4 gated chunks; 1410 tests; install-client + heavier CLI items + hardware/GPU still deferred to v0.6.0+ |

## Harness: test coverage

**Goal:** raise tdmcp's executable TypeScript coverage through focused Vitest/msw,
integration, CLI/config, resource, and bridge-adjacent regression tests without
excluding production code or weakening thresholds.

**Trigger:** when asked to raise coverage, improve tests, add broad regression
coverage, build or re-run a test/coverage harness, or fix a coverage gate, use
the `tdmcp-test-coverage` skill. It runs `npm run coverage:harness`, ranks gaps,
coordinates `tdmcp-coverage-lead` / `tdmcp-coverage-writer` /
`tdmcp-coverage-qa`, and gates the wave. Simple questions can be answered
directly.

**Change log:**
| Date | Change | Target | Reason |
|------|--------|--------|--------|
| 2026-05-28 | Initial build | coverage harness + 3 agents + 2 skills | make coverage work repeatable, code-scoped, and gate-backed |

## Harness: cookbook examples

**Goal:** curate and write new visual examples for the prompt cookbook docs (EN + PT) — surprising things tdmcp can do that aren't shown yet.

**Trigger:** when asked to add more cookbook examples, create visual examples for the documentation, show more surprising things you can do with tdmcp, expand the prompt cookbook, or any request to add prompts + results to the cookbook — use the `tdmcp-cookbook-examples` skill (curator → EN writer ∥ PT writer → QA). Simple questions can be answered directly.

**Change log:**
| Date | Change | Target | Reason |
|------|--------|--------|--------|
| 2026-05-29 | Initial build | 2 agents + 1 skill | extend prompt cookbook with surprising examples for all tools not yet shown |

## Harness: docs & roadmap update

**Goal:** keep the roadmap, high-level docs, generated reference docs, and EN/PT
prompt cookbook aligned with newly shipped or newly merged tdmcp capabilities,
grounded in verified package/GitHub release state.

**Trigger:** when asked to update docs, update the roadmap, document new
features, reconcile docs with a release, refresh cookbook examples after a
feature wave, or check whether `docs/ROADMAP.md` is current — including
follow-ups (re-run, continue, fix, update only cookbook/roadmap) — use the
`tdmcp-docs-roadmap-update` skill. Simple questions can be answered directly.
Note: this environment runs the team as sub-agents (no `TeamCreate`).

**Change log:**
| Date | Change | Target | Reason |
|------|--------|--------|--------|
| 2026-06-01 | Initial build | docs-roadmap harness + 4 agents + 1 skill | recurring team for release-grounded docs/roadmap/cookbook updates |

## Harness: backlog campaign

**Goal:** drive an entire feature **backlog/discovery file** to completion as
resumable, wave-by-wave themed releases — the campaign layer **above**
`tdmcp-pipeline`/`tdmcp-feature-lead`, adding idempotency, resilience and
shared-schema sequencing without re-implementing the per-wave build.

**Trigger:** when asked to implement a whole backlog/discovery file (e.g.
`_workspace/discovery*/FEATURE_BACKLOG*.md`), "all the features", many features
across multiple releases, or a long autonomous build campaign — **and every
follow-up**: continue/resume the campaign, run the next wave, re-run a failed wave,
fold in QA results, or check campaign status — use the `tdmcp-backlog-campaign`
skill (drives `tdmcp-backlog-planner` → the existing design→build→integrate→QA→release
specialists, gated by a merge-safe `ledger.json`). For a **single** feature or one
small batch, use `tdmcp-pipeline` instead. Simple questions can be answered directly.
Note: this environment runs the team as sub-agents (no `TeamCreate`). When a wave needs
a new bridge REST endpoint, the `tdmcp-bridge-engineer` agent + `tdmcp-bridge-endpoint`
skill author the endpoint + client + validator + exec-fallback slice.

**Change log:**
| Date | Change | Target | Reason |
|------|--------|--------|--------|
| 2026-05-30 | Initial build | 1 agent (`tdmcp-backlog-planner`) + 1 skill (`tdmcp-backlog-campaign`) + ledger | drive the round-2 "BEYOND" backlog (66 buildable: 2 foundations + 64 features, 5 waves) to completion idempotently; reuses the whole per-wave pipeline. Policy: staged-by-priority, checkpoint after wave 1, commit+push **no-tag**, TD-required before build waves |
| 2026-05-30 | Consolidated a parallel campaign (PR #29) | +9 artist-control tools (`create_test_pattern`, `create_text_crawl`, `create_band_router`, `create_sidechain_pump`, `create_xy_pad`, `create_time_echo`, `create_capture_loop`, `create_vector_lines`, `create_blob_reactive`) + `tdmcp-bridge-engineer` agent + `tdmcp-bridge-endpoint` skill | a concurrent session built these round-1 tools (live-validated TD 099: 8 qa_pass, `create_blob_reactive` unverified pending live camera) on a duplicate harness; merged into this line keeping its tools + bridge authoring, dropping the duplicate campaign agent/scripts in favour of `tdmcp-backlog-planner` |
