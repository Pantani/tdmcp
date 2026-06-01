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
| `tdmcp serve --http --port 3939` | Start the MCP server over loopback Streamable HTTP for clients that do not use stdio. Bare `tdmcp` still defaults to stdio. |
| `tdmcp --help` | Print top-level usage without starting the MCP server. |
| `tdmcp chat` _(alias `tdmcp llm-run`)_ | Start the local LLM copilot UI (see below). |
| `tdmcp install-bridge` | Stage the TouchDesigner bridge to `~/tdmcp-bridge` and print the one line to paste into TD's Textport. Add `--verify` to check `/api/info` once, `--wait` to poll until it is up, and `--port <port>` for non-default bridges. See [Bridge & REST API](/reference/bridge-api). |
| `tdmcp install-client <claude\|codex\|cursor>` | Print a client-specific MCP config snippet for the current package. Add `--write --path <file>` to deep-merge and verify an explicit client config file (JSON for Claude/Cursor, TOML for Codex). |
| `tdmcp --version` | Print the package version. |
| `tdmcp search/list/info/install/uninstall/doctor/packages path` | Manage TouchDesigner community packages. See [Package manager](/reference/packages). |

Common package-manager examples:

```bash
tdmcp search shader
tdmcp list --available
tdmcp info shader-park-td --json
tdmcp install mediapipe-touchdesigner --dry-run --json
tdmcp doctor comfyui-td --json
tdmcp packages path
```

## `tdmcp-agent` — command-line agent

`tdmcp-agent` drives the same tools from a shell with machine-readable output —
useful for scripts and CI.

```bash
tdmcp-agent --help                 # list commands
tdmcp-agent info                   # health check + TD/bridge info
tdmcp-agent nodes find --params '{"parent_path":"/project1","type":"TOP"}'
tdmcp-agent nodes create --dry-run --params '{"parent_path":"/project1","type":"noiseTOP"}'
tdmcp-agent commands --json       # discover commands + mutating/unsafe flags
tdmcp-agent help nodes find       # focused help + input schema
tdmcp-agent schema "nodes create" # print a command's JSON Schema
tdmcp-agent nodes list --output table
tdmcp-agent nodes list --output csv
tdmcp-agent run ./show-plan.json  # run a JSON file of command steps
cat show-plan.json | tdmcp-agent run - --continue-on-error
tdmcp-agent config profiles       # list saved config profiles
tdmcp-agent config profile club   # show one profile, secrets redacted
tdmcp-agent completion bash       # shell completion snippet
tdmcp-agent repl                  # interactive mode with persistent history + Tab completion
tdmcp-agent watch --pretty --heartbeat-ms 5000
tdmcp-agent watch --on beat --exec './cue-next.sh' --debounce-ms 250
```

Output format is `--output json` (default) / `ndjson` / `text` / `table` /
`csv`. Mutating commands are tagged `mutates`; the Python escape hatches require
`--allow-unsafe` and honour `TDMCP_RAW_PYTHON=off`. Argument JSON can come from
`--params '<json>'`, `--params-file file.json`, `--params -` (stdin), or
`--json '<json>'`. Connection overrides are available per call with `--td-host`,
`--td-port`, and `--timeout`; script-friendly flags include `--version`,
`--quiet`, and `--no-color`.
Run files also accept stdin via `run -`; add `--continue-on-error` to execute the
whole file and return the first non-zero step code after recording every result.
For agent clients, `tdmcp://commands` exposes the same command catalog as an MCP
resource.

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
takes the model offline. Flags: **`--read-only`** (force the safe tool tier),
**`--creative`** (use the creative tier and a warmer sampling preset),
**`--prompt <text>`** (headless one-shot answer, no browser/server),
**`--no-ollama`** (don't auto-start — for a remote endpoint or a self-managed
daemon), **`--no-open`** (don't open the browser), **`--profile <name>`** /
**`--config <path>`** (select saved config), and **`--help`**.

It is meant for the easy stuff — inspecting the project, reading errors, and
creating/wiring/parameterizing individual operators — and is given a **curated,
safe subset** of the tools (no Layer-1 system generators, no raw Python). For full
systems, click **Escalate ⇪** to copy a ready-to-paste prompt and hand off to
Claude/Codex (they drive the same project, so nothing needs to move). The UI also
has a **read-only** toggle, live **model switching** + endpoint settings, a
one-click **model pull**, and persistent history. The copilot sees the registered
MCP prompt catalog from `tdmcp://prompts`, so it can point users at the right
Claude/Codex prompt when a request is better handled by a full MCP client.

::: tip Which local model?
Benchmarked on the simple-task workload, **`qwen2.5:3b`** hit 100% tool-calling —
as reliable as 7B/14B but faster and lighter (the default). Sub-3B models (e.g.
`qwen2.5:1.5b`) are flaky; `llama3.1:8b` was notably weaker at tool use. Bump to
`qwen2.5:7b`/`14b` only for more answer-quality headroom. Any OpenAI-compatible
endpoint works via `TDMCP_LLM_BASE_URL` — local Ollama/LM Studio, or a cloud API.
Tune the default tool tier, loop budget and sampling with `TDMCP_LLM_TIER`,
`TDMCP_LLM_MAX_STEPS` and `TDMCP_LLM_TEMPERATURE`.
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
| `npm run build:mcpb` | Package a Claude Desktop `.mcpb` extension (formerly `.dxt`; see [Deployment](/deployment)). |
| `npm run docs:dev` / `docs:build` | Run / build this documentation site (regenerates the [Tools reference](/reference/tools) first). |
