---
description: "Environment variables for tdmcp, the TouchDesigner MCP server — configure the bridge host and port, auth token, vault path and exec safety."
---

# Environment variables

Configuration can come from environment variables or from an optional JSON config
file. Environment variables win over file values, so CI, Docker and MCP-client
config stay simple. Every variable is optional and has a sensible default.

## Server

| Variable | Default | Description |
| --- | --- | --- |
| `TDMCP_TD_HOST` | `127.0.0.1` | TouchDesigner bridge host. |
| `TDMCP_TD_PORT` | `9980` | Web Server DAT port. |
| `TDMCP_TRANSPORT` | `stdio` | MCP transport: `stdio` (default) or `http` (Streamable HTTP). |
| `TDMCP_HTTP_PORT` | `3939` | Port for the HTTP transport (when `TDMCP_TRANSPORT=http`). |
| `TDMCP_EVENTS` | `on` | Subscribe to TD WebSocket events and forward them as MCP logging notifications (`on`/`off`). |
| `TDMCP_RAW_PYTHON` | `on` | Whether to expose the two raw-Python escape-hatch tools (`execute_python_script`, `exec_node_method`) in the MCP server. Set to `off` to lock them out for restricted setups. This removes only those two client-authored-code tools — many higher-level tools still send their own *templated* Python to the bridge, so `off` is **not** "no code runs in TD". The bridge itself now keeps arbitrary-code endpoints disabled unless `TDMCP_BRIDGE_TOKEN` or explicit `TDMCP_BRIDGE_ALLOW_EXEC=1` is set in TouchDesigner's environment. |
| `TDMCP_TOOL_PROFILE` | `full` | Tool exposure profile. `full` registers every tool; `safe` hides destructive/raw-code tools, including raw Python, node deletion, DAT rewrites, checkpoint/component/package writes and preview-asset writes — a strict superset of `TDMCP_RAW_PYTHON=off`. Use `safe` for an autonomous in-TD agent (e.g. dotsimulate's LOPs MCP Client). Default `full` keeps existing clients unchanged. |
| `TDMCP_BRIDGE_TOKEN` | _(unset)_ | Optional shared bearer token. When set, the server sends it and the bridge requires it — set the **same** value in TouchDesigner's environment to turn auth on. |
| `TDMCP_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `silent` (logged to stderr). |
| `TDMCP_REQUEST_TIMEOUT_MS` | `10000` | Per-request timeout to the bridge, in milliseconds. |
| `TDMCP_CONFIG_FILE` | _(unset)_ | Optional JSON config file. Keys match the internal config names (`tdHost`, `tdPort`, `requestTimeoutMs`, etc.). |
| `TDMCP_PROFILE` | _(unset)_ | Optional profile name inside the selected config file (`profiles.<name>`), whether that file is set with `TDMCP_CONFIG_FILE` or found through the default search paths. File base values load first, profile values override them, env vars override both. |
| `TDMCP_VAULT_PATH` | _(unset)_ | Absolute path to an Obsidian vault (a folder of Markdown notes). Enables the [vault tools](/reference/tools#obsidian-vault); a leading `~/` is expanded. Leave unset to disable them. |
| `TDMCP_IMAGE_GEN_PROVIDER` | `none` | Hosted image-generation provider for the AI-texture asset lane (`create_ai_texture` / `create_ai_backdrop`): `fal`, `replicate`, or `none` (disabled). |
| `TDMCP_FAL_KEY` | _(unset)_ | fal.ai API key, used when the provider is `fal`. **Node-only — never sent to the TouchDesigner bridge**; redacted in `doctor` / `doctor --json` output. |
| `TDMCP_REPLICATE_KEY` | _(unset)_ | Replicate API token, used when the provider is `replicate`. **Node-only — never sent to the bridge**; redacted in `doctor` / `doctor --json` output. |
| `TDMCP_IMAGE_GEN_MODEL` | _(provider default)_ | Override the hosted model id (e.g. WAN 2.5). Defaults to the provider's default model (fal.ai: Flux-schnell). |
| `TDMCP_IMAGE_CACHE_DIR` | `.tdmcp/image-gen` | Local directory where generated images are cached before delivery to a Movie File In TOP. |

## Local copilot (`tdmcp chat`)

These configure the [local LLM copilot](/reference/cli#local-copilot-tdmcp-chat).

| Variable | Default | Description |
| --- | --- | --- |
| `TDMCP_LLM_BASE_URL` | `http://127.0.0.1:11434/v1` | OpenAI-compatible chat endpoint. Defaults to local Ollama; point it at LM Studio, a cloud GPU or a paid API. |
| `TDMCP_LLM_MODEL` | `qwen2.5:3b` | Model id the copilot requests (must be pulled in the backend, e.g. `ollama pull qwen2.5:3b`). Bump to `qwen2.5:7b` for more headroom. |
| `TDMCP_LLM_API_KEY` | _(unset)_ | Optional bearer token for the LLM endpoint (ignored by local Ollama; needed for paid/cloud APIs). |
| `TDMCP_LLM_TIER` | `standard` | Default chat tool tier: `standard`, `safe` (read-only), or `creative` (adds curated generators). The browser toggles can still override it per turn. |
| `TDMCP_LLM_MAX_STEPS` | `8` | Maximum model/tool loop iterations for one local copilot turn. Values are clamped to `1..32`. |
| `TDMCP_LLM_TEMPERATURE` | `0.4` | Sampling temperature sent to the OpenAI-compatible chat endpoint. Values are clamped to `0..2`. |
| `TDMCP_CHAT_PORT` | `4141` | Loopback port the `tdmcp chat` web UI binds to. |

## Telegram copilot (`tdmcp telegram`)

These configure the [Telegram copilot](/reference/cli#telegram-copilot). It uses
Telegram Bot API long polling, so no public webhook or inbound port is required.
Messages are accepted only from configured allowlists.

For local setup, prefer `tdmcp telegram setup`: it validates the BotFather token
and writes the matching config keys to `~/.config/tdmcp/config.json` or the file
selected with `--config`. The environment variables below remain useful for
temporary shells, process managers and CI-style runs.

| Variable | Default | Description |
| --- | --- | --- |
| `TDMCP_TELEGRAM_BOT_TOKEN` | _(unset)_ | Telegram bot token from BotFather. Required for `tdmcp telegram`; redacted in config output. |
| `TDMCP_TELEGRAM_ALLOWED_CHATS` | _(empty)_ | Comma-separated Telegram chat ids allowed to reach the local copilot. At least this or `TDMCP_TELEGRAM_ALLOWED_USERS` must be set. |
| `TDMCP_TELEGRAM_ALLOWED_USERS` | _(empty)_ | Optional comma-separated Telegram user ids. When set, the user id must match in addition to any configured chat allowlist. |
| `TDMCP_TELEGRAM_DEFAULT_TIER` | `safe` | Default Telegram tool tier: `safe`, `standard`, or `creative`. Non-safe prompts still require `/approve`. |
| `TDMCP_TELEGRAM_POLL_TIMEOUT_SEC` | `30` | Telegram `getUpdates` long-poll timeout, validated to `1..60` seconds by the config schema. |
| `TDMCP_TELEGRAM_CONFIRM_TIMEOUT_MS` | `60000` | Expiry for a staged non-safe prompt awaiting `/approve`. |

## AI Party ShowIntent eval and rehearsal POC

These variables configure the local-model evaluation and optional improvement
pipeline under `training/showintent/`, plus the local Live Nervous System
rehearsal POC used by `npm run ai-party:*`.

| Variable | Default | Description |
| --- | --- | --- |
| `LLM_MODE` | `ollama` | Runtime mode label for the AI Party POC. The current eval harness targets Ollama. |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama base URL used by `npm run ai-party:llm-eval`, `npm run ai-party:llm-baseline` and the optional Live Nervous System parser. |
| `OLLAMA_MODEL` | `qwen2.5:3b` for eval, unset for the live POC | Ollama model id. The live dashboard uses deterministic fallback parsing when this is unset or unavailable. Use an improved model only after it beats the baseline without weakening safety metrics. |
| `TDMCP_AI_PARTY_LLM_MODEL` | `showintent-party:local` | Model id used by `tdmcp-agent ai-party --llm` when `--llm-model` / `OLLAMA_MODEL` are not set. This keeps the ShowIntent-only model separate from the general `tdmcp chat` model. |
| `LLM_EVAL_STRICT` | `false` | Set to `true` to make eval fail when demo-ready hard targets are not met. |
| `LLM_SCHEMA_VERSION` | `showintent.v1` | Schema/version label to record alongside reports and POC configuration. |
| `TD_BRIDGE_URL` | `http://127.0.0.1:9980` | TouchDesigner bridge URL used by `npm run ai-party:td-build` and dashboard TD preview checks. |
| `TD_BRIDGE_TOKEN` | _(unset)_ | Optional bridge bearer token for the Live Nervous System TD client. |
| `POC_DASHBOARD_HOST` | `127.0.0.1` | Host for the local AI Party dashboard/backend. |
| `POC_DASHBOARD_PORT` | `8787` | Port for the local AI Party dashboard/backend. |
| `POC_EVENT_LOG_PATH` | `./data/ai-party-poc-events.jsonl` | JSONL event log for operator commands, policy decisions, approvals, dispatch results and health changes. |
| `TELEGRAM_BOT_TOKEN` | _(unset)_ | Telegram bot token for `npm run ai-party:telegram`. This is separate from the general `tdmcp telegram` copilot variables. |
| `TELEGRAM_ALLOWED_CHAT_IDS` | _(empty)_ | Comma-separated chat allowlist required before the AI Party Telegram polling loop processes messages. |
| `TELEGRAM_POLLING_ENABLED` | `false` | Enables AI Party Telegram long polling; `npm run ai-party:telegram` turns polling on for that process. |
| `TELEGRAM_WEBHOOK_URL` | _(unset)_ | Reserved for deployed webhook work; local rehearsal uses long polling. |
| `HARDWARE_ENABLED` | `false` | Future-adapter gate for physical-effect dispatch. Leave false for local rehearsal. |
| `DMX_LIVE_ENABLED` | `false` | Future-adapter gate for DMX/live physical dispatch. Leave false unless a venue-safe adapter and kill path have been validated. |

## TouchDesigner side

Set these in **TouchDesigner's** environment (not the server's) for defense in
depth — they are enforced bridge-side, even for direct network callers. See
[Security](/reference/architecture#security).

| Variable | Default | Description |
| --- | --- | --- |
| `TDMCP_BRIDGE_ALLOW_LAN` | _(unset)_ | Bridge address scope. The bridge is loopback-only by default and refuses off-host (non-loopback) peers immediately (HTTP `403`), before routing/auth. Set to `1`/`true`/`yes`/`on` in TouchDesigner's environment to allow LAN peers; pair it with `TDMCP_BRIDGE_TOKEN`. |
| `TDMCP_BRIDGE_ALLOW_EXEC` | _(unset)_ | Optional bridge-side opt-in. Set to `1`/`true`/`on` in TouchDesigner's environment to allow arbitrary-code endpoints (`/api/exec`, node `method`) when no bridge token is configured. Leave unset for the safer default; structured endpoints keep working. |
| `TDMCP_BRIDGE_TOKEN` | _(unset)_ | Shared bearer token; must match the server's value to authorize requests. |
| `TDMCP_TOP_WRITE_MAX_BYTES` | `8388608` (8 MiB) | Bridge-side cap on the decoded pixel bytes of one `POST /api/top/write` call, enforced from the declared geometry **before** the base64 decode. An over-cap or mis-sized frame is a hard error — the endpoint never truncates or downscales. See [`POST /api/top/write`](/reference/bridge-api). |

## Example: MCP client config

```json
{
  "mcpServers": {
    "tdmcp": {
      "command": "node",
      "args": ["/abs/path/to/tdmcp/dist/index.js"],
      "env": {
        "TDMCP_TD_PORT": "9980",
        "TDMCP_VAULT_PATH": "~/Documents/MyVault"
      }
    }
  }
}
```
