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

There are two reusable TouchDesigner objects in this flow:

| Object | Path / artifact | Purpose |
| --- | --- | --- |
| Runtime bridge | `/project1/tdmcp_bridge` | The actual Web Server DAT bridge that exposes `/api/info` and the REST API. |
| Palette package | `tdmcp/tdmcp_bridge_package.tox` | A draggable Palette component with **Install**, **Reinstall**, **Uninstall**, and **Status** controls for the runtime bridge. |

For repeat use across projects, stage the modules and export the Palette package:

```bash
npx --yes --package=@dpantani/tdmcp tdmcp install-bridge --palette
# or, from a clone after build:
node dist/index.js install-bridge --palette
```

The CLI prints the exact Textport command with your staged module path. Paste the
Palette package command in TouchDesigner, then drag **tdmcp →
tdmcp_bridge_package** from the Palette into a project and click **Install**.
`/api/info` responds only after that package button has created the runtime
bridge. Advanced exports can use `--palette-dir <path>` and
`--package-name <name>`.

**A. One paste — no clone, no Preferences.** In the Textport
(`Dialogs → Textport and DATs`):

```python
import urllib.request; exec(urllib.request.urlopen("https://github.com/Pantani/tdmcp/raw/v0.13.1/td/bootstrap.py").read().decode())
```

