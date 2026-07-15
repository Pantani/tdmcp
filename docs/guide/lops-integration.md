---
description: "Use tdmcp from inside TouchDesigner via dotsimulate's LOPs MCP Client — point it at the hardened launcher and an in-TD agent can build and inspect your project."
---

# Use from TouchDesigner (LOPs)

dotsimulate's **LOPs "MCP Client"** runs *inside* TouchDesigner and can talk to
any MCP server. Point it at tdmcp and an agent living in your TD network can
build, wire, inspect and preview operators in that same project — closing the
loop **TD (LOPs MCP Client) → tdmcp server → the tdmcp bridge → your network.**

This is **not** an LLM-backend swap: LOPs brings its own model (OpenAI / Claude /
Ollama); tdmcp is the *tools* it calls, exactly like Claude or Cursor would.

## What you get

The LOPs client gets the **full tdmcp tool surface** — the build/inspect/preview
tools **plus** the knowledge-base tools (`get_td_classes`,
`get_td_class_details`, `get_module_help`, `search_operators`, `find_td_nodes`).
Those KB tools cover part of what dotsimulate's *dotContext* provides, so you
don't need a separate operator-reference layer alongside tdmcp.

When you connect through the recommended launcher (below), tdmcp starts in its
**`safe` profile** — the destructive tools are hidden so an autonomous in-TD
agent can't delete nodes or run unreviewed code by accident.

## Prerequisites

- The tdmcp **bridge is installed and running** inside the *same* TouchDesigner
  instance — see [install step 3, "turn on the bridge"](/guide/install#turn-on-the-bridge).
- **Node.js 20+ on your PATH** — LOPs spawns `node`.
- You have run **`npm run build`** in your tdmcp checkout, so `dist/index.js`
  exists.
- dotsimulate's **LOPs** is installed, with the MCP Client component.

## Connect (recommended: the launcher)

dotsimulate's `servers_config.json` documents `transport`, `command`, `args`,
`cwd` and `description` — but **no `env` field** — so we can't set tdmcp's
hardening variables through the config directly. tdmcp ships a tiny launcher,
`scripts/tdmcp-lops.mjs`, that sets them for you and then starts the server.
Point the LOPs client at it:

```json
{
  "mcpServers": {
    "tdmcp": {
      "transport": "stdio",
      "command": "node",
      "args": ["/abs/path/to/tdmcp/scripts/tdmcp-lops.mjs"],
      "cwd": "/abs/path/to/tdmcp",
      "description": "tdmcp — build & inspect this TouchDesigner project (hardened: safe profile)"
    }
  }
}
```

Replace `/abs/path/to/tdmcp` with the folder where you cloned tdmcp (run `pwd`
inside it). Use the **full absolute path** for both `command`/`args` and `cwd` —
LOPs resolves `cwd` differently than CLI clients, so don't rely on relative
paths. The `tdmcp-lops.mjs` launcher sets the `safe` profile for you.

## Alternative: an `env` block (if your LOPs build supports it)

dotsimulate's published schema does **not** document an `env` field, so the
launcher above is the safe default. If your LOPs build happens to pass an `env`
block through, you can instead point `args` straight at `dist/index.js` and set
the variables yourself:

```json
{
  "mcpServers": {
    "tdmcp": {
      "transport": "stdio",
      "command": "node",
      "args": ["/abs/path/to/tdmcp/dist/index.js"],
      "cwd": "/abs/path/to/tdmcp",
      "env": {
        "TDMCP_RAW_PYTHON": "off",
        "TDMCP_TOOL_PROFILE": "safe"
      },
      "description": "tdmcp — hardened for an in-TD agent"
    }
  }
}
```

If the `env` block is ignored (you'll see the destructive tools still listed),
fall back to the launcher.

## Hardening note

For an autonomous in-TD agent — no human reviewing each call — harden the
surface:

- **`TDMCP_RAW_PYTHON=off`** removes the two raw-Python tools
  (`execute_python_script`, `exec_node_method`) where the *client* authors the
  code. It is **not** a code-execution kill-switch: many higher-level tools still
  send their own *templated* Python to the bridge.
- **`TDMCP_TOOL_PROFILE=safe`** goes further and also hides destructive tools
  (node deletion, DAT rewrites, checkpoint/component/package writes, preview-asset
  writes, panic controls) — a strict superset of `RAW_PYTHON=off`. The launcher sets this for you. See
  [Environment variables](/reference/environment).
- Bridge-side arbitrary exec is now closed by default unless
  **`TDMCP_BRIDGE_ALLOW_EXEC=1`** is explicitly set in *TouchDesigner's* own
  environment. `TDMCP_BRIDGE_TOKEN` authenticates requests but does not enable
  arbitrary exec. Keep it closed for autonomous LOPs use.

## How it works

Both the LOPs client and the tdmcp bridge live in the **same** TouchDesigner
process. The LOPs client spawns `node dist/index.js` (the tdmcp server) over
stdio; that server then talks HTTP to the bridge on `127.0.0.1:9980` — the very
same TD — which manipulates your network. No transport change is needed; stdio is
tdmcp's default. The spawned server is short-lived, tied to the MCP client's
lifecycle. See [Architecture](/reference/architecture#transports-events).

## This does NOT replace `tdmcp chat`

The [local LLM copilot](/guide/local-copilot) (`tdmcp chat`) is a *separate*
surface — tdmcp running its own local model. LOPs is a **client that consumes its
own model** (OpenAI / Claude / Ollama) and calls tdmcp's tools; it is not a
swap-in for the copilot's model backend. Use whichever fits your workflow.

## Troubleshooting

- **"node not found"** — LOPs couldn't find Node on its PATH. Install
  [Node.js 20+](https://nodejs.org) and make sure it's on the PATH the TD process
  inherits.
- **"dist/index.js not found"** — the launcher prints this to stderr when the
  build is missing. Run `npm run build` in your tdmcp folder.
- **"bridge not reachable"** — the tdmcp bridge isn't running in this TD, or it's
  on a different host/port. Re-check [install step 3](/guide/install#turn-on-the-bridge)
  and [Troubleshooting](/guide/troubleshooting).
