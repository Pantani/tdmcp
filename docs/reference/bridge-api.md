---
description: "The tdmcp bridge and REST API — the component inside TouchDesigner that the MCP server drives to create, inspect, connect and preview nodes."
---

# Bridge & REST API

The bridge is the TouchDesigner side of tdmcp: a small Python package that exposes
a REST API behind a **Web Server DAT**, which the server calls over HTTP. It runs
*inside* the TD process — that's what gives it the power to create, connect,
inspect and preview real nodes.

> A binary `.tox` can't be generated from source by an AI agent, so the bridge
> ships as Python modules plus a callbacks template. The one-line installer
> assembles it for you; you can then export your own reusable `.tox`.

## Install it once

All three options create one tidy `tdmcp_bridge` COMP (Web Server DAT +
callbacks), are idempotent, and can be undone with
`from mcp import install; install.uninstall()`.

**A. One paste — no clone, no Preferences.** In the Textport
(`Dialogs → Textport and DATs`):

```python
import urllib.request; exec(urllib.request.urlopen("https://github.com/Pantani/tdmcp/raw/main/td/bootstrap.py").read().decode())
```

Downloads the bridge to `~/tdmcp-bridge/modules` and starts it on port 9980.
(Needs the repo reachable; if it's private, use B or C.)

**B. After adding the module path.** Add the absolute path of `td/modules` to
**Preferences → "Python 64-bit Module Path"**, then in the Textport:

```python
from mcp import install; install.run()
```

**C. From the terminal.** `npx @dpantani/tdmcp install-bridge` (or
`node dist/index.js install-bridge` from a clone) copies the bridge to
`~/tdmcp-bridge` and prints exactly what to paste.

You should see `[tdmcp] bridge running on port 9980 (/project1/tdmcp_bridge)`.
Verify from a terminal:

```bash
curl http://127.0.0.1:9980/api/info
# {"ok":true,"data":{"python_version":"3.11.x","td_version":"...","bridge_version":"..."}}
```

### Make a reusable `.tox`

```python
from mcp import install
install.export("/path/to/mcp_webserver_base.tox", modules_dir="/abs/path/to/td/modules")
```

Pass `modules_dir` so the import path travels inside the `.tox`; from then on the
install is just dragging the component in.

### Keep it on across restarts

Save your project as your **Default Project**, or use the self-installing
`td/startup.py` in an Execute DAT (toggle **Start** and **Create** on). `install()`
is idempotent, so it's safe to leave in place permanently. Full manual
(Web-Server-DAT-by-hand) steps are in the
[TouchDesigner bridge folder](https://github.com/Pantani/tdmcp/tree/main/td).

## Endpoints

All responses use the envelope `{ "ok": true, "data": … }` or
`{ "ok": false, "error": { "message": … } }`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/info` | TD/Python/bridge versions |
| POST | `/api/nodes` | create node `{parent_path,type,name?,parameters?}` |
| GET | `/api/nodes?parent=…` | list children |
| GET | `/api/nodes/{path}` | node detail (path is percent-encoded) |
| PATCH | `/api/nodes/{path}` | update `{parameters}` |
| DELETE | `/api/nodes/{path}` | delete node |
| POST | `/api/exec` | run Python `{script,return_output?}` |
| POST | `/api/nodes/{path}/method` | call `{method,args?,kwargs?}` |
| GET | `/api/nodes/{path}/errors` | node errors |
| GET | `/api/preview/{path}` | TOP as base64 PNG |
| POST | `/api/batch` | `{operations:[…]}` (create/update/delete/connect) |
| GET | `/api/network/{path}/errors` | recursive errors |
| GET | `/api/network/{path}/topology` | nodes + connections |
| GET | `/api/network/{path}/performance` | cook times |
| POST | `/api/connect` | connect `{source_path,target_path,source_output?,target_input?}` (index-aware) |
| POST | `/api/disconnect` | disconnect `{to_path,from_path?,to_input?}` (by target, optionally by source/input) |
| GET | `/api/nodes/{path}/params?modes=true` | parameter values **+ modes** (`keys?`, `non_default_only?`) |
| PATCH | `/api/nodes/{path}/params/{param}/mode` | set a parameter's mode `{mode,expr?,value?}` (constant/expression/bind) |
| GET | `/api/nodes/{path}/text` | read a DAT's text |
| PUT | `/api/nodes/{path}/text` | replace a DAT's text `{text}` |
| GET | `/api/logs` | recent bridge/cook errors from the in-bridge Error DAT (`severity?`, `max_lines?`, `scope?`) |

The `/api/exec` and node-`method` endpoints can be disabled bridge-side with
`TDMCP_BRIDGE_ALLOW_EXEC=0`, and the whole API can require a bearer token via
`TDMCP_BRIDGE_TOKEN` — see [Security](/reference/architecture#security). The
structured endpoints added in 0.6.0 — `/api/connect`, `/api/disconnect`,
`/api/logs`, the `?modes=true` parameter reads, `…/params/{param}/mode` and the
DAT `…/text` reads/writes — are **not** behind the exec gate, so they keep
working with `TDMCP_BRIDGE_ALLOW_EXEC=0`.

## Developing the bridge

TouchDesigner imports the bridge modules once at project open, so editing files
under `td/` does **not** update a running bridge. Reload without reopening:

```python
from mcp import dev
dev.reload_bridge()   # reimports every mcp.* / utils.* module; returns the names reloaded
```

For the local dev loop, `tdmcp-agent watch-build` watches `src/` and `td/`.
When a saved change touches `td/`, it waits for typecheck/build to pass, runs
`python -m py_compile` over the changed Python files, then calls the
`reload_bridge` tool automatically. Use `--no-reload-bridge` for a build-only
watcher, or `--no-py-compile` when you need to skip the Python syntax gate.

Bump `BRIDGE_VERSION` in `td/modules/utils/version.py` on every bridge change.
`get_td_info` reports the *running* bridge's version, so when it lags the repo you
know the running bridge is stale and should be reloaded.

### Notes / known limitations

- Operator types are resolved with a regex-guarded `eval` of the type name; only
  `[A-Za-z][A-Za-z0-9_]*` is accepted.
- `preview` returns the TOP at its native resolution; the requested width/height
  are advisory.
- WebSocket event streaming is stubbed in the callbacks and forwarded as MCP
  logging notifications by the server.
