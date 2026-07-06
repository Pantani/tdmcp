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
Do every step yourself; only stop when you need me to do the TouchDesigner bridge step.
```
:::

## 1. Download the extension

**[⬇ Download tdmcp.mcpb](https://github.com/Pantani/tdmcp/releases/latest/download/tdmcp.mcpb)**

An `.mcpb` (MCP Bundle) is a single file Claude Desktop installs as an extension.
The server is inside it — nothing else to download.

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

This is what lets Claude actually drive TouchDesigner. The easiest way needs **no
Textport and no terminal** — just drag a file in. Prefer a one-paste command, or
open lots of projects? The two alternatives below still work.

### Easiest — drag in the release `.tox` {#drag-in-tox}

1. **[⬇ Download tdmcp_bridge_package.tox](https://github.com/Pantani/tdmcp/releases/latest/download/tdmcp_bridge_package.tox)**
   from the latest release.
2. **Open TouchDesigner**, then drag the `.tox` from Finder/Explorer into your
   `/project1` network.
3. Click **Install** on the `tdmcp_bridge_package` component.

That's it — no Textport, no Preferences, no clone. The package is self-bootstrapping:
on the first **Install** it downloads `td/modules` from the matching release zip
into `~/tdmcp-bridge` and starts the bridge on port 9980. You should see the
`tdmcp_bridge` component appear in `/project1`. Its **Uninstall** button removes
only that runtime bridge.

::: warning If the release has no `.tox`
Older releases may not ship the file yet. Use the one-paste runtime bridge below
instead, then continue.
:::

### Quick runtime bridge

1. **Open TouchDesigner.**
2. Open the **Textport**: menu **Dialogs → Textport and DATs**.
3. Paste this **one line** and press **Enter**:

   ```python
   import urllib.request; exec(urllib.request.urlopen("https://github.com/Pantani/tdmcp/raw/v0.12.0/td/bootstrap.py").read().decode())
   ```

You should see:

```
[tdmcp] bridge running on port 9980 (/project1/tdmcp_bridge)
```

It is safe and reversible. To remove it later, paste
`from mcp import install; install.uninstall()`.

### Draggable Palette package

This installs `tdmcp_bridge_package` into TouchDesigner's Palette so each new
project is just drag, click **Install**, and start working.

1. In a terminal, run:

   ```bash
   npx --yes --package=@dpantani/tdmcp tdmcp install-bridge --palette
   ```

   Working from a clone? Use:

   ```bash
   node dist/index.js install-bridge --palette
   ```

2. Copy the Palette package Textport command it prints.
3. In TouchDesigner, open **Dialogs → Textport and DATs**, paste the command,
   and press **Enter**.
4. Open the Palette browser, find **tdmcp → tdmcp_bridge_package**, and drag it
   into `/project1`.
5. Click **Install** on the component.

Packages generated without a **Modules Dir** can self-bootstrap: they download
the zip in **Repo Zip**, extract only `td/modules` into **Bootstrap Dest**
(default `~/tdmcp-bridge`), and start from that local cache. This is the shape
used for release-ready `.tox` packages.

Verify from a terminal:

```bash
curl http://127.0.0.1:9980/api/info
```

The Palette package stays in your project; its **Uninstall** button removes only
`/project1/tdmcp_bridge`.

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
and wires everything itself, stopping only for the TouchDesigner step in
[step 3](#turn-on-the-bridge).
:::

Or wire it by hand:

```bash
git clone https://github.com/Pantani/tdmcp.git
cd tdmcp
npm run setup   # installs, builds, and prints the exact line to connect your client
```

::: tip One command end-to-end — `tdmcp init`
After the build, **`tdmcp init --yes`** runs the whole onboarding in one shot:
it stages the TD bridge, deep-merges a client config for Claude / Cursor /
Codex (auto-detected), seeds a default profile, and (optionally) generates a
`TDMCP_BRIDGE_TOKEN`. Add `--dry-run` to see the plan first, or `--json` for a
machine-readable envelope. The per-client manual steps below still work for
advanced setups. See [CLI · Onboarding](/reference/cli#onboarding).
:::

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
