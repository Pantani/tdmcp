---
title: Codex + TouchDesigner
description: "Connect OpenAI Codex CLI to TouchDesigner with tdmcp — the TouchDesigner MCP server. Build real node networks from plain-language prompts in Codex, with a create → verify → preview loop."
---

# Codex + TouchDesigner

**tdmcp** connects the **Codex CLI** to TouchDesigner over the
[Model Context Protocol](https://modelcontextprotocol.io). Once it's wired up you
describe a visual in plain language inside Codex and it builds the actual network
of operators in your project — then checks it for errors and shows you a preview.

If you also use Claude or Cursor, the setup is the same idea; this page is the
Codex-specific path. For the full picture see [Install](/guide/install).

## What you need

- **[TouchDesigner](https://derivative.ca/download)** — the free non-commercial
  edition is fine.
- **[Node.js 20+](https://nodejs.org)** — Codex runs the tdmcp server as a local
  `node` process over stdio.
- The **Codex CLI** installed and working (`codex --version`).

## Connect tdmcp to Codex

You can register tdmcp from the published npm package (no clone) or from a local
build. Either way Codex launches it as a stdio MCP server.

::: tip Let Codex do it for you
Paste this into Codex and it installs and wires everything itself, stopping only
for the one TouchDesigner line:

```text
Install and connect tdmcp for me using the official install guide:
https://pantani.github.io/tdmcp/guide/install
Do every step yourself; only stop when you need me to do the TouchDesigner bridge step.
```
:::

### Option A — from npm (no clone)

Add tdmcp to `~/.codex/config.toml` (merge into any existing `[mcp_servers.*]`):

```toml
[mcp_servers.tdmcp]
command = "npx"
args = ["--yes", "--package=@dpantani/tdmcp", "tdmcp"]
```

### Option B — from a local build

Clone and build, then point Codex at `dist/index.js`:

```bash
git clone https://github.com/Pantani/tdmcp.git
cd tdmcp
npm run setup   # installs, builds, and prints the exact connect line
```

Then either run `codex mcp add tdmcp -- node <project-path>/dist/index.js`
(`<project-path>` is the cloned folder — run `pwd` inside it), or add it to
`~/.codex/config.toml` by hand:

```toml
[mcp_servers.tdmcp]
command = "node"
args = ["<project-path>/dist/index.js"]
```

**Restart your Codex session** afterwards so it picks up the new server.

## Turn on the bridge in TouchDesigner

tdmcp needs a small bridge running *inside* TouchDesigner. The easiest way is to
drag the release `.tox` in — no Textport
([see Install](/guide/install#drag-in-tox)). Prefer one paste? Open the **Textport**
(**Dialogs → Textport and DATs**), paste this one line, and press Enter:

```python
import urllib.request; exec(urllib.request.urlopen("https://github.com/Pantani/tdmcp/raw/v0.12.0/td/bootstrap.py").read().decode())
```

You should see `[tdmcp] bridge running on port 9980`. This is the only step that
has to happen inside TouchDesigner — see [Install](/guide/install#turn-on-the-bridge)
for the details and how to remove it later.

## Make something

With TouchDesigner open and the bridge on, ask Codex in plain language:

> *"Create an audio-reactive particle galaxy and show me a preview."*

It builds the network, checks it for errors, and returns a thumbnail. Keep going
in plain language — *"make it warmer," "add a feedback trail," "output it
fullscreen."* More ideas are in the [prompt cookbook](/guide/prompt-cookbook), and
[Your first visual](/guide/first-visual) walks through one end to end.

## Not connecting?

- Confirm the bridge is on: `curl http://127.0.0.1:9980/api/info` should return
  JSON.
- **Restart the Codex session** after editing `~/.codex/config.toml` — MCP servers
  are loaded at startup.
- Full [Troubleshooting](/guide/troubleshooting) covers the common cases.

For host/port, environment variables, and the local copilot CLI, see the
[CLI reference](/reference/cli) and [environment variables](/reference/environment).
