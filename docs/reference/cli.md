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
| `tdmcp init` | One-shot onboarding: stage the bridge, write a client config (Claude / Cursor / Codex), seed a profile and optional bridge token. See [Onboarding](#onboarding) below. |
| `tdmcp ask "<prompt>"` | Non-interactive copilot turn — one prompt in, one answer out (machine-readable with `--json`). See [Onboarding](#onboarding) below. |
| `tdmcp chat` _(alias `tdmcp llm-run`)_ | Start the local LLM copilot UI (see below). |
| `tdmcp telegram` | Start an allowlisted Telegram Bot API long-poll bridge into the local Ollama copilot. See [Telegram copilot](#telegram-copilot) below. |
| `tdmcp install-bridge` | Stage the TouchDesigner bridge to `~/tdmcp-bridge` and print the runtime Textport command for `/project1/tdmcp_bridge`. Add `--palette` to also print a Palette package export command for draggable `tdmcp_bridge_package.tox`; `--palette-dir <path>` and `--package-name <name>` imply `--palette`. Add `--verify` to check `/api/info` once, `--wait` to poll until it is up, and `--port <port>` for non-default bridges. For the Palette package, `/api/info` can only pass after the package's **Install** button creates the runtime bridge. See [Bridge & REST API](/reference/bridge-api). |
| `tdmcp install-client <claude\|codex\|cursor>` | Print a client-specific MCP config snippet for the current package. Add `--write --path <file>` to deep-merge and verify an explicit client config file (JSON for Claude/Cursor, TOML for Codex). |
| `tdmcp completion bash` | Print a shell completion snippet for the primary binary. Supports `bash`, `zsh`, and `fish`, including package-manager shortcuts and common flags. |
| `tdmcp --version` | Print the package version. |
| `tdmcp search/list/info/install/uninstall/doctor/packages path` | Manage TouchDesigner community packages. See [Package manager](/reference/packages). |

Common package-manager examples:

```bash
tdmcp search shader
tdmcp list --available
tdmcp info shader-park-td --json
tdmcp install mediapipe-touchdesigner --dry-run --json
tdmcp doctor comfyui-td --json
tdmcp packages --help
tdmcp packages path
tdmcp completion bash
```

## Onboarding & one-shot ask {#onboarding}

### `tdmcp init`

One-shot onboarding for first-time users. Stages the TouchDesigner bridge,
writes (or merges) a per-client MCP config for Claude / Cursor / Codex, creates
a default profile in `tdmcp.json`, and optionally seeds a `TDMCP_BRIDGE_TOKEN`.
Safe to re-run — every step is idempotent and reports `ok` / `would` / `skip` /
`fail`.

```bash
tdmcp init --yes
```

| Flag | Purpose |
| --- | --- |
| `-y, --yes` | Accept defaults, non-interactive. |
| `--dry-run` | Plan only; do not touch files or launch TouchDesigner. |
| `--json` | Emit a single JSON envelope (suppresses banners; pair with `--show-token` if you need the token unredacted). |
| `--clients <list>` | `auto` (default), `none`, or csv of `claude,cursor,codex`. |
| `--skip <steps>` | csv of `bridge,clients,config,token,open,doctor` to skip individual steps. |
| `--token <v>` | Use this `TDMCP_BRIDGE_TOKEN` (use `--no-token` to opt out of token generation). |
| `--profile <name>` | Profile name in `tdmcp.json` (default `local`). |

### `tdmcp ask`

Non-interactive copilot turn — pass a single prompt, get one answer back. Uses
the same curated local-LLM tier as `tdmcp chat`, but skips the browser UI so it
plugs into scripts and CI.

```bash
tdmcp ask "what TOPs are cooking the slowest right now?" --json
```

| Flag | Purpose |
| --- | --- |
| `--json` | Emit a single JSON line: `{answer, error?, durationMs, model, tier, toolCalls}`. |
| `--tools=off` | Bypass tool calls and return a pure model answer. |
| `--model <name>` | Override `llmModel` for this turn. |
| `--profile <name>` | Use a named profile from `tdmcp.json` / `.tdmcprc`. |
| `--config <path>` | Use a specific config file instead of the search order. |
| `--read-only` | Force the safe (inspection-only) tier. |
| `--creative` | Use the creative tier and a warmer sampling preset. |
| `--no-ollama` | Don't auto-start local Ollama (remote endpoint or self-managed daemon). |
| `--timeout <ms>` | Wall-clock cap on the turn (default 120000). Exits 124 on hit. |

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
tdmcp-agent doctor --fix          # apply safe repairs, then report remaining guidance
tdmcp-agent watch-build           # watch src/ + td/, rebuild, py_compile + reload td/*.py edits
tdmcp-agent watch-build --no-reload-bridge  # build-only watcher
tdmcp-agent watch --pretty --heartbeat-ms 5000
tdmcp-agent watch --on beat --exec './cue-next.sh' --debounce-ms 250
tdmcp-agent show-director --params '{"intent":{"type":"request_cue","cue":"band_intro","preapproved":true}}'
tdmcp-agent ai-party-poc
tdmcp-agent ai-party-poc --params '{"auto_approve_effects":true,"operator":"front-of-house"}'
tdmcp-agent ai-party --params '{"message":{"text":"/fog 3s light","chat_role":"operator","user_role":"foh"}}'
```

Output format is `--output json` (default) / `ndjson` / `text` / `table` /
`csv`. Mutating commands are tagged `mutates`; the Python escape hatches require
`--allow-unsafe` and honour `TDMCP_RAW_PYTHON=off`. `tdmcp-agent doctor --fix`
currently applies safe local repairs, such as creating a missing configured
`TDMCP_VAULT_PATH` folder, and prints suggestions for the remaining manual
items. Argument JSON can come from
`--params '<json>'`, `--params-file file.json`, `--params -` (stdin), or
`--json '<json>'`. Connection overrides are available per call with `--td-host`,
`--td-port`, and `--timeout`; script-friendly flags include `--version`,
`--quiet`, and `--no-color`.
Run files also accept stdin via `run -`; add `--continue-on-error` to execute the
whole file and return the first non-zero step code after recording every result.
Global `--no-color` is forwarded into run-file steps, and an individual step can
set `"no_color": true` when a generated plan needs script-compatible output.
For agent clients, `tdmcp://commands` exposes the same command catalog as an MCP
resource.

`tdmcp-agent show-director` is a dry-run only AI Show Director policy surface. It
validates a `ShowIntent`, returns `allow`, `require_approval` or `block`, and
emits updated approval/audit state as JSON. It never connects to TouchDesigner or
hardware; use it to gate future voice/OpenClaw/dashboard integrations before any
cue or effect is mapped to real execution.

`tdmcp-agent ai-party-poc` runs the producer rehearsal package for the
[AI-Controlled Party](/guide/ai-controlled-party) concept. With no params it uses
the built-in seven-moment demo; with custom `events` it accepts operator text,
voice transcripts, audio-section markers, dashboard approval actions or scripted
`ShowIntent`s. The output is a dry-run JSON envelope with policy decisions,
approval queue state, an audit log summary and simulated effect events. It does
not build a TouchDesigner context and never emits a live hardware plan.

`tdmcp-agent ai-party` is the Hermes/Telegram POC wrapper around that policy
surface. It accepts a Telegram-style message, validates an optional raw Hermes
candidate or uses a deterministic fallback parser, then returns the dry-run
decision, plan, approval state and Telegram reply text. `tdmcp-agent ai-party
telegram-once` runs one Telegram Bot API long-poll batch and sends replies with
`sendMessage`; it is still policy-only and does not create a TouchDesigner
context.

The ShowIntent local-model improvement harness lives under
`training/showintent/`. It evaluates an Ollama model against locked
operator/Telegram cases before any optional fine-tuning:

```bash
tdmcp-agent ai-party llm-setup
tdmcp-agent ai-party --llm --params '{"message":{"text":"deixa mais premium","chat_role":"operator","user_role":"foh"}}'
OLLAMA_MODEL=qwen2.5:3b npm run ai-party:llm-baseline
npm run ai-party:llm-generate-data
npm run ai-party:llm-import-curated
```

The harness trains the model only to emit valid `ShowIntent` JSON. It does not
replace `ShowIntentSchema`, `EffectPolicySchema` or `showDirectorRuntime`, and it
does not teach raw DMX, raw Python or direct hardware control.

`tdmcp-agent ai-party --llm` calls local Ollama through `/api/chat`, validates
the returned ShowIntent JSON, then sends it through the same dry-run policy
gateway. If the model returns malformed output, the request is blocked. The
general `tdmcp chat` copilot still uses the normal chat model; the AI Party model
is ShowIntent-only and should not become the default copilot model.

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

## Telegram copilot (`tdmcp telegram`) {#telegram-copilot}

`tdmcp telegram` runs a local long-polling Telegram Bot API loop and forwards
allowlisted text messages to the same local Ollama copilot used by `tdmcp chat`.
It is a transport adapter: Telegram never talks directly to the TouchDesigner
bridge.

Required setup:

```bash
printf '%s\n' '123456:ABC...' | tdmcp telegram setup --token-stdin --chat-id 123456
ollama pull qwen2.5:3b
tdmcp telegram
```

`tdmcp telegram setup` validates the BotFather token with Telegram `getMe`, then
writes `telegramBotToken`, `telegramAllowedChats` and `telegramDefaultTier` to
the selected config file. By default it uses `TDMCP_CONFIG_FILE`, an existing
`tdmcp.json` / `.tdmcprc` in the current directory, or
`~/.config/tdmcp/config.json`. Use `--config <path>` or `--profile <name>` to
choose the destination explicitly. If you omit `--chat-id`, setup can wait for
the next message sent to the bot and save that chat after confirmation.

The Telegram surface defaults to `safe` mode, so read-only inspection prompts run
immediately. `/standard` and `/creative` stage the next prompt and require
`/approve` before any non-safe tool tier runs. `/cancel` clears pending/running
work, `/status` shows tier/pending state, and `/panic` intentionally does not
execute remotely in this MVP; use a trusted local shell for `tdmcp-agent panic`.

Runtime flags: `--once` (poll once and exit), `--read-only`, `--creative`,
`--tier <safe|standard|creative>`, `--poll-timeout <sec>`,
`--drop-pending-updates`, `--profile <name>`, `--config <path>`, and `--help`.

Setup flags: `--token-stdin`, `--chat-id <id>`, `--user-id <id>`,
`--setup-timeout <sec>`, `--yes`, `--profile <name>`, `--config <path>`, and
`--help`.

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
| `npm run ai-party:llm-eval` | Run the ShowIntent eval cases against `OLLAMA_BASE_URL` / `OLLAMA_MODEL`. |
| `npm run ai-party:llm-baseline` | Save a timestamped ShowIntent local-LLM baseline report and failure JSONL. |
| `npm run ai-party:llm-generate-data` | Generate deterministic ShowIntent training JSONL and train/validation splits. |
| `npm run ai-party:llm-import-curated` | Convert approved curation CSV rows into validated training JSONL. |
| `npm run import:bottobot` | (Re)build the embedded knowledge base — only needed to refresh it. |
| `npm run build:mcpb` | Package a Claude Desktop `.mcpb` extension (formerly `.dxt`; see [Deployment](/deployment)). |
| `npm run docs:dev` / `docs:build` | Run / build this documentation site (regenerates the [Tools reference](/reference/tools) first). |
