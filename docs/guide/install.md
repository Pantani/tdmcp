# Install (Claude Desktop)

This is the easiest way to use tdmcp: **no terminal, no Node, no setup files.**
The whole tdmcp server is bundled inside one extension file for Claude Desktop.
Three steps, about 3 minutes.

::: tip Using Claude Code, Cursor, or Codex instead?
You don't need to do any of this by hand. Paste this one message into your AI and
it installs everything for you:

```text
Install and connect tdmcp for me by reading and following
https://raw.githubusercontent.com/Pantani/tdmcp/main/tdmcp-install-prompt.md
Do every step yourself; only stop when you need me to paste one line into TouchDesigner.
```
:::

## 1. Download the extension

**[⬇ Download tdmcp.dxt](https://github.com/Pantani/tdmcp/releases/latest/download/tdmcp.dxt)**

A `.dxt` is a single file Claude Desktop installs as an extension. The server is
inside it — nothing else to download.

::: warning If the download link doesn't work
A release may not be published yet. Ask whoever shared tdmcp with you for the
`tdmcp.dxt` file directly, then continue at step 2.
:::

## 2. Install it in Claude Desktop {#install-from-file}

1. Open Claude Desktop → **Settings → Extensions**.
2. Choose **Install from file** (or just **drag `tdmcp.dxt` onto the window**).
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
   import urllib.request; exec(urllib.request.urlopen("https://raw.githubusercontent.com/Pantani/tdmcp/main/td/bootstrap.py").read().decode())
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

## Trouble?

See [Troubleshooting](/guide/troubleshooting) — it covers "TouchDesigner isn't
reachable", download errors, and the macOS microphone permission popup.
