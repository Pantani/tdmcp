<!-- MAINTAINER NOTE: the download link below points at a GitHub *release* asset
     (releases/latest/download/tdmcp.dxt). As of writing, no release is published
     and tdmcp.dxt is gitignored, so the link 404s. To make this guide work:
       1. npm run build:dxt        (creates tdmcp.dxt in the repo root)
       2. Publish a GitHub release and upload tdmcp.dxt as an asset.
     Until then, hand a non-technical user the tdmcp.dxt file directly. -->

# tdmcp on Claude Desktop — the no-terminal quick start

Build visuals in TouchDesigner by chatting with Claude. **No terminal, no Node,
no setup files** — the whole tdmcp server is bundled inside one extension file.
Three steps, about 3 minutes.

> You only need this if you use **Claude Desktop**. Using Claude Code, Cursor, or
> Codex instead? See [`tdmcp-install-prompt.md`](tdmcp-install-prompt.md) — hand
> that to your AI and it installs everything for you.

---

### 1. Download the extension

**[⬇ Download tdmcp.dxt](https://github.com/Pantani/tdmcp/releases/latest/download/tdmcp.dxt)**

A `.dxt` is a single file Claude Desktop installs as an extension. The server is
inside it — nothing else to download.

### 2. Install it in Claude Desktop

1. Open Claude Desktop → **Settings → Extensions**.
2. Choose **Install from file** (or just **drag `tdmcp.dxt` onto the window**).
3. If it asks for settings, leave **TouchDesigner host** = `127.0.0.1` and
   **TouchDesigner port** = `9980` (the defaults are right when TouchDesigner runs
   on the same computer).
4. **Enable** the “TouchDesigner (tdmcp)” extension.

### 3. Turn on the bridge inside TouchDesigner

This lets Claude actually drive TouchDesigner. Do it once:

1. **Open TouchDesigner.**
2. Open the **Textport**: menu **Dialogs → Textport and DATs**.
3. Paste this **one line** and press **Enter**:

   ```python
   import urllib.request; exec(urllib.request.urlopen("https://raw.githubusercontent.com/Pantani/tdmcp/main/td/bootstrap.py").read().decode())
   ```

You should see: `[tdmcp] bridge running on port 9980 (/project1/tdmcp_bridge)` ✅

It's safe and reversible — it adds one tidy `tdmcp_bridge` component. To remove it
later, paste `from mcp import install; install.uninstall()`.

---

### You're done — make something

With TouchDesigner open and the bridge on, ask Claude in plain language:

> *"Create a feedback tunnel from noise with blur and displace, add bloom, and
> show me a preview."*

Then iterate: *"make it warmer,"* *"add a feedback trail,"* *"output it
fullscreen."*

---

### If something's off

| What you see | Fix |
| --- | --- |
| Claude says **"TouchDesigner isn't reachable."** | Make sure TouchDesigner is open and you did step 3 (and saw the `bridge running` message). |
| The download link doesn't work | The release may not be published yet — ask whoever shared this for the `tdmcp.dxt` file, then start at step 2. |
| Textport shows a download error | Your network can't reach GitHub. Connect to the internet and paste the line again. |

> **One safety note:** the bridge lets Claude run code inside TouchDesigner and
> listens on port 9980. Only use it on a network you trust (e.g. your own
> computer), not on public Wi-Fi without a firewall.
