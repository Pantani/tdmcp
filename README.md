# tdmcp — build TouchDesigner from plain language

**tdmcp** lets you create real visual systems in
[TouchDesigner](https://derivative.ca) just by describing them to an AI assistant
(Claude, Cursor, …). You type what you want; the AI builds the actual network of
nodes inside your project, checks it for errors, and shows you a preview.

> *"Create a feedback tunnel from noise with blur and displace, then add bloom and
> output it to a window."*

…and the nodes appear, wired up, in your `/project1`.

It works because it pairs two things every other tool was missing:

- **Real knowledge** — an embedded reference of 629 operators, 68 Python classes,
  32 workflow patterns, GLSL techniques and tutorials, so the AI uses real
  TouchDesigner operators instead of guessing.
- **Real execution** — a small **bridge** running inside TouchDesigner that
  actually creates, connects, inspects and previews nodes — with a
  create → verify → preview loop so the AI can see and fix its own work.

---

## How it works

Three pieces talk to each other on your computer:

```
   You + your AI            tdmcp server               TouchDesigner
  (Claude / Cursor)   ─▶   (a small program)    ─▶   (the bridge inside TD)
   "make a feedback                                      builds real nodes
    tunnel from noise"                                   in /project1
```

1. **Your AI assistant** — where you type what you want.
2. **The tdmcp server** — a small Node program that gives the AI a set of
   TouchDesigner "tools" and the operator knowledge base. You install it once.
3. **The bridge** — a tiny piece that runs *inside* TouchDesigner so the server
   can actually drive it. You switch it on once per machine.

You set all three up below. It takes about 5 minutes.

---

## What you'll need

- **[TouchDesigner](https://derivative.ca/download)** (free non-commercial
  edition is fine).
- **[Node.js](https://nodejs.org) version 20 or newer** — this runs the server.
  Not sure if you have it? Open a terminal and run `node -v`. If it prints a
  number ≥ 20 you're set; otherwise install it from the link.
- An MCP-capable AI client: **Claude Code**, **Claude Desktop**, or **Cursor**.

---

## Get started

### Step 1 — Install the tdmcp server (once)

Open a terminal and run these four lines. You only ever do this once.

```bash
git clone https://github.com/Pantani/tdmcp.git
cd tdmcp
npm install
npm run build
```

When it finishes you'll have a ready-to-run server at `dist/index.js`.

> 💡 **Tip — you'll need this folder's full path twice below.** While you're
> still in the `tdmcp` folder, run `pwd`. Copy what it prints (e.g.
> `/Users/you/tdmcp`) — that's your **project path**. Wherever the steps below
> say `<project-path>`, paste it in.

### Step 2 — Switch on the bridge inside TouchDesigner

This lets the server actually control TouchDesigner. The easy, set-and-forget way:

1. **Open TouchDesigner.**
2. Open **Preferences** (`Edit → Preferences`, or the **TouchDesigner** menu on
   macOS). In the **General** section, find **"Python 64-bit Module Path"** and
   paste:

   ```
   <project-path>/td/modules
   ```

   (Using the tip from Step 1 — e.g. `/Users/you/tdmcp/td/modules`.) Click OK.
3. Open the **Textport** (`Dialogs → Textport and DATs`), type this one line and
   press Enter:

   ```python
   from mcp import install; install.run()
   ```

You should see:

```
[tdmcp] bridge running on port 9980 (/project1/tdmcp_bridge)
```

Done — a `tdmcp_bridge` node now lives in your network and is listening. ✅

> This is **safe and reversible**: it only adds one tidy `tdmcp_bridge` component.
> Re-running the line just reconfigures it. To remove it later, run
> `from mcp import install; install.uninstall()`.
>
> Want it to start automatically in *every* project? Save the project (with that
> Module Path preference) as your **Default Project**, or see
> [`td/README.md`](td/README.md) for the Execute-DAT auto-start and the fully
> manual Web Server DAT setup.

### Step 3 — Connect your AI assistant

Point your AI client at the server you built in Step 1. Pick your client:

**Claude Code**

```bash
claude mcp add tdmcp -- node <project-path>/dist/index.js
```

**Claude Desktop** — edit `claude_desktop_config.json`
(`Settings → Developer → Edit Config`) and add:

```json
{
  "mcpServers": {
    "tdmcp": {
      "command": "node",
      "args": ["<project-path>/dist/index.js"]
    }
  }
}
```

**Cursor** — create `.cursor/mcp.json` in your workspace:

```json
{
  "mcpServers": {
    "tdmcp": {
      "command": "node",
      "args": ["<project-path>/dist/index.js"]
    }
  }
}
```

Restart your AI client so it picks up the new server.

### Step 4 — Make something

With TouchDesigner open and your AI client connected, just ask in plain language:

> *"Create an audio-reactive particle galaxy and show me a preview."*

The AI builds the network in your project, checks it for errors, and returns a
thumbnail. Iterate from there: *"make it warmer,"* *"add a feedback trail,"*
*"output it fullscreen."*

---

## Troubleshooting

| What you see | What to do |
| --- | --- |
| The AI says **"TouchDesigner isn't reachable."** | Make sure TD is open and the bridge is on (Step 2). Test it: `curl http://127.0.0.1:9980/api/info` should return JSON. |
| `from mcp import install` → **`No module named 'mcp'`** | The Module Path isn't set. Re-check Step 2.2 — it must point at `<project-path>/td/modules`, then restart TouchDesigner. |
| **`command not found: node` / `npm`** | Node isn't installed (or is too old). Install Node ≥ 20 from [nodejs.org](https://nodejs.org) and reopen the terminal. |
| **Your AI client doesn't list any tdmcp tools** | Restart the client after adding the server, and double-check the path to `dist/index.js` is the full absolute path. |
| **Port 9980 is already taken** | Set a different port in *both* places: the bridge (`install.run(port=9981)`) and the client (`TDMCP_TD_PORT=9981`). |

The server runs fine even when TouchDesigner is closed — TD-dependent tools just
return a friendly "not reachable" message instead of crashing.

---

## What you can do

**Artist tools** (describe the result, get a whole network):
`create_visual_system`, `create_feedback_network`, `create_generative_art`,
`create_audio_reactive`, `create_particle_system`, `apply_post_processing`,
`setup_output`, `get_preview`.

**Building blocks**: `create_node_chain`, `connect_nodes`, `create_glsl_shader`,
`create_python_script`, `set_parameters_batch`, `create_container`.

**Atomic operations**: `create_td_node`, `delete_td_node`,
`update_td_node_parameters`, `get_td_nodes`, `get_td_node_parameters`,
`get_td_node_errors`, `execute_python_script`, `exec_node_method`, `get_td_info`.

**Recipes** — 10 validated, ready-to-build templates: `feedback_tunnel`,
`reaction_diffusion`, `noise_landscape`, `audio_spectrum_bars`, `particle_galaxy`,
`webcam_glitch`, `data_sonification`, `kinect_silhouette`, `led_strip_mapper`,
`projection_mapping`.

**Knowledge resources** the AI reads from:
`tdmcp://operators/{category|name}`, `tdmcp://python-api/{class}`,
`tdmcp://patterns/{name}`, `tdmcp://glsl/{name}`, `tdmcp://recipes/{name}`,
`tdmcp://tutorials/{name}`.

**Prompt modes**: `visual_artist_mode`, `debug_network`, `optimize_performance`,
`explain_network`, `remix_visual`.

---

## Architecture (for developers)

```
MCP client ──stdio──▶ tdmcp server (Node/TS) ──HTTP──▶ TouchDesigner bridge (Python)
                       ├── Layer 1  artist tools (create_visual_system, …)
                       ├── Layer 2  building blocks (create_node_chain, …)
                       ├── Layer 3  atomic ops (create_td_node, …)
                       ├── Knowledge base (MCP resources)
                       ├── Recipes (validated network templates)
                       └── Feedback engine (errors / preview / performance)
```

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `TDMCP_TD_HOST` | `127.0.0.1` | TouchDesigner bridge host |
| `TDMCP_TD_PORT` | `9980` | Web Server DAT port |
| `TDMCP_TRANSPORT` | `stdio` | MCP transport (`stdio`; `http` is scaffolded) |
| `TDMCP_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `silent` (stderr) |
| `TDMCP_REQUEST_TIMEOUT_MS` | `10000` | Per-request timeout to the bridge |

### Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | run the server from source (stdio) |
| `npm run build` | typecheck + bundle + copy assets to `dist/` |
| `npm test` | unit + integration tests (Vitest + MSW) |
| `npm run typecheck` / `npm run lint` | TypeScript / Biome |
| `npm run smoke:live` | end-to-end test against a running TD |
| `npm run validate:recipes` | validate every recipe JSON |
| `npm run import:bottobot` | (re)build the embedded knowledge base — only needed to refresh it |

> The knowledge base ships in the repo, so a fresh clone needs only
> `npm install && npm run build`. `import:bottobot` is a maintenance command for
> regenerating it from `@bottobot/td-mcp`.

### Verify end-to-end

With TD open and the bridge running:

```bash
npm run smoke:live   # creates a Noise→Null chain in /project1 and grabs a preview
```

---

## Current state

- ✅ 23 tools across 3 layers, 6 resource families, 5 prompts, 10 recipes, a
  feedback engine, and the TouchDesigner Python bridge.
- ✅ `typecheck`, `build`, `lint`, and `test` all pass; the server boots over
  stdio with clean stdout.
- 🔌 Verified end-to-end against a live TouchDesigner.

## Known limitations

- **HTTP/SSE transport** is scaffolded behind `TDMCP_TRANSPORT`, but only `stdio`
  is wired in this build.
- **Audio / particle / 3D builders and the exotic recipes** (kinect, LED,
  projection) produce valid, connected networks but use best-effort TD parameter
  names — fine-tuning may be needed, and they emit warnings to that effect.
- **Preview** returns the TOP at its native resolution (the requested size is
  advisory).
- The bridge ships as Python modules plus a callbacks template (a binary `.tox`
  can't be generated from source); the one-liner in Step 2 assembles it for you.

## License

MIT — see [LICENSE](LICENSE).
