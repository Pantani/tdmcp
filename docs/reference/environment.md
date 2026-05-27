---
description: "Environment variables for tdmcp, the TouchDesigner MCP server — configure the bridge host and port, auth token, vault path and exec safety."
---

# Environment variables

All configuration is through environment variables (no config file), so it works
cleanly in CI, Docker and MCP-client config. Every variable is optional and has a
sensible default. Set them in your MCP client's server config (the `env` block),
your shell, or the Claude Desktop extension settings.

## Server

| Variable | Default | Description |
| --- | --- | --- |
| `TDMCP_TD_HOST` | `127.0.0.1` | TouchDesigner bridge host. |
| `TDMCP_TD_PORT` | `9980` | Web Server DAT port. |
| `TDMCP_TRANSPORT` | `stdio` | MCP transport: `stdio` (default) or `http` (Streamable HTTP). |
| `TDMCP_HTTP_PORT` | `3939` | Port for the HTTP transport (when `TDMCP_TRANSPORT=http`). |
| `TDMCP_EVENTS` | `on` | Subscribe to TD WebSocket events and forward them as MCP logging notifications (`on`/`off`). |
| `TDMCP_RAW_PYTHON` | `on` | Whether to expose the raw-Python escape-hatch tools (`execute_python_script`, `exec_node_method`). Set to `off` to lock them out for restricted setups. |
| `TDMCP_BRIDGE_TOKEN` | _(unset)_ | Optional shared bearer token. When set, the server sends it and the bridge requires it — set the **same** value in TouchDesigner's environment to turn auth on. |
| `TDMCP_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `silent` (logged to stderr). |
| `TDMCP_REQUEST_TIMEOUT_MS` | `10000` | Per-request timeout to the bridge, in milliseconds. |
| `TDMCP_VAULT_PATH` | _(unset)_ | Absolute path to an Obsidian vault (a folder of Markdown notes). Enables the [vault tools](/reference/tools#obsidian-vault); a leading `~/` is expanded. Leave unset to disable them. |

## Local copilot (`tdmcp chat`)

These configure the [local LLM copilot](/reference/cli#local-copilot-tdmcp-chat).

| Variable | Default | Description |
| --- | --- | --- |
| `TDMCP_LLM_BASE_URL` | `http://127.0.0.1:11434/v1` | OpenAI-compatible chat endpoint. Defaults to local Ollama; point it at LM Studio, a cloud GPU or a paid API. |
| `TDMCP_LLM_MODEL` | `qwen2.5:3b` | Model id the copilot requests (must be pulled in the backend, e.g. `ollama pull qwen2.5:3b`). Bump to `qwen2.5:7b` for more headroom. |
| `TDMCP_LLM_API_KEY` | _(unset)_ | Optional bearer token for the LLM endpoint (ignored by local Ollama; needed for paid/cloud APIs). |
| `TDMCP_CHAT_PORT` | `4141` | Loopback port the `tdmcp chat` web UI binds to. |

## TouchDesigner side

Set these in **TouchDesigner's** environment (not the server's) for defense in
depth — they are enforced bridge-side, even for direct network callers. See
[Security](/reference/architecture#security).

| Variable | Default | Description |
| --- | --- | --- |
| `TDMCP_BRIDGE_ALLOW_EXEC` | `1` | Set to `0`/`false`/`off` to make the bridge refuse the arbitrary-code endpoints (`/api/exec`, node `method`). The structured endpoints keep working. |
| `TDMCP_BRIDGE_TOKEN` | _(unset)_ | Shared bearer token; must match the server's value to authorize requests. |

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
