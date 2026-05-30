# tdmcp — install guide for Cline (and other MCP agents)

> **Agent: read this, then do every step yourself.** You are installing **tdmcp**,
> an MCP server that lets an AI build visual systems inside TouchDesigner. The
> **only** action a human must perform is pasting one line into TouchDesigner's
> Textport (Step 4) — the bridge has to run inside TD's own Python, which no shell
> can reach from outside. Do everything around it yourself, hand the user that one
> line, then verify. Every step here is idempotent: detect what already exists and
> skip/update rather than duplicate.

## Prerequisites (check, then remediate or ask)

- **Node.js ≥ 20** on `PATH` — `node -v`. If missing/older, point the user to
  <https://nodejs.org> and stop until it's present.
- **git** on `PATH` — `git --version`.
- **TouchDesigner** installed (free non-commercial edition is fine). You can
  install and wire everything while TD is closed; Steps 4–5 need it **open**.

## Step 1 — Install and build the server

```bash
TDMCP_DIR="$HOME/tdmcp"
if [ -d "$TDMCP_DIR/.git" ]; then
  git -C "$TDMCP_DIR" pull --ff-only
else
  git clone https://github.com/Pantani/tdmcp.git "$TDMCP_DIR"
fi
cd "$TDMCP_DIR"
npm run setup            # installs deps + builds; produces dist/index.js
test -f "$TDMCP_DIR/dist/index.js" && echo "BUILD OK" || echo "BUILD FAILED"
```

Record the **absolute** path printed by `pwd` (call it `<ABS>`); you need it next.
Don't continue until you see `BUILD OK`.

> **No-clone alternative:** tdmcp is published to npm as `@dpantani/tdmcp`, so you
> can skip the clone/build and run it with `npx -y @dpantani/tdmcp` (use the npx
> command form in Step 2 instead of the node path).

## Step 2 — Register tdmcp in Cline's MCP settings

Add a **stdio** server named `tdmcp` to your `cline_mcp_settings.json`, **merging**
into any existing `mcpServers` (don't clobber other servers):

```json
{
  "mcpServers": {
    "tdmcp": {
      "command": "node",
      "args": ["<ABS>/dist/index.js"],
      "disabled": false
    }
  }
}
```

For the npx route, use `"command": "npx"`, `"args": ["-y", "@dpantani/tdmcp"]`
instead. No environment variables are needed for the default local setup.

Cline's settings file is typically at:

- **macOS:** `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
- **Windows:** `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json`
- **Linux:** `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`

(Adjust the `Code` segment for VS Code Insiders / VSCodium / Cursor hosts.)

## Step 3 — Stage the bridge (optional but recommended)

```bash
node <ABS>/dist/index.js install-bridge
# copies the bridge under ~/tdmcp-bridge/modules and prints the exact Textport line
```

## Step 4 — The one human step: turn on the bridge inside TouchDesigner

You cannot do this from the shell. **Present this to the user verbatim and wait:**

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

It is **safe and reversible** — it adds one tidy `tdmcp_bridge` component; remove it
later with `from mcp import install; install.uninstall()`.

## Step 5 — Verify end-to-end

```bash
curl -s http://127.0.0.1:9980/api/info     # expect {"ok":true,"data":{...}}
cd "$TDMCP_DIR" && npm run smoke:live       # creates a Noise→Null chain + preview in /project1
```

Poll `/api/info` every few seconds until it returns `"ok":true` (ground truth that
Step 4 worked). Then **restart Cline** so it loads the server, and ask it to run
`get_td_info` — if it returns TD's version, the loop is closed. Only then report
success.

## Notes

- The tdmcp server runs fine even when **TouchDesigner is closed** — TD-dependent
  tools return a friendly "not reachable" message instead of crashing.
- Full step-by-step runbook with troubleshooting:
  [`tdmcp-install-prompt.md`](tdmcp-install-prompt.md). Docs:
  <https://pantani.github.io/tdmcp/>.
- **Security:** the bridge runs **arbitrary Python inside your TD process** and
  listens on port `9980` on all interfaces. Run it only on a trusted network; for
  untrusted ones set the same `TDMCP_BRIDGE_TOKEN` in both the server's and TD's
  environment, and/or `TDMCP_BRIDGE_ALLOW_EXEC=0` in TD.
