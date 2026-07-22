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
| `tdmcp ask "your prompt"` | Non-interactive copilot turn — one prompt in, one answer out (machine-readable with `--json`). See [Onboarding](#onboarding) below. |
| `tdmcp chat` _(alias `tdmcp llm-run`)_ | Start the local LLM copilot UI (see below). |
| `tdmcp copilot-calibrate` | Run a synthetic, sandbox-only capability suite for the configured model; never contacts TouchDesigner. |
| `tdmcp telegram` | Start an allowlisted Telegram Bot API long-poll bridge into the local Ollama copilot. See [Telegram copilot](#telegram-copilot) below. |
| `tdmcp creative-rag sync\|index\|search` | Manage the opt-in Creative RAG reference store. See [Creative RAG](/creative-rag). |
| `tdmcp project-rag sources\|sync\|index\|search\|info\|analyze\|bridge` | Manage the opt-in TouchDesigner project RAG store and quarantine analyzer. See [Project RAG](/project-rag). |
| `tdmcp install-bridge` | Stage the TouchDesigner bridge to `~/tdmcp-bridge` and print the runtime Textport command for `/project1/tdmcp_bridge`. Add `--palette` to also print a Palette package export command for draggable `tdmcp_bridge_package.tox`; `--palette-dir <path>` and `--package-name <name>` imply `--palette`. Add `--verify` to check `/api/info` once, `--wait` to poll until it is up, and `--port <port>` for non-default bridges. For the Palette package, `/api/info` can only pass after the package's **Install** button creates the runtime bridge. See [Bridge & REST API](/reference/bridge-api). |
| `tdmcp install-client <claude\|codex\|cursor>` | Print the legacy ready-to-paste snippet, or safely plan/check/reconcile one named registration at project/user scope. See [Scoped client registration](#scoped-client-registration). |
| `tdmcp status [--json]` | Print one redacted, read-only snapshot of config, bridge, TD, interaction, skill, and supported project/user client-registration state. |
| `tdmcp doctor [--json] [--fix]` | Diagnose the effective tdmcp environment. Package-specific diagnostics live at `tdmcp packages doctor [lib]`. |
| `tdmcp show <profile>` | Run exact-profile show gates and, only after they pass, enter Perform Mode with bounded readback/rollback. Source-tree only; live PASS is scoped to TD 2025.32820. See [Show mode](#show-mode). |
| `tdmcp completion bash` | Print a shell completion snippet for the primary binary. Supports `bash`, `zsh`, and `fish`, including package-manager shortcuts and common flags. |
| `tdmcp --version` | Print the package version. |
| `tdmcp search/list/info/install/uninstall/packages doctor/packages path` | Manage TouchDesigner community packages at explicit user/project storage scope. See [Package manager](/reference/packages). |

Common package-manager examples:

```bash
tdmcp search shader
tdmcp list --available
tdmcp info shader-park-td --json
tdmcp install mediapipe-touchdesigner --dry-run --json
tdmcp doctor --json
tdmcp packages doctor comfyui-td --json
tdmcp packages --help
tdmcp packages path
tdmcp completion bash
```

## Scoped client registration {#scoped-client-registration}

Calling `install-client` with only the client name keeps the existing snippet
output. Scoped actions resolve a native host target, plan by default, and only
mutate with `--write`:

```bash
# Claude Code project target: <project>/.mcp.json
tdmcp install-client claude --scope project --project-dir "$PWD" --diff --json
tdmcp install-client claude --scope project --project-dir "$PWD" --write --json

# Read-only reconciliation and owned-entry removal
tdmcp install-client cursor --scope user --check --json
tdmcp install-client cursor --scope user --remove --diff --json
tdmcp install-client cursor --scope user --remove --write --json
```

`--profile` and `--config` resolve the effective TD host, port, and bridge-token
presence. Results never print the token value. JSON configs preserve unrelated
keys; Codex TOML preserves unrelated sections. Writes reject symlinks, files
over 1 MiB, invalid configs, and concurrent changes, then use an atomic sibling
file plus read-back verification. `--dry-run`, `--diff`, and `--check` never
write. Codex project scope is rejected because no project-level target was
verified; use Codex user scope or the compatibility-only explicit `--path`.

`tdmcp status` observes only the default `tdmcp` entry in the five native
targets supported by this contract (`claude` and `cursor` project/user, `codex`
user). It does not scan arbitrary named entries and never returns their paths or
secret values.

## Show mode (`tdmcp show`) {#show-mode}

::: warning Unreleased; live evidence is build-scoped
`tdmcp show <profile>` exists in the Wave 12 source tree, not in the public
v0.13.1 package. A disposable TD 2025.32820 sandbox passed Perform entry,
already-on idempotence, exact readback and rollback after an induced ambiguous
readback. Other builds, TouchPlayer and actual headless execution remain
**UNVERIFIED**.
:::

The command binds one exact named profile and optional exact config file. It
does not search for a "close enough" venue configuration. It then runs this
bounded sequence:

1. read redacted runtime status and require the resolved profile, bridge origin,
   saved project and TouchDesigner availability to match;
2. run the top-level environment doctor against the same resolved config;
3. run the read-only show preflight for the requested root and target FPS;
4. read Perform Mode and reject missing or contradictory state;
5. stop on FAIL, require explicit and separate acceptance for WARN and optional
   UNVERIFIED evidence, or report the dry-run result;
6. if Perform Mode is not already on, make one structured entry request and
   confirm it by readback. If entry is not confirmed, make at most one OFF
   rollback request and read back the result.

```bash
# Inspect the exact gates without mutating Perform Mode
tdmcp show club --config ./tdmcp.json --dry-run

# Machine-readable result for one project root and frame target
tdmcp show club --root-path /project1/show --target-fps 60 --json

# These accept different evidence classes; review them independently
tdmcp show club --allow-warn --allow-unverified
```

| Flag | Purpose |
| --- | --- |
| `--config <file>` | Bind the exact config file as well as the positional profile. |
| `--root-path <path>` | Preflight root; default `/project1`. |
| `--target-fps <1..240>` | Performance target; default `60`. |
| `--timeout-ms <100..5000>` | Bounded bridge/readback timeout; default `1500`. |
| `--allow-warn` | Accept non-critical WARN gates after review; it does not accept UNVERIFIED evidence. |
| `--allow-unverified` | Accept optional UNVERIFIED preflight/runtime evidence; an unknown or contradictory Perform state still fails closed. |
| `--dry-run` | Run all read-only gates and report whether Perform entry would be attempted. |
| `--json` | Emit one bounded structured report with gates, action, rollback and exit code. |

Exit `0` means gates passed, including a dry-run or an already-on no-op. Exit
`2` is invalid usage, `3` is a failed gate or unconfirmed mutation, and `4` is
unresolved evidence. The command never loads or switches a `.toe`, never calls
`project.load()`, and never falls back to `/api/exec` or raw Python.

Example evidence:

```text
PASS       TD 2025.32820 confirmed entry/readback and bounded rollback
FAIL       Perform entry was not confirmed; bounded OFF rollback was attempted
UNVERIFIED another TD build, TouchPlayer or headless runtime has not been tested
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
| `--with-creative` | Inject Creative RAG cards into the prompt context when Creative RAG is enabled. |
| `--no-ollama` | Don't auto-start local Ollama (remote endpoint or self-managed daemon). |
| `--no-receipt-persist` | Keep this turn's receipt in memory even when bounded receipt persistence is enabled. |
| `--timeout <ms>` | Wall-clock cap on the turn (default 120000). Exits 124 on hit. |

## `tdmcp-agent` — command-line agent

`tdmcp-agent` drives the same tools from a shell with machine-readable output —
useful for scripts and CI.

```bash
tdmcp-agent --help                 # list commands
tdmcp-agent info                   # health check + TD/bridge info
tdmcp-agent nodes find --params '{"parent_path":"/project1","type":"TOP"}'
tdmcp-agent params find --params '{"root_path":"/project1","parameter_glob":"gain*","non_default_only":true}'
tdmcp-agent nodes create --dry-run --params '{"parent_path":"/project1","type":"noiseTOP"}'
tdmcp-agent commands --json       # discover commands + mutating/unsafe flags
tdmcp-agent help nodes find       # focused help + input schema
tdmcp-agent schema "nodes create" # print a command's JSON Schema
tdmcp-agent nodes list --output table
tdmcp-agent nodes list --output csv
tdmcp-agent hardware-diagnose --params '{"expected_min_monitors":2,"status_paths":["/project1/kinect_wall_harp/bridge_status"]}'
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

### Full tool parity

Every registered MCP tool is exposed as a same-named `tdmcp-agent` subcommand, so
anything Claude/Codex can drive, a shell script can drive too. Run `tdmcp-agent
commands` to list them all, and `tdmcp-agent help <command>` /
`tdmcp-agent schema <command>` for a command's summary and input schema. Notable
subcommands surfaced by the parity sweep:

| Subcommand | What it does |
| --- | --- |
| `get_preview` | Capture a TOP's current output as an inline PNG image (read-only). |
| `watch_node` | Sample one operator over a short interval: runtime state, params, CHOP channels (read-only). |
| `watch_parameter_changes` | Subscribe to (or list/unsubscribe) `param.changed` events for an operator's parameters. |
| `manage_packages` | List/install packages and run dry-run-first live namespace reconciliation. |
| `insert_operator_at_selection` | Context-check and atomically insert one same-family operator downstream of the exact active selection. |
| `swap_operator` | Swap one operator for another type while preserving wiring and parameters. |
| `copilot_vision` | Capture a TOP and ask the configured multimodal LLM a question about it. |
| `auto_repair_loop` | Iteratively check a network for errors and apply automatic repairs. |
| `create_glsl_material` | Create a GLSL MAT material with custom shader code. |
| `publish_recipe_bundle` | Publish a signed/versioned recipe bundle artifact to disk. |


The 21 Obsidian **vault** tools are available as subcommands too (all need
`TDMCP_VAULT_PATH`): `apply_shader_from_vault`, `auto_tag_library_asset`,
`bind_vault_text`, `browse_vault_library`, `capture_to_vault`, `export_look_tox`,
`export_network_to_vault`, `export_setlist_to_vault`, `generate_from_moodboard`,
`import_setlist`, `log_performance`, `recall_similar_work`,
`save_component_to_vault`, `save_recipe_to_vault`, `scaffold_recipe_from_network`,
`scaffold_vault`, `style_memory`, `sync_presets_vault`, `tag_and_search_library`,
`tutorial_companion_pack`, and `version_library_asset`.

The tool-integration campaign also exposes production-handoff and external-control
commands:

| Subcommand | What it does |
| --- | --- |
| `export-render-preset` | Record a TOP with a named VJ/editorial export preset. |
| `show-preflight` | Run a read-only PASS/UNVERIFIED/WARN/FAIL pre-show check. |
| `auto-ui-from-params` | Generate a playable control panel from a node's parameters. |
| `companion-surface` | Create a companion auto UI, fader surface and preflight report. |
| `clip-transport` | Build a movie/audio clip transport with Play, Loop and Speed controls. |
| `osc-router` | Build an OSC control matrix for one or more external targets. |
| `qlab-osc` | Build a QLab OSC bridge with transport and cue-start routes. |
| `atem-switcher-control` | Build an atemOSC/Companion switcher-control preset. |
| `resolume-vdmx-output` | Build Resolume/VDMX OSC output-control lanes. |
| `obs-stream-control` | Build an OBS WebSocket stream/record/scene control rig. |
| `shader-live-loop` | Edit a shader DAT, then inspect errors and optionally capture a preview. |
| `raytk-expr-graph` | Build a preset/custom RayTK ROP expression graph; requires RayTK loaded. |
| `projector-calibration` | Build a multi-projector calibration scaffold with corner-pin lanes. |
| `blender-scene-import` | Import a Blender scene or exported asset into a PBR render scaffold. |
| `notch-touchengine-bridge` | Build a guarded Notch TOP or TouchEngine bridge scaffold. |
| `lidar-floor-tracker` | Build a synthetic/Ouster/Leuze/UDP LiDAR floor-tracker scaffold. |
| `marketplace-index-seed` | Write a guarded starter marketplace seed JSON. |
| `one-source-five-ways` | Generate five deterministic remix briefs from one source. |

### Packaging, narration & preview subcommands

| Subcommand | What it does |
| --- | --- |
| `bundle-deps` | Make a COMP self-contained: copy external assets beside a saved `.tox` and rewrite refs to relative paths. |
| `export-external-tree` | Save a COMP as a git-diffable externalized `.tox` tree (each COMP becomes its own file). |
| `narrate-set` | Persist/recall a live-set narration log (append timestamped decision lines; recall them later). |
| `check-optypes` | Reconcile the operator knowledge base against the live TD's creatable optypes. |

`tdmcp-agent preview <nodePath>` captures a TOP to a PNG file (`-o file.png`,
default `preview.png`; `--dry-run` prints the plan only). Add `--inline` to render
a terminal thumbnail instead (iTerm2/Kitty inline image, else an honest ASCII
fallback), and `--inline --watch` to re-render on an interval (`--interval <ms>`)
until Ctrl-C.

`tdmcp-agent doctor --json` is an alias for `doctor --output json` — the
diagnostics emit a single machine-readable envelope. Pair it with `--fix` to apply
safe repairs first, then report the JSON.

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
daemon), **`--no-open`** (don't open the browser),
**`--no-receipt-persist`** (memory-only receipts for this process/turn),
**`--profile <name>`** /
**`--config <path>`** (select saved config), and **`--help`**.

It is meant for the easy stuff — inspecting the project, reading errors, and
creating/wiring/parameterizing individual operators — and is given a **curated,
safe subset** of the tools (no Layer-1 system generators, no raw Python). For full
systems, click **Escalate ⇪** to copy a ready-to-paste prompt and hand off to
Claude/Codex (they drive the same project, so nothing needs to move). The UI also
has a **read-only** toggle, live **model switching** + endpoint settings, a
one-click **model pull**, and persistent history.

Every local turn receives one ephemeral, bounded editor-context read when the
bridge is available. The copilot can invoke the canonical registered MCP prompt
catalog through a schema-validated local adapter, not merely list it. Mutating
tools are followed by bounded read-only verification before completion is
reported; `FAIL` and `UNVERIFIED` remain explicit and the mutation is never
repeated automatically. Recovery is limited to one read-only evidence action and
does not retry ambiguous mutations, authorization failures, panic or blackout.

::: tip Which local model?
Benchmarked on the simple-task workload, **`qwen2.5:3b`** hit 100% tool-calling —
as reliable as 7B/14B but faster and lighter (the default). Sub-3B models (e.g.
`qwen2.5:1.5b`) are flaky; `llama3.1:8b` was notably weaker at tool use. Bump to
`qwen2.5:7b`/`14b` only for more answer-quality headroom. Any OpenAI-compatible
endpoint works via `TDMCP_LLM_BASE_URL` — local Ollama/LM Studio, or a cloud API.
Tune the default tool tier, loop budget and sampling with `TDMCP_LLM_TIER`,
`TDMCP_LLM_MAX_STEPS` and `TDMCP_LLM_TEMPERATURE`.
:::

## Local model calibration (`tdmcp copilot-calibrate`)

The calibrator exercises only synthetic fixture tools. It checks repeated schema
adherence, tool selection, sequential/parallel calls, failed-call recovery,
context retention and optional synthetic image input. It does not contact the TD
bridge, inspect a project, start Ollama, pull a model, or accept an API key on the
command line.

```bash
tdmcp copilot-calibrate
tdmcp copilot-calibrate --mode enforce --samples 3 --vision auto --json
tdmcp copilot-calibrate --refresh --no-cache
```

| Flag | Purpose |
| --- | --- |
| `--mode recommend\|enforce` | `recommend` preserves the requested tier; `enforce` caps it to fresh exact evidence and otherwise uses `safe`. |
| `--samples 3..5` | Repeated samples per tier-gating capability. |
| `--timeout <ms>` | Whole-suite deadline, bounded to `5000..300000`. |
| `--vision auto\|off\|required` | Control the synthetic image probe. |
| `--refresh` | Ignore a reusable cache entry and rerun the suite. |
| `--no-cache` | Read and write no calibration cache. |
| `--cache <absolute-path>` | Override the owner-controlled cache path. |
| `--model <id>` | Override the configured model id. |
| `--profile <name>` / `--config <path>` | Select the normal tdmcp configuration source. |
| `--json` | Emit one bounded JSON manifest line. |

Exit codes are `0` for a completed suite, `1` for a suite/protocol failure, `2`
for usage, `3` for an unavailable endpoint/model, and `124` for timeout or
cancellation. Cache reuse requires the exact redacted endpoint/model/build
fingerprint, an unexpired entry, and stable build identity. Calibration never
raises the caller's requested tier.

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
`/private <prompt>` keeps that one turn's receipt in memory; standard/creative
private prompts still require the same `/approve` step.

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
| `npm run ai-party:dev` | Start the Live Nervous System AI Party dashboard/backend, normally on `http://127.0.0.1:8787/`. |
| `npm run ai-party:dry` | Run the deterministic AI Party rehearsal smoke without external services. |
| `npm run ai-party:td-build` | Build the optional `/project1/ai_party_poc` TouchDesigner preview network through the bridge. |
| `npm run ai-party:test` | Run the focused AI Party live POC, Show Director, gateway and producer-runner tests. |
| `npm run ai-party:telegram` | Start the local AI Party dashboard/backend with Telegram long polling enabled. |
| `npm run ai-party:llm-eval` | Run the ShowIntent eval cases against `OLLAMA_BASE_URL` / `OLLAMA_MODEL`. |
| `npm run ai-party:llm-baseline` | Save a timestamped ShowIntent local-LLM baseline report and failure JSONL. |
| `npm run ai-party:llm-generate-data` | Generate deterministic ShowIntent training JSONL and train/validation splits. |
| `npm run ai-party:llm-import-curated` | Convert approved curation CSV rows into validated training JSONL. |
| `npm run import:bottobot` | (Re)build the embedded knowledge base — only needed to refresh it. |
| `npm run build:mcpb` | Package a Claude Desktop `.mcpb` extension (see [Deployment](/deployment)). |
| `npm run docs:dev` / `docs:build` | Run / build this documentation site (regenerates the [Tools reference](/reference/tools) first). |
