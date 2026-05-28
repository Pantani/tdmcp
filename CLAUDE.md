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

## Harness: directory submission

**Goal:** prepare (and re-prepare) tdmcp's submission to the Anthropic Connectors
Directory via the Desktop Extension (MCPB) path.

**Trigger:** for any work on the directory/marketplace submission — writing the
privacy page, migrating `.dxt`→`.mcpb`, drafting form answers, or re-running after
a rejection — use the `tdmcp-submission` skill (it drives a 4-agent pipeline:
architect → docs-author ∥ bundle-engineer → QA, defined in `.claude/agents/` and
`.claude/skills/`). Simple questions can be answered directly. Note: this
environment runs the team as sub-agents (no `TeamCreate`).

**Change log:**
| Date | Change | Target | Reason |
|------|--------|--------|--------|
| 2026-05-27 | Initial build | full harness | prep tdmcp Connectors Directory submission |
