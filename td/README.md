# tdmcp TouchDesigner bridge

This folder contains the TouchDesigner-side bridge: a small Python package that
exposes a REST API (via a **Web Server DAT**) which the `tdmcp` MCP server
talks to.

> A binary `.tox` cannot be generated from source by an AI agent, so the bridge
> ships as Python modules plus a callbacks template. Assembling the `.tox` is a
> one-time, copy-paste install (below). You can then export your own
> `mcp_webserver_base.tox` from TD for reuse.

## Easiest install

You only need the bridge running inside TouchDesigner once. Pick whichever fits —
all three create one tidy `tdmcp_bridge` COMP (Web Server DAT + callbacks), are
idempotent, and can be undone with `from mcp import install; install.uninstall()`.

**A. One paste — no clone, no Preferences.** In the Textport
(`Dialogs → Textport and DATs`):

```python
import urllib.request; exec(urllib.request.urlopen("https://github.com/Pantani/tdmcp/raw/main/td/bootstrap.py").read().decode())
```

It downloads the bridge to `~/tdmcp-bridge/modules` and starts it on port 9980.
(Needs the repo reachable; if it is private, use B or C.)

**B. One line — after adding the module path.** Add the absolute path of
`td/modules` to **Preferences → "Python 64-bit Module Path"**, then in the
Textport:

```python
from mcp import install; install.run()
```

**C. From the terminal.** `npx @dpantani/tdmcp install-bridge` (or
`node dist/index.js install-bridge` from a clone) copies the bridge to
`~/tdmcp-bridge` and prints exactly what to paste in the Textport.

### Make a reusable .tox (drag-and-drop)

Run this once in your own TouchDesigner to bake a component you can drag into any
project:

```python
from mcp import install
install.export("/path/to/mcp_webserver_base.tox", modules_dir="/abs/path/to/td/modules")
```

Commit that `.tox`; from then on the bridge install is just dragging it in. Pass
`modules_dir` so the import path travels inside the `.tox`; otherwise the target
machine still needs `td/modules` on its Preferences module path.

## Layout

```
td/
├── modules/
│   ├── mcp/
│   │   ├── controllers/api_controller.py   # HTTP router + JSON envelope
│   │   ├── dev.py                          # reload_bridge(): hot-reload modules in a running TD
│   │   └── services/
│   │       ├── api_service.py               # node CRUD, exec, method, info
│   │       ├── preview_service.py           # TOP → base64 PNG
│   │       ├── batch_service.py             # create/update/delete/connect
│   │       └── analysis_service.py          # errors/topology/performance
│   └── utils/version.py
└── templates/webserver_callbacks.py        # Web Server DAT callbacks
```

## Developing the bridge

TouchDesigner imports the bridge modules once at project open, so editing files under
`td/` does **not** update a running bridge — it keeps serving the code it loaded. After
editing, reload without reopening the project:

```python
from mcp import dev
dev.reload_bridge()   # reimports every mcp.* / utils.* module; returns the names reloaded
```

Bump `BRIDGE_VERSION` in `modules/utils/version.py` on every bridge change. `get_td_info`
reports the *running* bridge's version, so when it lags the repo you know the running
bridge is stale and should be reloaded (or the project reopened).

## Manual install (Web Server DAT, ≈2 minutes)

Prefer to wire it by hand, or can't run the options above? Do it manually:

1. Copy the `td/modules` folder into your project folder, e.g.
   `<yourproject>/tdmcp/modules` (so you have `<yourproject>/tdmcp/modules/mcp/...`).
2. In TouchDesigner, add a **Web Server DAT**.
   - Set **Port** to `9980` (must match `TDMCP_TD_PORT`).
   - Set **Active** to On.
3. Point the Web Server DAT's **Callbacks DAT** at a Text DAT containing the
   contents of `td/templates/webserver_callbacks.py`. If you copied the modules
   somewhere other than `<project>/tdmcp/modules`, edit the `_MODULES` path at
   the top of that file.
4. Save the project. The bridge is now listening.

Verify from a terminal:

```bash
curl http://127.0.0.1:9980/api/info
# {"ok":true,"data":{"python_version":"3.11.x","td_version":"...","bridge_version":"0.3.0"}}
```

Then run the live smoke test from the repo root:

```bash
npm run smoke:live
```

## Global auto-install (recommended)

Instead of wiring a Web Server DAT per project, use the self-installing
`td/startup.py` so the bridge comes up automatically in any project:

1. Add the absolute path of `td/modules` to **Preferences → "Python 64-bit
   Module Path"** so `import mcp...` works everywhere. Then leave
   `MODULES_DIR = ""` in `startup.py`; otherwise set it to that absolute path.
2. Add an **Execute DAT** and paste the contents of `td/startup.py` into it.
3. Turn ON the Execute DAT's **Start** and **Create** toggles. It creates and
   configures `tdmcp_webserver` (port 9980) plus its callbacks on project open.
4. To apply it to every *new* project, save this project as your **Default
   Project** (Preferences) with that Execute DAT included.

`install()` is idempotent — re-running just reconfigures the existing ops, so
it is safe to leave the Execute DAT in place permanently.

## Endpoints

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

All responses use the envelope `{ "ok": true, "data": … }` or
`{ "ok": false, "error": { "message": … } }`.

## Notes / known limitations

- Operator types are resolved with a regex-guarded `eval` of the type name (TD
  exposes operator classes globally). Only `[A-Za-z][A-Za-z0-9_]*` is accepted.
- `preview` returns the TOP at its native resolution; the requested width/height
  are advisory in this version.
- WebSocket event streaming (errors/cook/preview) is stubbed in the callbacks and
  not yet consumed by the server.
