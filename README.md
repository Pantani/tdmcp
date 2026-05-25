# tdmcp — AI-native visual creation for TouchDesigner

`@tdmcp/server` is a production-grade [Model Context Protocol](https://modelcontextprotocol.io)
server that lets any MCP client (Claude Desktop, Claude Code, Cursor, …) build
visual systems in [TouchDesigner](https://derivative.ca) from natural language —
grounded by an embedded operator knowledge base and a create → verify → preview
feedback loop.

It combines the two halves the ecosystem was missing:

- **Authoritative knowledge** (629 operators, 68 Python classes, 32 workflow
  patterns, GLSL techniques, tutorials — sourced from `@bottobot/td-mcp`) exposed
  as MCP **resources**, so the model never hallucinates operators.
- **Real execution** through a TouchDesigner **bridge** (a Web Server DAT), wrapped
  in three tool layers — from atomic `create_td_node` up to
  `create_visual_system("a feedback tunnel that reacts to the bass")`.

## Architecture

```
MCP client ──stdio──▶ tdmcp server (Node/TS) ──HTTP──▶ TouchDesigner bridge (Python)
                       ├── Layer 1  artist tools (create_visual_system, …)
                       ├── Layer 2  building blocks (create_node_chain, …)
                       ├── Layer 3  atomic ops (create_td_node, …)
                       ├── Knowledge base (MCP resources)
                       ├── Recipes (validated network templates)
                       └── Feedback engine (errors / preview / performance)
```

## Install

Requires **Node.js ≥ 20**.

```bash
git clone <this repo> && cd tdmcp
npm install
npm run import:bottobot   # populate the embedded knowledge base
npm run build
```

## Run the MCP server

```bash
npm run dev          # stdio, from source (tsx)
# or
npm run build && npm start   # stdio, from dist/
```

The server starts even when TouchDesigner is not running; TD-dependent tools then
return a friendly "not reachable" message instead of failing.

## Configure your MCP client

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tdmcp": {
      "command": "node",
      "args": ["/absolute/path/to/tdmcp/dist/index.js"],
      "env": { "TDMCP_TD_HOST": "127.0.0.1", "TDMCP_TD_PORT": "9980" }
    }
  }
}
```

### Claude Code

```bash
claude mcp add tdmcp -- node /absolute/path/to/tdmcp/dist/index.js
```

or commit a `.mcp.json` at your repo root:

```json
{ "mcpServers": { "tdmcp": { "command": "node", "args": ["./dist/index.js"] } } }
```

### Cursor

`.cursor/mcp.json`:

```json
{ "mcpServers": { "tdmcp": { "command": "node", "args": ["/absolute/path/to/tdmcp/dist/index.js"] } } }
```

## Connect TouchDesigner

Install the Python bridge so the server can drive TD — see
[`td/README.md`](td/README.md). In short: copy `td/modules` into your project,
add a **Web Server DAT** on port `9980`, and point its callbacks at
`td/templates/webserver_callbacks.py`. Then:

```bash
npm run smoke:live   # creates a Noise→Null chain in /project1 and grabs a preview
```

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `TDMCP_TD_HOST` | `127.0.0.1` | TouchDesigner bridge host |
| `TDMCP_TD_PORT` | `9980` | Web Server DAT port |
| `TDMCP_TRANSPORT` | `stdio` | MCP transport (`stdio`; `http` is scaffolded) |
| `TDMCP_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `silent` (stderr) |
| `TDMCP_REQUEST_TIMEOUT_MS` | `10000` | Per-request timeout to the bridge |

## What you can do

**Tools** — Layer 1 (artist): `create_visual_system`, `create_feedback_network`,
`create_generative_art`, `create_audio_reactive`, `create_particle_system`,
`apply_post_processing`, `setup_output`, `get_preview`. Layer 2 (building blocks):
`create_node_chain`, `connect_nodes`, `create_glsl_shader`, `create_python_script`,
`set_parameters_batch`, `create_container`. Layer 3 (atomic): `create_td_node`,
`delete_td_node`, `update_td_node_parameters`, `get_td_nodes`,
`get_td_node_parameters`, `get_td_node_errors`, `execute_python_script`,
`exec_node_method`, `get_td_info`.

**Resources** — `tdmcp://operators/{category|name}`, `tdmcp://python-api/{class}`,
`tdmcp://patterns/{name}`, `tdmcp://glsl/{name}`, `tdmcp://recipes/{name}`,
`tdmcp://tutorials/{name}`.

**Prompts** — `visual_artist_mode`, `debug_network`, `optimize_performance`,
`explain_network`, `remix_visual`.

**Recipes** — 10 validated templates (`feedback_tunnel`, `reaction_diffusion`,
`noise_landscape`, `audio_spectrum_bars`, `particle_galaxy`, `webcam_glitch`,
`data_sonification`, `kinect_silhouette`, `led_strip_mapper`, `projection_mapping`).

### Example

> "Create a feedback tunnel from noise with blur and displace, then add bloom and
> rgb split, and output to a window."

The agent calls `create_feedback_network` → `apply_post_processing` →
`setup_output`, checks `get_td_node_errors`, and returns a `get_preview` thumbnail.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | run the server from source (stdio) |
| `npm run build` | typecheck + bundle + copy assets to `dist/` |
| `npm test` | unit + integration tests (Vitest + MSW) |
| `npm run typecheck` / `npm run lint` | TypeScript / Biome |
| `npm run import:bottobot` | (re)build the knowledge base |
| `npm run validate:recipes` | validate every recipe JSON |
| `npm run smoke:live` | end-to-end test against a running TD |

## Current state

- ✅ Phases 1–4 implemented: 23 tools across 3 layers, 6 resources, 5 prompts,
  10 recipes, feedback engine, and the TD Python bridge.
- ✅ `typecheck`, `build`, `lint`, and `test` all pass; the server boots over
  stdio with clean stdout.
- 🔌 Verified end-to-end against a live TouchDesigner via `npm run smoke:live`.

## Known limitations

- **JSON Schema → Zod:** the original spec wrote tool inputs as raw JSON Schema.
  The MCP SDK (1.29) takes **Zod** shapes, so every tool input was translated to
  Zod (same fields/semantics). This is the only intentional deviation from the spec.
- **HTTP/SSE transport** is scaffolded behind `TDMCP_TRANSPORT` but only `stdio`
  is wired in this build.
- **Audio/particle/3D builders and the exotic recipes** (kinect, LED, projection)
  produce valid, connected networks but use best-effort TD parameter names; fine
  tuning may be needed for production — they emit warnings to that effect.
- **Preview** returns the TOP at native resolution (requested size is advisory).
- The `.tox` is assembled from the provided Python modules (see `td/README.md`),
  not generated by the build.

## License

MIT — see [LICENSE](LICENSE).
