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
  create → verify → preview loop so the AI can see and fix its own work. Every
  generated network is auto-arranged into a readable left→right layout instead
  of piling nodes on top of each other.

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

The steps below wire these together — about 5 minutes (less with the one-click
Claude Desktop extension, which bundles the server for you).

---

## What you'll need

- **[TouchDesigner](https://derivative.ca/download)** — the free non-commercial
  edition is fine.
- An MCP-capable AI assistant: **Claude Desktop** (easiest), **Claude Code**,
  **Codex**, or **Cursor**.

**Do I need Node.js?** Only for the build-from-source path (Claude Code, Codex,
or Cursor), which needs **[Node.js 20+](https://nodejs.org)** — check with
`node -v`. The
one-click Claude Desktop extension needs **nothing extra**: Claude Desktop ships
with its own Node, and the server is bundled inside the `.dxt`.

---

## Get started

You set up **two sides**: your **AI** (so it gets the tdmcp tools) and
**TouchDesigner** (so the AI can drive it). Pick whichever way is easiest for you.

**🤖 The easiest way — let your AI install it for you.** If you already use
**Claude Code**, **Codex**, or **Cursor**, you don't have to do any of the manual
steps below. Just **paste this one message** into it:

```text
Install and connect tdmcp for me by reading and following
https://raw.githubusercontent.com/Pantani/tdmcp/main/tdmcp-install-prompt.md
Do every step yourself; only stop when you need me to paste one line into TouchDesigner.
```

**That's the whole install.** Your AI clones, builds, and wires everything up on
its own. The *only* thing it will ask you to do is paste one line into
TouchDesigner's Textport when it's ready — nothing else. (It's the
[`tdmcp-install-prompt.md`](tdmcp-install-prompt.md) runbook doing the work.)

**Prefer to do it yourself, or using Claude Desktop?** Follow the three manual
steps below — Step 1's one-click `.dxt` is the no-terminal, no-Node route for
Claude Desktop.

### Step 1 — Connect tdmcp to your AI

Pick the one tab that matches your client.

<details open>
<summary><b>🟢 Claude Desktop — one-click <code>.dxt</code> (easiest: no terminal, no Node)</b></summary>

<br />

A `.dxt` is **one file** Claude Desktop installs as an extension. The tdmcp server
is **bundled inside it** — no terminal, no Node install, nothing to keep running
yourself.

1. **Download** the bundle →
   **[⬇ tdmcp.dxt](https://github.com/Pantani/tdmcp/releases/latest/download/tdmcp.dxt)**
   (always the latest release).
2. **Install it:** in Claude Desktop open **Settings → Extensions**, then drag
   `tdmcp.dxt` onto the window (or click **Install from file**).
3. **Enable it.** Leave the TouchDesigner **host** / **port** at `127.0.0.1` /
   `9980` unless you changed them.

Connected — **now do Step 2** to turn on the bridge. (Docker/HTTP options live in
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).)

</details>

<details>
<summary><b>Claude Code, Codex, or Cursor — build from source (needs Node 20+)</b></summary>

<br />

This path builds the server locally, so you need
**[Node.js 20+](https://nodejs.org)** (`node -v` to check).

```bash
git clone https://github.com/Pantani/tdmcp.git
cd tdmcp
npm run setup
```

`npm run setup` installs, builds, and then **prints the exact line to connect your
AI**, with your real paths already filled in — paste it and you're done. The manual
equivalents:

- **Claude Code:**

  ```bash
  claude mcp add tdmcp -- node <project-path>/dist/index.js
  ```

- **Codex CLI:**

  ```bash
  codex mcp add tdmcp -- node <project-path>/dist/index.js
  ```

  Prefer editing config by hand? Add this to `~/.codex/config.toml`:

  ```toml
  [mcp_servers.tdmcp]
  command = "node"
  args = ["<project-path>/dist/index.js"]
  ```

- **Cursor** — create `.cursor/mcp.json` in your workspace:

  ```json
  {
    "mcpServers": {
      "tdmcp": { "command": "node", "args": ["<project-path>/dist/index.js"] }
    }
  }
  ```

`<project-path>` is the folder you cloned — run `pwd` inside it for the full path.
Restart your client afterward so it loads the server. **Now do Step 2.**

</details>

### Step 2 — Turn on the bridge inside TouchDesigner (everyone)

This is the **same one line** no matter which client you set up in Step 1 — it's
what lets the server actually drive TouchDesigner.

1. **Open TouchDesigner.**
2. Open the **Textport** (`Dialogs → Textport and DATs`), paste this **one line**
   and press Enter:

   ```python
   import urllib.request; exec(urllib.request.urlopen("https://raw.githubusercontent.com/Pantani/tdmcp/main/td/bootstrap.py").read().decode())
   ```

You should see:

```
[tdmcp] bridge running on port 9980 (/project1/tdmcp_bridge)
```

Done — a `tdmcp_bridge` node now lives in your network and is listening. ✅ It's
safe and reversible: it only adds that one tidy component, and re-running the line
just reconfigures it.

<details>
<summary>Keep it on across restarts · other install methods · removing it</summary>

<br />

- **Start it automatically in every project:** save your project as your
  **Default Project**, or use the Execute-DAT auto-start in
  [`td/README.md`](td/README.md).
- **If you cloned the repo** and want a set-and-forget install: add
  `<project-path>/td/modules` to TouchDesigner's **Python 64-bit Module Path**
  (`Edit → Preferences → General`), then run
  `from mcp import install; install.run()` in the Textport.
- **From a terminal:** `npx @dpantani/tdmcp install-bridge` (or
  `node <project-path>/dist/index.js install-bridge` from a clone) copies the
  bridge to `~/tdmcp-bridge` and prints the Textport line.
- **Remove it later:** `from mcp import install; install.uninstall()`.
- **Port 9980 taken?** Set it in both places — the bridge
  (`install.run(port=9981)`) and the client (`TDMCP_TD_PORT=9981`).

</details>

### Step 3 — Make something

With TouchDesigner open and your AI connected, just ask in plain language:

> *"Create an audio-reactive particle galaxy and show me a preview."*

The AI builds the network in your project, checks it for errors, and returns a
thumbnail. Iterate from there: *"make it warmer,"* *"add a feedback trail,"*
*"output it fullscreen."*

> 💡 Once tdmcp is published to npm, the Claude Code wiring becomes path-free:
> `claude mcp add tdmcp -- npx -y @dpantani/tdmcp`.

---

## Troubleshooting

| What you see | What to do |
| --- | --- |
| The AI says **"TouchDesigner isn't reachable."** | Make sure TD is open and the bridge is on (Step 2). Test it: `curl http://127.0.0.1:9980/api/info` should return JSON. |
| `from mcp import install` → **`No module named 'mcp'`** | You're using the Module-Path method but it isn't set — point it at `<project-path>/td/modules` (see Step 2's collapsed options) and restart TouchDesigner. Or just use the one-line bootstrap in Step 2 instead. |
| **`command not found: node` / `npm`** | Node isn't installed (or is too old). Install Node ≥ 20 from [nodejs.org](https://nodejs.org) and reopen the terminal. |
| **Your AI client doesn't list any tdmcp tools** | Restart the client after adding the server, and double-check the path to `dist/index.js` is the full absolute path. |
| **Port 9980 is already taken** | Set a different port in *both* places: the bridge (`install.run(port=9981)`) and the client (`TDMCP_TD_PORT=9981`). |

The server runs fine even when TouchDesigner is closed — TD-dependent tools just
return a friendly "not reachable" message instead of crashing.

---

## What you can do

**Artist tools** (describe the result, get a whole network):
`create_visual_system`, `create_feedback_network`, `create_generative_art`,
`create_audio_reactive`, `create_particle_system`, `create_data_visualization`,
`apply_post_processing`, `setup_output`, `get_preview`, `plan_visual`. Feedback,
particle, generative and audio-reactive systems arrive already playable — they
auto-expose a control panel (a Feedback knob, particle Drag/Turbulence/Gravity/Lifetime,
an evolution-Speed knob, an audio Sensitivity knob) you can tweak, animate, preset, or
map to a controller. Pass `expose_controls: false` to opt out.

**Building blocks**: `create_node_chain`, `connect_nodes`, `create_glsl_shader`,
`create_python_script`, `set_parameters_batch`, `create_container`,
`duplicate_network`, `arrange_network` (tidy a messy network into a readable
left→right layout).

**Live control, animation & I/O** (make a generated system playable):
`create_control_panel` (add knobs/sliders/toggles to a COMP and bind them to node
parameters), `manage_presets` (store/recall/list named snapshots of those controls),
`animate_parameter` (drive parameters with an LFO over time — no manual keyframing),
`create_external_io` (OSC/MIDI input mapped straight to parameters, DMX/Art-Net out
for lighting, NDI/Syphon-Spout video in), and `manage_component` (save/load reusable
`.tox` components).

**Atomic operations**: `create_td_node`, `delete_td_node`,
`update_td_node_parameters`, `execute_python_script`, `exec_node_method`.

**Inspect & analyze**: `get_td_info`, `get_td_nodes`, `get_td_node_parameters`,
`get_td_node_errors`, `get_td_performance`, `get_td_topology`, `get_td_classes`,
`get_td_class_details`, `get_module_help` (plus search / summary / compare /
snapshot helpers).

**Recipes** — 11 validated, ready-to-build templates: `feedback_tunnel`,
`performable_feedback_tunnel` (the same tunnel pre-wired with live knobs for
decay/zoom/spin/blur — ready to perform, animate with an LFO, or snapshot as
presets), `reaction_diffusion`, `noise_landscape`, `audio_spectrum_bars`,
`particle_galaxy`, `webcam_glitch`, `data_sonification`, `kinect_silhouette`,
`led_strip_mapper`, `projection_mapping`.

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
| `TDMCP_TRANSPORT` | `stdio` | MCP transport: `stdio` (default) or `http` (Streamable HTTP) |
| `TDMCP_HTTP_PORT` | `3939` | Port for the HTTP transport (when `TDMCP_TRANSPORT=http`) |
| `TDMCP_EVENTS` | `on` | Subscribe to TD WebSocket events and forward them as MCP logging notifications (`on`/`off`) |
| `TDMCP_RAW_PYTHON` | `on` | Whether to expose the raw-Python escape-hatch tools (`execute_python_script`, `exec_node_method`). Set to `off` to lock them out for restricted setups |
| `TDMCP_BRIDGE_TOKEN` | _(unset)_ | Optional shared bearer token. When set, the server sends it and the bridge requires it — set the **same** value in TouchDesigner's environment to turn auth on |
| `TDMCP_BRIDGE_ALLOW_EXEC` | `1` | **Set in TouchDesigner's environment.** Set to `0`/`false`/`off` to make the bridge refuse the arbitrary-code endpoints (`/api/exec`, node `method`) — enforced bridge-side, even for direct network callers |
| `TDMCP_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `silent` (stderr) |
| `TDMCP_REQUEST_TIMEOUT_MS` | `10000` | Per-request timeout to the bridge |

The HTTP transport (`TDMCP_TRANSPORT=http`) serves MCP at `POST/GET/DELETE /mcp`
on `127.0.0.1:$TDMCP_HTTP_PORT` with stateful sessions — handy for remote/headless
setups. See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for Docker and the Claude
Desktop `.dxt` extension.

### Security

The TouchDesigner bridge runs **arbitrary Python inside your TD process** (that is
what lets the assistant build networks for you). Treat it like an open door to the
machine TD runs on:

- **The Web Server DAT listens on its port (default `9980`) on all network
  interfaces.** Anyone who can reach `http://<your-ip>:9980` can run code on that
  machine. Only run it on a trusted network, and/or firewall the port to localhost.
- **Turn on bridge auth for untrusted networks:** set `TDMCP_BRIDGE_TOKEN` to a
  shared secret in **both** the MCP server's environment and TouchDesigner's
  environment. The bridge then rejects any request without a matching
  `Authorization: Bearer <token>` (HTTP `401`). Unset (default) keeps the
  zero-config local flow.
- `TDMCP_RAW_PYTHON=off` hides the raw-Python MCP tools, but it only gates the
  **MCP-server side** — a direct network caller could still hit the bridge's
  `/api/exec` and node-`method` endpoints. To close them at the bridge itself, set
  `TDMCP_BRIDGE_ALLOW_EXEC=0` in TouchDesigner's environment (defense in depth that
  holds even without a token); the structured endpoints keep working.
- The MCP server itself binds to loopback (`127.0.0.1`) for both stdio and HTTP
  transports and enables DNS-rebinding protection on HTTP.
- **The bridge refuses browser cross-origin requests.** Any request carrying an
  `Origin` header that isn't loopback (`127.0.0.1`/`localhost`) is rejected (HTTP
  `401`), so a malicious web page open in your browser can't quietly POST to the
  bridge (CSRF / DNS-rebinding → drive-by code execution). The MCP server sends no
  `Origin`, so normal use is unaffected.

### Command-line agent (`tdmcp-agent`)

The package also installs a second binary, `tdmcp-agent`, that drives the same
tools from a shell with machine-readable output — useful for scripts and CI:

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

### Scripts

| Script | Purpose |
| --- | --- |
| `npm run setup` | guided install + build, then prints how to connect your client |
| `npm run dev` | run the server from source (stdio) |
| `npm run build` | typecheck + bundle + copy assets to `dist/` |
| `npm test` | unit + integration tests (Vitest + MSW) |
| `npm run typecheck` / `npm run lint` | TypeScript / Biome |
| `npm run smoke:live` | end-to-end test against a running TD |
| `npm run validate:recipes` | validate every recipe JSON |
| `npm run import:bottobot` | (re)build the embedded knowledge base — only needed to refresh it |
| `npm run build:dxt` | package a Claude Desktop `.dxt` extension (see `docs/DEPLOYMENT.md`) |

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

- ✅ 41 tools across 3 layers, 6 resource families, 5 prompts, 11 recipes, a
  feedback engine, and the TouchDesigner Python bridge.
- ✅ Two transports: **stdio** (default) and **Streamable HTTP**; plus an optional
  **WebSocket event stream** (TD → MCP logging notifications).
- ✅ `typecheck`, `build`, `lint`, and `test` all pass; the server boots over
  stdio with clean stdout.
- 🔌 Verified end-to-end against a live TouchDesigner (CRUD, preview, batch, and
  `node.created`/`node.deleted` events).

## Known limitations

- **WebSocket events** (`node.created` / `node.deleted` / `node.error` /
  `project.saved` / `timeline.frame` / `node.cook`) are forwarded as MCP logging
  notifications on both transports. High-frequency events (`timeline.frame`,
  `node.cook`) are dropped by the consumer unless explicitly opted in.
- **Audio / particle / 3D builders and the exotic recipes** (kinect, LED,
  projection) produce valid, connected networks but use best-effort TD parameter
  names — fine-tuning may be needed, and they emit warnings to that effect.
- **Preview** returns the TOP at its native resolution (the requested size is
  advisory).
- The bridge ships as Python modules plus a callbacks template (a binary `.tox`
  can't be generated from source); the one-liner in Step 2 assembles it for you.

## License

MIT — see [LICENSE](LICENSE).
