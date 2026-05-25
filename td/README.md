# tdmcp TouchDesigner bridge

This folder contains the TouchDesigner-side bridge: a small Python package that
exposes a REST API (via a **Web Server DAT**) which the `@tdmcp/server` MCP server
talks to.

> A binary `.tox` cannot be generated from source by an AI agent, so the bridge
> ships as Python modules plus a callbacks template. Assembling the `.tox` is a
> one-time, copy-paste install (below). You can then export your own
> `mcp_webserver_base.tox` from TD for reuse.

## Layout

```
td/
├── modules/
│   ├── mcp/
│   │   ├── controllers/api_controller.py   # HTTP router + JSON envelope
│   │   └── services/
│   │       ├── api_service.py               # node CRUD, exec, method, info
│   │       ├── preview_service.py           # TOP → base64 PNG
│   │       ├── batch_service.py             # create/update/delete/connect
│   │       └── analysis_service.py          # errors/topology/performance
│   └── utils/version.py
└── templates/webserver_callbacks.py        # Web Server DAT callbacks
```

## Install (≈2 minutes)

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
# {"ok":true,"data":{"python_version":"3.11.x","td_version":"...","bridge_version":"0.1.0"}}
```

Then run the live smoke test from the repo root:

```bash
npm run smoke:live
```

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
