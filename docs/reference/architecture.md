---
description: "How the TouchDesigner MCP server works — the MCP tool layers, the embedded operator knowledge base, and the bridge that runs inside TouchDesigner."
---

# Architecture

tdmcp is three programs that talk to each other on your machine:

```
   AI assistant            tdmcp server                TouchDesigner
  (Claude / Cursor)  ──▶  (Node / TypeScript)   ──▶   (the Python bridge inside TD)
   "make a feedback        MCP tools + the              creates / connects /
    tunnel from noise"     operator knowledge base       inspects / previews nodes
```

1. **The AI assistant** is any MCP-capable client — Claude Desktop, Claude Code,
   Codex, or Cursor. It's where you describe what you want.
2. **The tdmcp server** is a small Node program. It exposes a set of TouchDesigner
   "tools" and an embedded operator knowledge base to the AI over the
   [Model Context Protocol](https://modelcontextprotocol.io).
3. **The bridge** is a Python package that runs *inside* TouchDesigner (behind a
   Web Server DAT). It's what actually drives TD. See
   [Bridge & REST API](/reference/bridge-api).

```
MCP client ──stdio──▶ tdmcp server (Node/TS) ──HTTP──▶ TouchDesigner bridge (Python)
                       ├── Layer 1  artist tools (create_visual_system, …)
                       ├── Layer 2  building blocks (create_node_chain, …)
                       ├── Layer 3  atomic ops (create_td_node, …)
                       ├── Knowledge base (MCP resources)
                       ├── Recipes (validated network templates)
                       └── Feedback engine (errors / preview / performance)
```

## The three tool layers

Tools are organized into layers so the AI can pick the right altitude for a task.
See the full, always-current list in the [Tools reference](/reference/tools).

- **Layer 1 — artist tools.** Describe a result (`create_feedback_network`,
  `create_audio_reactive`, `create_generative_art`, …) and get a whole network,
  wired and arranged, often with a control panel ready to perform.
- **Layer 2 — building blocks.** Mid-level pieces (`create_node_chain`,
  `connect_nodes`, `create_control_panel`, `animate_parameter`,
  `create_external_io`, …) for assembling and controlling networks by hand.
- **Layer 3 — atomic operations.** Single-node CRUD plus inspection, analysis,
  rendering and the Python escape hatches (`create_td_node`, `find_td_nodes`,
  `get_td_node_errors`, `execute_python_script`, …).

A separate group of [vault tools](/reference/tools#obsidian-vault) bridges an
Obsidian vault and TouchDesigner.

## The create → verify → preview loop

Every high-level build follows the same loop so the AI can see and fix its own
work instead of guessing:

1. **Create** the network from a recipe, GLSL pattern, or generated Python.
2. **Verify** by reading cook/compile errors (`get_td_node_errors`,
   `summarize_td_errors`).
3. **Preview** by capturing the output TOP as an inline image (`get_preview`).

Generated networks are auto-arranged into a readable left→right layout
(`arrange_network`) instead of piling nodes on top of each other.

## Knowledge base

The server ships with an embedded, offline reference so the AI uses real
operators rather than inventing them: **629 operators**, **68 Python classes**,
workflow patterns, GLSL techniques and tutorials. These are exposed as MCP
resources the AI can read on demand:

`tdmcp://operators/{category|name}` · `tdmcp://python-api/{class}` ·
`tdmcp://patterns/{name}` · `tdmcp://glsl/{name}` · `tdmcp://recipes/{name}` ·
`tdmcp://tutorials/{name}`

The knowledge base is committed to the repo, so a fresh clone needs only
`npm install && npm run build`. `npm run import:bottobot` regenerates it from
`@bottobot/td-mcp` and is only needed to refresh it.

## Recipes

Recipes are validated network templates (JSON) the AI can instantiate with
`apply_recipe`. They cover common starting points — feedback tunnels,
reaction-diffusion, particle galaxies, audio spectrum bars, projection mapping
and more. See the [Recipe gallery](/guide/recipes) for what each one builds, and
[Contributing](https://github.com/Pantani/tdmcp/blob/main/CONTRIBUTING.md) to add
your own.

## Transports & events

The server speaks two MCP transports:

- **stdio** (default) — for local clients like Claude Desktop and Claude Code.
- **Streamable HTTP** (`TDMCP_TRANSPORT=http`) — serves MCP at
  `POST/GET/DELETE /mcp` on loopback with stateful sessions, for remote/headless
  setups. See [Deployment](/deployment).

It can also subscribe to a **WebSocket event stream** from TD
(`node.created` / `node.deleted` / `node.error` / `project.saved` /
`timeline.frame` / `node.cook`) and forward events as MCP logging notifications.
High-frequency events (`timeline.frame`, `node.cook`) are dropped unless
explicitly opted in. Toggle with `TDMCP_EVENTS`.

## Security

The TouchDesigner bridge runs **arbitrary Python inside your TD process** — that
is what lets the assistant build networks for you. Treat it like an open door to
the machine TD runs on:

- **The Web Server DAT listens on its port (default `9980`) on all network
  interfaces.** Anyone who can reach `http://<your-ip>:9980` can run code on that
  machine. Only run it on a trusted network, and/or firewall the port to
  localhost.
- **Turn on bridge auth for untrusted networks:** set `TDMCP_BRIDGE_TOKEN` to a
  shared secret in **both** the server's environment and TouchDesigner's
  environment. The bridge then rejects any request without a matching
  `Authorization: Bearer <token>` (HTTP `401`). Unset (default) keeps the
  zero-config local flow.
- `TDMCP_RAW_PYTHON=off` hides the raw-Python MCP tools, but only on the
  **server side** — a direct network caller could still hit the bridge's
  `/api/exec` and node-`method` endpoints. To close them at the bridge itself, set
  `TDMCP_BRIDGE_ALLOW_EXEC=0` in TouchDesigner's environment (defense in depth
  that holds even without a token); the structured endpoints keep working.
- The MCP server binds to loopback (`127.0.0.1`) for both transports and enables
  DNS-rebinding protection on HTTP.
- **The bridge refuses browser cross-origin requests.** Any request carrying an
  `Origin` header that isn't loopback is rejected (HTTP `401`), so a malicious web
  page can't quietly POST to the bridge (CSRF / DNS-rebinding → drive-by code
  execution). The MCP server sends no `Origin`, so normal use is unaffected.

All of these are configured through [environment variables](/reference/environment).

## Known limitations

- **WebSocket events** are forwarded as MCP logging notifications on both
  transports; high-frequency events are dropped unless opted in.
- **Audio / particle / 3D builders and the exotic recipes** (kinect, LED,
  projection) produce valid, connected networks but use best-effort TD parameter
  names — fine-tuning may be needed, and they emit warnings to that effect.
- **Preview** returns the TOP at its native resolution (the requested size is
  advisory).
- The bridge ships as Python modules plus a callbacks template (a binary `.tox`
  can't be generated from source); the one-line installer assembles it for you.
