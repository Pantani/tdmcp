---
description: "The tdmcp command line — agent runner and a local-LLM copilot for the TouchDesigner MCP server, for tasks that do not need a paid API."
---

# CLI

The package installs two binaries: `tdmcp` (the MCP server + utilities) and
`tdmcp-agent` (a shell-friendly client). After `npm run build`, run them with
`node dist/index.js …` / `node dist/cli/agent.js …`, or globally if you
`npm link` / install the package.

## `tdmcp` — server & utilities

| Command | What it does |
| --- | --- |
| `tdmcp` | Start the MCP server (default `stdio` transport). Configured via [environment variables](/reference/environment). |
| `tdmcp chat` _(alias `tdmcp llm-run`)_ | Start the local LLM copilot UI (see below). |
| `tdmcp install-bridge` | Stage the TouchDesigner bridge to `~/tdmcp-bridge` and print the one line to paste into TD's Textport. See [Bridge & REST API](/reference/bridge-api). |

## `tdmcp-agent` — command-line agent

`tdmcp-agent` drives the same tools from a shell with machine-readable output —
useful for scripts and CI.

```bash
tdmcp-agent --help                 # list commands
tdmcp-agent info                   # health check + TD/bridge info
tdmcp-agent nodes find --params '{"parent_path":"/project1","type":"TOP"}'
tdmcp-agent nodes create --dry-run --params '{"parent_path":"/project1","type":"noiseTOP"}'
tdmcp-agent schema "nodes create" # print a command's JSON Schema
```

Output format is `--output json` (default) / `ndjson` / `text`. Mutating commands
are tagged `mutates`; the Python escape hatches require `--allow-unsafe` and honour
`TDMCP_RAW_PYTHON=off`.

## Local copilot (`tdmcp chat`)

> For an artist-friendly walkthrough, see [Local copilot (no API)](/guide/local-copilot).
> This section is the reference detail.

For **simple tasks** you can talk to a **local LLM** instead of a paid API.
`tdmcp chat` boots a small chat UI in your browser, wired to the same
TouchDesigner bridge — and **starts Ollama for you** if it isn't already running:

```bash
# one-time: install Ollama from https://ollama.com
ollama pull qwen2.5:3b   # optional — the UI also has a one-click pull
tdmcp chat               # starts Ollama if needed, opens http://127.0.0.1:4141
```

If the endpoint is local Ollama and the daemon isn't up, `tdmcp chat` launches
`ollama serve` for you — detached and left running, so quitting the chat never
takes the model offline. Flags: **`--no-ollama`** (don't auto-start — for a remote
endpoint or a self-managed daemon), **`--no-open`** (don't open the browser), and
**`--help`**.

It is meant for the easy stuff — inspecting the project, reading errors, and
creating/wiring/parameterizing individual operators — and is given a **curated,
safe subset** of the tools (no Layer-1 system generators, no raw Python). For full
systems, click **Escalate ⇪** to copy a ready-to-paste prompt and hand off to
Claude/Codex (they drive the same project, so nothing needs to move). The UI also
has a **read-only** toggle, live **model switching** + endpoint settings, a
one-click **model pull**, and persistent history.

::: tip Which local model?
Benchmarked on the simple-task workload, **`qwen2.5:3b`** hit 100% tool-calling —
as reliable as 7B/14B but faster and lighter (the default). Sub-3B models (e.g.
`qwen2.5:1.5b`) are flaky; `llama3.1:8b` was notably weaker at tool use. Bump to
`qwen2.5:7b`/`14b` only for more answer-quality headroom. Any OpenAI-compatible
endpoint works via `TDMCP_LLM_BASE_URL` — local Ollama/LM Studio, or a cloud API.
:::

## npm scripts

| Script | Purpose |
| --- | --- |
| `npm run setup` | Guided install + build, then prints how to connect your client. |
| `npm run dev` | Run the server from source (stdio). |
| `npm run build` | Typecheck + bundle + copy assets to `dist/`. |
| `npm test` | Unit + integration tests (Vitest + MSW). |
| `npm run typecheck` / `npm run lint` | TypeScript / Biome. |
| `npm run smoke:live` | End-to-end test against a running TD. |
| `npm run validate:recipes` | Validate every recipe JSON. |
| `npm run import:bottobot` | (Re)build the embedded knowledge base — only needed to refresh it. |
| `npm run build:dxt` | Package a Claude Desktop `.dxt` extension (see [Deployment](/deployment)). |
| `npm run docs:dev` / `docs:build` | Run / build this documentation site (regenerates the [Tools reference](/reference/tools) first). |
