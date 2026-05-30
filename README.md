# tdmcp — TouchDesigner MCP server

[![CI](https://github.com/Pantani/tdmcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Pantani/tdmcp/actions/workflows/ci.yml)
[![Docs](https://github.com/Pantani/tdmcp/actions/workflows/docs.yml/badge.svg)](https://pantani.github.io/tdmcp/)
[![npm version](https://img.shields.io/npm/v/@dpantani/tdmcp?logo=npm&color=cb3837)](https://www.npmjs.com/package/@dpantani/tdmcp)
[![Node.js](https://img.shields.io/node/v/@dpantani/tdmcp?logo=nodedotjs&color=339933)](https://nodejs.org)
[![MCP server](https://img.shields.io/badge/MCP-server-000?logo=modelcontextprotocol&logoColor=white)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![tdmcp MCP server](https://glama.ai/mcp/servers/Pantani/tdmcp/badges/score.svg)](https://glama.ai/mcp/servers/Pantani/tdmcp)

**tdmcp is a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server
for [TouchDesigner](https://derivative.ca)** — build TouchDesigner from plain
language. You describe a visual to an AI assistant (Claude, Claude Code, Cursor,
Codex); the AI builds the actual network of nodes inside your project, checks it
for errors, and shows you a preview.

> *"Create a feedback tunnel from noise with blur and displace, then add bloom and
> output it to a window."*

…and the nodes appear, wired up, in your `/project1`.

It works because it pairs two things every other tool was missing:

- **Real knowledge** — an embedded reference of 629 operators, 68 Python classes,
  workflow patterns, GLSL techniques and tutorials, so the AI uses real
  TouchDesigner operators instead of guessing.
- **Real execution** — a small **bridge** running inside TouchDesigner that
  actually creates, connects, inspects and previews nodes — with a
  create → verify → preview loop so the AI can see and fix its own work. Every
  generated network is auto-arranged into a readable left→right layout.

## 📖 Documentation

Full guides and reference live on the **docs site → <https://pantani.github.io/tdmcp/>**

| For artists / musicians | For developers |
| --- | --- |
| [What is tdmcp?](https://pantani.github.io/tdmcp/guide/what-is-tdmcp) | [Architecture](https://pantani.github.io/tdmcp/reference/architecture) |
| [Install (no terminal)](https://pantani.github.io/tdmcp/guide/install) | [Tools reference](https://pantani.github.io/tdmcp/reference/tools) |
| [Your first visual](https://pantani.github.io/tdmcp/guide/first-visual) | [Environment variables](https://pantani.github.io/tdmcp/reference/environment) |
| [Shader Park](https://pantani.github.io/tdmcp/guide/shader-park) | [CLI & local copilot](https://pantani.github.io/tdmcp/reference/cli) |
| [Prompt cookbook](https://pantani.github.io/tdmcp/guide/prompt-cookbook) | [Bridge & REST API](https://pantani.github.io/tdmcp/reference/bridge-api) |
| [Recipe gallery](https://pantani.github.io/tdmcp/guide/recipes) | [Roadmap](docs/ROADMAP.md) |
| [Troubleshooting](https://pantani.github.io/tdmcp/guide/troubleshooting) | [Deployment](docs/DEPLOYMENT.md) |

🇧🇷 **Documentação em português:** <https://pantani.github.io/tdmcp/pt/>

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

## What you'll need

- **[TouchDesigner](https://derivative.ca/download)** — the free non-commercial
  edition is fine.
- An MCP-capable AI assistant: **Claude Desktop** (easiest), **Claude Code**,
  **Codex**, or **Cursor**.

Node.js is only needed for the build-from-source path (**[Node 20+](https://nodejs.org)**).
The one-click Claude Desktop extension needs nothing extra — the server is bundled
inside the `.mcpb` (formerly `.dxt`; legacy `.dxt` files still install).

## Get started

You set up **two sides**: your **AI** (so it gets the tdmcp tools) and
**TouchDesigner** (so the AI can drive it).

**🤖 Easiest — let your AI install it.** Using **Claude Code**, **Codex**, or
**Cursor**? Paste this one message in:

```text
Install and connect tdmcp for me using the official install guide:
https://pantani.github.io/tdmcp/guide/install
Do every step yourself; only stop when you need me to paste one line into TouchDesigner.
```

It clones, builds and wires everything up; the only manual step is pasting one
line into TouchDesigner (Step 2 below).

**🟢 Claude Desktop — one-click `.mcpb` (no terminal, no Node).** Download
**[tdmcp.mcpb](https://github.com/Pantani/tdmcp/releases/latest/download/tdmcp.mcpb)**,
then in Claude Desktop open **Settings → Extensions** and install it (drag it in or
**Install from file**). Leave host/port at `127.0.0.1` / `9980`. Full walkthrough:
[the install guide](https://pantani.github.io/tdmcp/guide/install).

**🛠️ Claude Code / Codex / Cursor — build from source.**

```bash
git clone https://github.com/Pantani/tdmcp.git
cd tdmcp
npm run setup   # installs, builds, and prints the exact line to connect your client
```

### Turn on the bridge inside TouchDesigner (everyone)

Open TouchDesigner, open the **Textport** (`Dialogs → Textport and DATs`), paste
this **one line** and press Enter:

```python
import urllib.request; exec(urllib.request.urlopen("https://github.com/Pantani/tdmcp/raw/main/td/bootstrap.py").read().decode())
```

You should see `[tdmcp] bridge running on port 9980 (/project1/tdmcp_bridge)`. ✅
It's safe and reversible — it adds one tidy component; remove it later with
`from mcp import install; install.uninstall()`. Other install methods (module
path, terminal, reusable `.tox`) are in the
[bridge docs](https://pantani.github.io/tdmcp/reference/bridge-api).

### Make something

With TouchDesigner open and your AI connected, ask in plain language:

> *"Create an audio-reactive particle galaxy and show me a preview."*

The AI builds the network, checks it for errors, and returns a thumbnail. Iterate:
*"make it warmer," "add a feedback trail," "output it fullscreen."* More ideas in
the [prompt cookbook](https://pantani.github.io/tdmcp/guide/prompt-cookbook).

> **Not connecting?** The two most common fixes: make sure the bridge is on
> (`curl http://127.0.0.1:9980/api/info` returns JSON), and **restart your AI
> client** after adding the server. Full
> [troubleshooting](https://pantani.github.io/tdmcp/guide/troubleshooting).

## What you can do

**175 tools** across three layers, plus library/packaging and Obsidian vault integrations — from
one-line artist generators (`create_feedback_network`, `create_audio_reactive`,
`create_particle_system`, `create_generative_art`, …) to building blocks
(`create_control_panel`, `animate_parameter`, `create_external_io` for
OSC/MIDI/DMX/NDI, …) down to atomic node CRUD and inspection. Many systems arrive
**already playable**, with a control panel you can tweak, preset, or map to a
controller. See the full, always-current
[tools reference](https://pantani.github.io/tdmcp/reference/tools) and the
[recipe gallery](https://pantani.github.io/tdmcp/guide/recipes).

## Security

The bridge runs **arbitrary Python inside your TD process** and listens on port
`9980` on all interfaces — treat it like an open door to that machine. Run it only
on a trusted network, and for untrusted networks turn on bridge auth
(`TDMCP_BRIDGE_TOKEN`) and/or disable the exec endpoints
(`TDMCP_BRIDGE_ALLOW_EXEC=0`). Details:
[Security](https://pantani.github.io/tdmcp/reference/architecture#security).

## Contributing & development

Build with `npm install && npm run build`; run `npm test`, `npm run typecheck`,
`npm run lint`. Work on the docs with `npm run docs:dev` (the
[tools reference](https://pantani.github.io/tdmcp/reference/tools) is generated by
`scripts/gen-tool-docs.ts`). See [CONTRIBUTING.md](CONTRIBUTING.md),
[CHANGELOG.md](CHANGELOG.md), and the [roadmap](docs/ROADMAP.md).

## License

MIT — see [LICENSE](LICENSE).
