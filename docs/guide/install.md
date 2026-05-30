---
description: "Install tdmcp, the TouchDesigner MCP server, in Claude Desktop in about 3 minutes — no terminal, no Node. One-click .mcpb extension, then flip on the bridge."
---

# Claude — Desktop & Code

**The easiest way is Claude Desktop** — no terminal, no Node, no setup files. The
whole tdmcp server is bundled inside one extension file. Three steps, about 3
minutes. Using **Claude Code or Cursor**? See [the section below](#other-clients).
Prefer **Codex**, or a **free local model with no API**? See
[Codex](/guide/codex) or [Local copilot](/guide/local-copilot).

::: tip Using Claude Code, Cursor, or Codex instead?
You don't need to do any of this by hand. Paste this one message into your AI and
it installs everything for you:

```text
Install and connect tdmcp for me using the official install guide:
https://pantani.github.io/tdmcp/guide/install
Do every step yourself; only stop when you need me to paste one line into TouchDesigner.
```
:::

## 1. Download the extension

**[⬇ Download tdmcp.mcpb](https://github.com/Pantani/tdmcp/releases/latest/download/tdmcp.mcpb)**

An `.mcpb` (MCP Bundle) is a single file Claude Desktop installs as an extension.
The server is inside it — nothing else to download. (`.mcpb` is the current format;
it was previously called `.dxt`, and any older `.dxt` you may already have still
installs.)

::: warning If the download link doesn't work
A release may not be published yet. Ask whoever shared tdmcp with you for the
`tdmcp.mcpb` file directly, then continue at step 2.
:::

## 2. Install it in Claude Desktop {#install-from-file}

1. Open Claude Desktop → **Settings → Extensions**.
2. Choose **Install from file** (or just **drag `tdmcp.mcpb` onto the window**).
3. If it asks for settings, leave **TouchDesigner host** = `127.0.0.1` and
   **TouchDesigner port** = `9980`. (The defaults are right when TouchDesigner
   runs on the same computer.)
4. **Enable** the "TouchDesigner (tdmcp)" extension.

## 3. Turn on the bridge inside TouchDesigner {#turn-on-the-bridge}

This is what lets Claude actually drive TouchDesigner. You only do it once.

1. **Open TouchDesigner.**
2. Open the **Textport**: menu **Dialogs → Textport and DATs**.
3. Paste this **one line** and press **Enter**:

   ```python
   import urllib.request; exec(urllib.request.urlopen("https://github.com/Pantani/tdmcp/raw/main/td/bootstrap.py").read().decode())
   ```

You should see:

```
[tdmcp] bridge running on port 9980 (/project1/tdmcp_bridge)
```

That's it. ✅ It's safe and reversible — it adds one tidy `tdmcp_bridge`
component. To remove it later, paste
`from mcp import install; install.uninstall()`.

## You're connected

With TouchDesigner open and the bridge on, you're ready to
[make your first visual](/guide/first-visual).

::: warning One safety note
The bridge lets Claude run code inside TouchDesigner and listens on port 9980.
Only use it on a network you trust (like your own computer), not on public Wi-Fi
without a firewall. Developers can lock it down further — see
[Security](/reference/architecture#security).
:::

## Claude Code, Cursor & other MCP clients {#other-clients}

Claude Desktop (above) is the no-terminal route. For **Claude Code** or **Cursor**,
connect tdmcp from source — you'll need **[Node.js 20+](https://nodejs.org)**.
(**Codex** has its own walkthrough on the [Codex page](/guide/codex); the same
source build also powers the [local copilot](/guide/local-copilot).)

::: tip Easiest — let your AI do it
Paste the one-liner from the top of this page into your client; it clones, builds
and wires everything itself, stopping only for the bridge line in
[step 3](#turn-on-the-bridge).
:::

Or wire it by hand:

```bash
git clone https://github.com/Pantani/tdmcp.git
cd tdmcp
npm run setup   # installs, builds, and prints the exact line to connect your client
```

`npm run setup` prints a ready-to-paste command with your real paths filled in.
The manual equivalents (`<project-path>` is the cloned folder — run `pwd` inside it):

- **Claude Code** — `claude mcp add tdmcp -- node <project-path>/dist/index.js`
- **Codex CLI** — `codex mcp add tdmcp -- node <project-path>/dist/index.js`, or add
  this to `~/.codex/config.toml`:

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

Restart your client so it loads the server, then turn on the bridge —
[step 3 above](#turn-on-the-bridge). It's the same one line for every client.

## Trouble?

See [Troubleshooting](/guide/troubleshooting) — it covers "TouchDesigner isn't
reachable", download errors, and the macOS microphone permission popup.
