---
name: tdmcp-bridge-endpoint
description: "Build a tdmcp TouchDesigner-bridge vertical slice the house way — promote an op from /api/exec to a first-class REST endpoint (e.g. POST /api/connect, GET /api/logs, node_detail flags), add its typed method in src/td-client/touchDesignerClient.ts, its Zod envelope in src/td-client/validators.ts, rewire the tool(s) to prefer the endpoint with an exec fallback, and write py_compile + td/tests unittest + offline msw client tests. Use when adding/changing a bridge REST endpoint, editing td/, extending node_detail/get_bridge_logs, promoting connect/disconnect/param-modes/DAT-text off exec, or doing any exec→REST work — especially the td-depth bridge-robustness backlog. Honors probe-live discipline when TouchDesigner is offline."
---

# tdmcp-bridge-endpoint — the bridge vertical slice

A bridge feature is correct only when **four layers agree on one shape**: the
Python route, the TS client method, the Zod validator, and the tool that consumes
it. This skill is that contract. Build the slice top-to-bottom, keep an exec
fallback so it ships safely before every bridge in the wild updates, and prove it
all offline.

> Run bridge slices **one at a time** — they share `touchDesignerClient.ts`,
> `validators.ts`, and the bridge route registry. Two in parallel is merge hell.

## Why exec→REST at all

The bridge runs arbitrary Python on `/api/exec`. A security-conscious VJ runs
`TDMCP_BRIDGE_ALLOW_EXEC=0` on a venue network — and ~69 tools silently die.
Promoting a well-defined op (connect, param-mode read/write, DAT text, node
flags, logs) to its own REST route makes it survive that hardened config. You are
**promoting proven logic**, not inventing it — start from the Python the tool
already sends through `/api/exec`.

## The slice, in order

### 1. Bridge (Python, `td/`)
- Add a handler module (or extend the right existing one) and **register the
  route**. Find how routes are registered (the request dispatcher in `td/`) and
  follow that exact pattern — don't invent a second mechanism.
- Keep every TD-global (`op`, `app`, `project`, `ui`) **inside the handler
  function** so the module imports cleanly outside TD (the tests rely on this).
- Return a JSON report with a stable shape: a top-level `ok`/error and the data.
  Mirror the envelope the existing endpoints return so `parsePythonReport`/the
  validators stay uniform.
- Honor `TDMCP_BRIDGE_TOKEN` (bearer auth) and the `ALLOW_EXEC` gate exactly as
  sibling routes do — a new route must not become an auth bypass.
- `python3 -m py_compile td/**/<changed>.py` on every changed file.

### 2. Client method (`src/td-client/touchDesignerClient.ts`)
- Add **one** typed method that calls the new route (GET/POST/PATCH/PUT as fits).
- Map failures to the existing typed errors: `TdApiError` (4xx/5xx with a body),
  `TdConnectionError` (refused/DNS), `TdTimeoutError`. Never let a raw fetch error
  escape.
- **Exec fallback:** if the endpoint returns 404 (older bridge without the route),
  fall back to the previous `/api/exec` Python path. This is what lets the
  promotion ship before the bridge is reinstalled everywhere. Make the fallback a
  private helper so the test can force both paths.

### 3. Validator (`src/td-client/validators.ts`)
- Add a Zod schema for the response envelope and `.parse()` it in the client —
  never hand a raw wire object upward. Reuse the shared envelope helpers already in
  the file.

### 4. Rewire the tool(s)
- Point `connect_nodes`/`disconnect_nodes`/`read_parameter_modes`/
  `set_parameter_expression`/`edit_dat_content`/`set_dat_content`/`get_bridge_logs`/
  the `node_detail` consumers at the new method. **Preserve current behavior and
  output exactly** — this is a transport swap, not a redesign. Keep fail-forward:
  validate inputs with Zod, turn TD failures into friendly `isError` via
  `errorResult`/`friendlyTdError`; never throw out of a handler.

## Probe-live discipline (when TD is offline)

Attribute names that vary by TD build are the trap: connector semantics for
connect/disconnect, `ParMode`/`.expr`/`.mode` names for param-modes, Error DAT
column layout for logs, optype enumeration for createable. The backlog flags these
`probe-live`.

- **TD reachable** (`get_td_info` ok): probe the real names in a scratch network
  first (create a couple of ops, read the actual attrs), *then* lock the schema.
- **TD offline:** implement against the best-known names from the knowledge base
  (`tdmcp://operators/...`, `tdmcp://classes/...`) and TD's documented Python API;
  write the offline tests; and **flag every probe-dependent assumption
  `UNVERIFIED-live`** in your report (with the source you used). Do not claim a live
  pass you could not observe. The campaign-lead holds `UNVERIFIED-live` items for a
  live pass before the final release.

## Tests (offline — no TD)

- **Bridge unittest** `td/tests/test_<name>.py`: import the handler, call it with a
  faked `op()`/payload, assert the report shape and the error branch. At minimum
  `py_compile`. Run `python3 -m unittest discover -s td/tests`.
- **Client msw test** `tests/unit/*`: stub the route; assert (a) success → validated
  shape, (b) 4xx/5xx → correct `TdError` subclass, (c) timeout → `TdTimeoutError`,
  (d) **404 → exec-fallback path** returns the same shape. Mirror the closest
  existing client test.

## Gates (all green before reporting)

`npm run typecheck` · `npm run build` · `./node_modules/.bin/biome check .` (NOT
`npm run lint`) · `npm test` · `npm run test:bridge`. Fix forward; never disable a
gate or use `--no-verify`.

## Report back

Endpoint(s) added + method + validator; tool(s) rewired; the exec-fallback
behavior; every `UNVERIFIED-live` assumption with its source; gate results; and the
ledger fields to set (`files[]`, `status`). On a re-run, treat feedback as a diff —
don't rewrite a green slice.
