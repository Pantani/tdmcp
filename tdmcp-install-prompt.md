# tdmcp — AI install & connect runbook

> **What this file is.** Hand this whole file to an AI coding agent (Claude Code,
> Codex CLI, Cursor, or any MCP-capable assistant with shell access). The agent
> reads it and **installs the tdmcp server, wires it into your AI client, and
> connects it to TouchDesigner** — doing every shell and config step itself.
>
> **What you (the human) do:** essentially nothing, except **one copy-paste line
> into TouchDesigner's Textport** at Step 5. That single step is unavoidable —
> the bridge has to run *inside* TouchDesigner's own Python, which no terminal can
> reach from outside. The agent prepares it, hands you the exact line, then
> verifies it worked.
>
> **Paste-to-agent starter (optional):** *"Read tdmcp-install-prompt.md and follow
> it to install and connect tdmcp. Do every step you can yourself; only stop to ask
> me when the file says a human action is required."*

---

## AGENT — read this first

You are installing **tdmcp** (an MCP server that lets an AI build visual systems
in TouchDesigner) and connecting it to the user's AI client and to a running
TouchDesigner.

**Operating rules:**

1. **Execute, don't narrate.** Actually run the commands and write the config
   files. Don't just print instructions for the user to run.
2. **Be idempotent.** Every step here is safe to re-run. If something already
   exists (a clone, a built `dist/`, an MCP entry), detect it and skip or update
   rather than duplicating.
3. **One human step only.** Step 5 (turning the bridge on inside TouchDesigner)
   requires a human paste into TD. Do everything *around* it yourself, present the
   exact line, then poll until it's live. Nothing else should require the user.
4. **Verify before claiming success.** Each phase has a check. Don't report
   "done" until Step 6's end-to-end check passes.
5. **Stop and ask** only when truly blocked: Node missing and you can't install
   it, the AI client is ambiguous and undetectable, or TD isn't installed.

**Prerequisites you must confirm exist (check, then remediate or ask):**

- **TouchDesigner** installed and **open** (free non-commercial edition is fine).
  You can proceed with install/wiring while it's closed, but Step 5–6 need it
  running.
- **Node.js ≥ 20** on `PATH`. Check with `node -v`. If missing/older, point the
  user to <https://nodejs.org> (or `brew install node` on macOS, `winget install
  OpenJS.NodeJS` on Windows) and stop until it's there.
- **git** on `PATH` (for the clone). `git --version`.

---

## Step 1 — Detect the environment

Run these and record the answers; later steps branch on them.

```bash
node -v            # must be v20+ ; if not, remediate (see prerequisites) and stop
git --version      # need git for the clone
uname -s 2>/dev/null || echo Windows   # macOS=Darwin, Linux=Linux, else Windows
```

**Detect which AI client to wire up** (you'll need this at Step 4). Check, in order:

- `claude --version` succeeds → **Claude Code** is available (you can run
  `claude mcp add …` directly).
- A Claude Desktop config path exists:
  - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
  - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- A Codex config dir exists: `~/.codex/` → **Codex CLI**
  (`~/.codex/config.toml`).
- A `.cursor/` folder in the user's workspace, or Cursor installed → **Cursor**.

If exactly one is present, wire that one. If several, wire the one you yourself
are running inside (you know which client you are). If you genuinely can't tell,
**ask the user** which client they use, then continue.

---

## Step 2 — Get the tdmcp server source

> tdmcp is published to npm as `@dpantani/tdmcp`, so the whole "clone and
> build" step below collapses to
> `npx --yes --package=@dpantani/tdmcp tdmcp`. The clone route stays here for
> contributors and for running from a local checkout.

Pick a stable location and clone there (skip the clone if it already exists):

```bash
# Choose an install dir. Default: ~/tdmcp
TDMCP_DIR="$HOME/tdmcp"

if [ -d "$TDMCP_DIR/.git" ]; then
  echo "Existing clone found — updating."
  git -C "$TDMCP_DIR" pull --ff-only
else
  git clone https://github.com/Pantani/tdmcp.git "$TDMCP_DIR"