Downloads the bridge to `~/tdmcp-bridge/modules` and starts it on port 9980.
(Needs the repo reachable; if it's private, use B or C.)

**B. After adding the module path.** Add the absolute path of `td/modules` to
**Preferences → "Python 64-bit Module Path"**, then in the Textport:

```python
from mcp import install; install.run()
```

**C. From the terminal.** `npx --yes --package=@dpantani/tdmcp tdmcp install-bridge` (or
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
`{ "ok": false, "error": { "code": …, "message": … } }`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/info` | TD/Python/bridge versions |
| POST | `/api/nodes` | create node `{parent_path,type,name?,parameters?,placement?,node_x?,node_y?,viewer?}` |
| GET | `/api/nodes?parent=…` | list children |
| GET | `/api/nodes/search` | bounded compact descendant search with depth, name/path/type/family, result, node-scan and time limits |
| GET | `/api/nodes/{path}` | node detail (path is percent-encoded) |
| PATCH | `/api/nodes/{path}` | update `{parameters}` |
| DELETE | `/api/nodes/{path}` | apply a broker-authorized delete/bypass, explicit bypass, or explicit YOLO delete; otherwise Keep |
| PATCH | `/api/nodes/{path}/metadata` | atomic rename/move/position/color/comment/writable-flag edit with readback and rollback |
| PATCH | `/api/nodes/{path}/annotation` | edit an Annotate COMP's title/body/RGBA/bounds with per-field readback, redacted text receipts and full snapshot rollback |
| GET | `/api/nodes/{path}/params/{param}/menu` | bounded menu names, labels and current value for read-only failure recovery |
| POST | `/api/nodes/{path}/params/{param}/pulse` | validate Pulse style and invoke `.pulse()` |
| GET | `/api/nodes/{path}/custom_params` | bounded custom-page/parameter definitions |
| POST | `/api/nodes/{path}/custom_params` | transactional add/edit/delete/sort/rename lifecycle with exact rollback |
| POST | `/api/params/search` | bounded point-in-time parameter search with redaction, unreadable counters and honest completion metadata |
| GET | `/api/editor/context` | compact project, pane, active Network Editor, selection, rollover and viewport context |
| POST | `/api/editor/focus` | schedule one bounded action-aware pane/selection/framing job |
| GET | `/api/editor/focus/{operation_id}` | poll a follow receipt; the client uses a bounded 750 ms window |
| POST | `/api/editor/focus/{operation_id}/cancel` | cancel/supersede pending follow without touching project topology |
| POST | `/api/editor/insert` | context-CAS insertion of one allowlisted same-family operator, with deterministic placement and rollback |
| POST | `/api/editor/annotation-layout/context` | read a bounded annotation/node/docked/edge geometry snapshot and fingerprint |
| POST | `/api/editor/annotation-layout/apply` | compare-and-swap one bounded annotation-aware layout plan with exact readback and rollback |
| POST | `/api/editor/reposition/context` | read a bounded scalar exact-placement context and fingerprint; excluded from graph undo |
| POST | `/api/editor/reposition` | atomically place exact operator coordinates with idempotency, readback and full rollback evidence |
| POST | `/api/editor/workspaces` | schedule one temporary right-hand TOP Viewer or Panel workspace on the TD main thread |
| GET | `/api/editor/workspaces/{workspace_id}` | read bounded workspace status without touching TouchDesigner UI objects |
| POST | `/api/editor/workspaces/{workspace_id}/restore` | schedule compare-and-swap restoration and later-frame close verification |
| POST | `/api/editor/workspaces/{workspace_id}/cancel` | cancel before apply or schedule the same verified cleanup after an apply race |
| POST | `/api/project/save` | Save or Save As; existing targets require a consumed overwrite interaction |
| POST | `/api/interactions` | enqueue one allowlisted native delete/overwrite or OAuth-client decision and return immediately |
| GET | `/api/interactions/status` | content-free broker readiness: pending count/limit, active flag and native delivery configuration |
| GET | `/api/interactions/{request_id}` | bounded polling status for an opaque decision ID |
| POST | `/api/interactions/{request_id}/cancel` | cancel to the kind-specific safe choice (Keep for destructive/file prompts, Deny for OAuth); duplicate/late transitions remain terminal |
| POST | `/api/oauth/consents/{request_id}/consume` | recompute the bounded OAuth target fingerprint and consume exactly one Allow/Deny result; authenticated and available with `TDMCP_BRIDGE_ALLOW_EXEC=0` |
| POST | `/api/operations/preview` | token-required, read-only exact-state preview for one bounded structured operation |
| POST | `/api/operations/commit` | token-required one-callback operation commit with verification, rollback and one callback-journal item |
| POST | `/api/operations/receipt` | recover a terminal receipt and fresh exact journal observation using the capability in the POST body |
| POST | `/api/artifacts/tox/exports` | start a verified `as_is` or build-gated `portable` `.tox` export job |
| GET | `/api/artifacts/tox/exports/{operation_id}` | poll a bounded export receipt |
| GET | `/api/artifacts/tox/exports/by-key/{idempotency_key}` | recover a known export after response loss |
| POST | `/api/artifacts/tox/exports/{operation_id}/cancel` | request fail-closed export cancellation and cleanup |
| POST | `/api/artifacts/tox/roundtrip` | start a bounded quarantine-only `.tox` load/contract/cook inspection job; port 9980 and non-quarantine bridges are refused |
| GET | `/api/artifacts/tox/roundtrip/{operation_id}` | poll the bounded PASS/FAIL/UNVERIFIED round-trip receipt |
| POST | `/api/artifacts/tox/roundtrip/{operation_id}/cancel` | cancel a pending round-trip and verify scratch cleanup |
| POST | `/api/packages/reconcile/check` | dry-run marker ownership and return an expiring stable plan |
| POST | `/api/packages/reconcile/apply` | revalidate a plan and apply explicit Bypass or broker-authorized/YOLO Delete; Keep is a client-side no-op |
| POST | `/api/exec` | run Python `{script,return_output?}` |
| POST | `/api/nodes/{path}/method` | call `{method,args?,kwargs?}` |
| GET | `/api/nodes/{path}/errors` | node errors |
| GET | `/api/preview/{path}` | TOP as base64 PNG |
| POST | `/api/batch` | `{operations:[…]}` (create/update/delete/connect). Batch delete defaults to fail-closed `Keep` (`ok:false`); use explicit `mode:"bypass"`, explicit `confirmation_policy:"yolo"`, or the standalone broker-backed delete flow. |
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

The `/api/exec` and node-`method` endpoints are disabled bridge-side by default
unless `TDMCP_BRIDGE_ALLOW_EXEC=1` is set inside TouchDesigner. If
`TDMCP_BRIDGE_TOKEN` is configured, it authenticates requests but does not
enable arbitrary exec by itself — see [Security](/reference/architecture#security). The
structured endpoints added in 0.6.0 — `/api/connect`, `/api/disconnect`,
`/api/logs`, the `?modes=true` parameter reads, `…/params/{param}/mode` and the
DAT `…/text` reads/writes — are **not** behind the exec gate, so they keep
working while arbitrary exec is closed.

The editor context/follow/insert/annotation-layout/reposition/workspace, metadata/annotation,
custom-parameter lifecycle, parameter-menu, Pulse, project-save, interaction,
TOX export/round-trip and package reconciliation endpoints are also structured and independent of
`TDMCP_BRIDGE_ALLOW_EXEC`. Every route still passes through the same bearer-token,
loopback, Origin and Host checks. Editor insert and package apply are single REST
mutations and therefore receive one named request-level undo block; follow and
filesystem export do not create graph undo entries.

TOX round-trip is additionally gated by
`TDMCP_PROJECT_RAG_QUARANTINE=1`, refuses the artist bridge port `9980`, accepts
only absolute regular non-symlink `.tox` files, and never falls back to
`/api/exec`, `project.load()` or `project.quit()`. Annotation layout context is
read-only; apply requires its current fingerprint and fails before mutation on
editor drift. Both annotation edit and layout apply snapshot supported state,
verify exact readback and report rollback failure explicitly.

Mutation receipts report `undo_label` only when the bridge observes exactly one
new native stack item after the request. That value is TouchDesigner's actual
artist-visible item, such as `Delete Node` or `Change Bypass Flag`; when it
differs, `undo_wrapper_label` preserves the bridge's requested wrapper name.
Those labels are receipts for people and diagnostics, not safe programmatic undo
identities: the native stack exposes repeated strings and no stable item ID.
Automated undo/redo and whole-tool grouping therefore remain held after live
probes reproduced both same-label ABA ambiguity and broken cross-request block
ownership.

The guarded `/api/operations/*` family is narrower than generic whole-tool undo.
It always requires `TDMCP_BRIDGE_TOKEN`, even when other loopback routes use
zero-config auth, and remains usable with `TDMCP_BRIDGE_ALLOW_EXEC=0`. Preview is
read-only; commit performs one bounded allowlisted transaction inside one Web
Server DAT callback and owns its callback journal, so the entire family is
excluded from the ordinary per-request undo wrapper. Receipt recovery uses a
separate 256-bit capability plus the same principal and bridge instance; the
capability stays in a POST body and the idempotency key is never recovery
authority. Wave 15 added no MCP tool, CLI command, generic undo/redo or revert
route, and the public controller path remains live-`UNVERIFIED` pending a safe
disposable TD listener.

The node and parameter search routes are also structured read-only operations
independent of the exec gate. `/api/nodes/search` returns compact operator hits;
`/api/params/search` keeps value/expression filters in the POST body, redacts
likely credentials, refuses to use sensitive content as a filter oracle, skips
unreadable parameters without exception text, and bounds depth, returned hits,
node/parameter scans, response size and elapsed work. Both report whether the
match count is complete. See [Live project search](/guide/live-project-search).

### Native interaction delivery

The bridge installer adds an **Interactions** custom page and a dedicated
Parameter Execute DAT at deterministic, non-overlapping coordinates. Broker
delivery is scheduled for the next TD frame, so `POST /api/interactions` never
waits for an artist choice. `ui.messageBox` is not used because its behavior
inside a Web Server DAT callback has not been live-validated for this bridge.

The server, not the HTTP caller, derives the target fingerprint from the current
operator identity, normalized Save As path or validated display-safe OAuth
target. Choices are fixed to `Delete / Bypass / Keep`, `Overwrite / Keep` and
OAuth `Allow / Deny`. TTL is 5–120 seconds, the pending queue is capped, records
are retained for a bounded time, and terminal results are consumable exactly
once. UI loss, Perform Mode/headless operation, timeout, close/cancel, scheduling
error and disconnect fail closed to Keep for destructive/file decisions and Deny
for OAuth. Codes, verifier, state and tokens are never accepted by the TD route.

See [Native interaction & safe editor actions](/guide/native-interaction-safety)
for destructive tool usage, or [OAuth, PKCE & TD consent](/guide/oauth-pkce) for
the remote-connection boundary and current live-validation limits.

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