fi
cd "$TDMCP_DIR"
pwd   # <-- record this absolute path; you need it in Steps 4 and 5
```

> If you (the agent) were handed this file from *inside* an already-cloned tdmcp
> repo, just use that checkout — run `pwd` at its root and skip the clone.

---

## Step 3 — Install dependencies and build

From the repo root:

```bash
npm install
npm run build
```

This produces `dist/index.js` (the server entry point) and `dist/cli/agent.js`.

**Check:** confirm the entry exists.

```bash
test -f "$TDMCP_DIR/dist/index.js" && echo "BUILD OK" || echo "BUILD FAILED"
```

If it failed, read the build error above, fix it (usually a Node-version or
network issue), and re-run `npm run build`. Don't continue until you see
`BUILD OK`.

> Shortcut equivalent: `npm run setup` (or `./setup.sh`) does install + build and
> then prints the connect lines with the real path baked in. Either path is fine.

---

## Step 4 — Wire tdmcp into the AI client

Use the **absolute** `dist/index.js` path from Step 2/3 everywhere below. Call it
`<ABS>/dist/index.js`. **Only do the block for the client you detected in Step 1.**

### Claude Code

```bash
claude mcp add tdmcp -- node <ABS>/dist/index.js
```

Verify it registered:

```bash
claude mcp list   # tdmcp should appear
```

### Claude Desktop

Edit the config file (create it if absent), merging — **don't clobber** existing
`mcpServers`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "tdmcp": {
      "command": "node",
      "args": ["<ABS>/dist/index.js"]
    }
  }
}
```

Then tell the user: **fully quit and reopen Claude Desktop** so it loads the
server (tools won't appear until restart).

> Easiest no-JSON alternative for Claude Desktop: build the one-click extension
> with `npm run build:mcpb` (writes `tdmcp.mcpb` in the repo root), then have the
> user drag `tdmcp.mcpb` into **Settings → Extensions → Install from file** and set
> host `127.0.0.1` / port `9980`. (Dragging the file is a GUI action only the user
> can do; offer this only if they prefer it over the JSON edit you can do yourself.)

### Codex CLI

Add to `~/.codex/config.toml` (merge into any existing `[mcp_servers.*]`):

```toml
[mcp_servers.tdmcp]
command = "node"
args = ["<ABS>/dist/index.js"]
```

Then restart the Codex session so it picks up the server.

### Cursor

Create/merge `.cursor/mcp.json` in the user's workspace (or `~/.cursor/mcp.json`
for global):

```json
{
  "mcpServers": {
    "tdmcp": {
      "command": "node",
      "args": ["<ABS>/dist/index.js"]
    }
  }
}
```

Restart Cursor so it loads the server.

### Any other MCP client

Register a **stdio** server: command `node`, single arg the absolute path to
`dist/index.js`. No env vars are needed for the default local setup.

---

## Step 5 — Turn on the bridge inside TouchDesigner  ⟵ THE ONE HUMAN STEP

The bridge is a small piece that runs *inside* TouchDesigner so the server can
actually drive it. It must be started from within TD — you (the agent) cannot do
this from the shell. Prepare it, then hand the user the single line.

**Agent:** stage the bridge so the line is guaranteed to work, and print the
security note:

```bash
node <ABS>/dist/index.js install-bridge
# copies the bridge to ~/tdmcp-bridge/modules and prints the exact Textport line
```

**Then present this to the user verbatim** and wait:

> **Do this once, inside TouchDesigner:**
> 1. Make sure TouchDesigner is **open**.
> 2. Open the **Textport**: menu **Dialogs → Textport and DATs**.
> 3. Paste this **one line** and press Enter:
>
> ```python
> import urllib.request; exec(urllib.request.urlopen("https://github.com/Pantani/tdmcp/raw/main/td/bootstrap.py").read().decode())
> ```
>
> You should see: `[tdmcp] bridge running on port 9980 (/project1/tdmcp_bridge)`

That one-paste line downloads the bridge and starts it — no Preferences, no clone
needed. (It needs the GitHub repo reachable. If the repo is private or offline,
use the staged copy instead: in the Textport paste
`import sys; sys.path.insert(0, "<HOME>/tdmcp-bridge/modules")` then
`from mcp import install; install.run(modules_dir="<HOME>/tdmcp-bridge/modules")`.)

It is **safe and reversible** — it adds one tidy `tdmcp_bridge` component. To
remove it later: `from mcp import install; install.uninstall()`.

> **Want to never do this step again?** After it's running, the user can save the
> project (with that bridge) as their **Default Project**, or add `td/startup.py`
> to an Execute DAT — then the bridge auto-starts in every project. See
> `td/README.md`. Mention this; don't block on it.

---

## Step 6 — Verify end-to-end

**6a. Bridge reachable** — poll until the user has pasted the line. This is the
ground truth that Step 5 worked:

```bash
curl -s http://127.0.0.1:9980/api/info
# Expect JSON like: {"ok":true,"data":{"python_version":"3.11.x","td_version":"...","bridge_version":"0.3.0"}}
```

Retry every few seconds until it returns JSON (or the user says they pasted it and
you still get nothing → jump to Troubleshooting). Don't proceed until this returns
`"ok":true`.

**6b. Full round-trip** (creates a Noise→Null chain in `/project1` and grabs a
preview, proving the whole pipe works):

```bash
cd "$TDMCP_DIR" && npm run smoke:live
```

**6c. Client sees the tools.** Remind the user to **restart their AI client** if
they haven't (Claude Desktop / Cursor / Codex need a restart to load the server;
Claude Code picks it up on the next session). After restart, the client should
list tdmcp tools like `create_visual_system`, `get_preview`, `get_td_info`.

**Only now report success.** A good final confirmation is to ask the connected
client to run `get_td_info` — if it returns TD's version, the loop is closed.

---

## Step 7 — First creation (hand back to the user)

Tell the user they're ready, and suggest a first prompt to try in their AI client
(TouchDesigner open, bridge on):

> *"Create a feedback tunnel from noise with blur and displace, add bloom, and
> show me a preview."*

The AI will build the network in `/project1`, check it for errors, and return a
thumbnail. From there: *"make it warmer,"* *"add a feedback trail,"* *"output it
fullscreen."*

---

## Troubleshooting (agent self-serve)

| Symptom | Cause & fix |
| --- | --- |
| `curl …:9980/api/info` hangs or refuses | Bridge not on. Confirm TD is open and the user pasted the Step 5 line and saw the `bridge running` message. Re-paste if needed. |
| Textport: `No module named 'mcp'` | The one-paste bootstrap couldn't fetch (private/offline repo). Use the staged copy form from Step 5 (`sys.path.insert` + `install.run(modules_dir=…)`), or run `node <ABS>/dist/index.js install-bridge` and follow its printed Preferences-path option. |
| `command not found: node` / `npm` | Node not installed or < 20. Install Node ≥ 20 (<https://nodejs.org>), reopen the terminal, restart from Step 1. |
| `git: command not found` | Install git, or download the repo zip from GitHub and unzip it, then resume at Step 3. |
| Build fails | Read the error. Usually old Node (need ≥ 20) or a flaky `npm install` — re-run `npm install && npm run build`. |
| Client lists no tdmcp tools | The client wasn't restarted, or the path in its config isn't the **absolute** `dist/index.js`. Fix the path, restart the client. |
| Port 9980 already in use | Start the bridge on another port: in the Textport `from mcp import install; install.run(port=9981)`, and set `TDMCP_TD_PORT=9981` in the MCP server's environment (add it to the client's server config `env`). |
| `smoke:live` fails but `/api/info` works | TD is reachable but a tool errored — capture the message and inspect with `get_td_node_errors`; often a TD-version operator-name mismatch. |

The tdmcp server runs fine even when TouchDesigner is closed — TD-dependent tools
just return a friendly "not reachable" message instead of crashing.

---

## Security note (state this to the user)

The TouchDesigner bridge runs **arbitrary Python inside your TD process**, and its
Web Server DAT listens on port `9980` on **all network interfaces**. Anyone who
can reach `http://<your-ip>:9980` can run code on that machine. Only run it on a
trusted network and/or firewall port 9980 to localhost. For untrusted networks,
set the same `TDMCP_BRIDGE_TOKEN` secret in both the MCP server's environment and
TouchDesigner's environment to require bearer-token auth on the bridge.
