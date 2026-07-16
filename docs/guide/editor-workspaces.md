---
description: "Exact Network Editor placement and temporary artist workspaces with bounded inputs, main-thread UI scheduling and compare-and-swap restoration."
---

# Editor workspaces & exact placement

<FeatureAvailability status="source-only" locale="en" />

Wave 10 adds two deliberately narrow editor workflows: exact placement through
the existing `arrange_network` tool, and a temporary side-by-side workspace
through `manage_artist_workspace`. Both use authenticated structured bridge
routes and are designed to work with `TDMCP_BRIDGE_ALLOW_EXEC=0`.

::: tip Evidence boundary
The Wave 10 schemas, structured routes, client polling and rollback/state-machine
contracts pass integrated offline QA. Authenticated current-build live QA also
passed exact placement apply/replay/undo/redo and the TOP-restore plus
PANEL-cancel workspace lifecycles on TouchDesigner 099 build 2025.32820 with
bridge exec disabled. Untested edge cases and platforms remain explicitly
**UNVERIFIED**. This is still unreleased source-tree work.
:::

Neither workflow opens arbitrary UI, exposes raw Python, loads or quits a
project, or creates a cross-request undo transaction. Panic, blackout and other
emergency paths never call or wait on the workspace lifecycle.

## Exact placement with `arrange_network`

`arrange_network` keeps its existing automatic layout and gains an additive
`layout_mode: "explicit"` branch. Explicit mode places existing immediate
children of one COMP at exact Network Editor `nodeX` / `nodeY` coordinates. It
does not create, delete, rename, reparent, connect or disconnect operators.

```json
{
  "path": "/project1/show",
  "layout_mode": "explicit",
  "positions": {
    "/project1/show/glsl1": [200, -120],
    "/project1/show/glsl1_pixel": [430, -220]
  },
  "target_source": "provided_paths",
  "include_docked": true
}
```

The explicit contract is bounded:

- `positions` contains 1 to 256 normalized absolute operator paths. Every path
  must be an immediate child of `path`.
- Coordinates are safe integers from `-1_000_000` to `1_000_000`.
- `target_source: "provided_paths"` is UI-independent and never infers a
  selection.
- `target_source: "active_selection"` accepts at most 64 paths. The active pane
  must be a Network Editor owned by `path`, and its exact selected/current set
  must match the supplied position keys. Missing UI or Perform Mode never means
  approval to move more nodes.
- Explicit mode requires `recursive: false`, `annotation_aware: false` and
  `resize_annotations: false`. It does not run the automatic or
  annotation-aware planner.
- An opaque idempotency key may be supplied for response-loss recovery. If it is
  omitted, the client creates one for that invocation. Reusing the same key with
  different input or different live state fails closed.

### Docked-operator precedence

TouchDesigner 2025.32820 did not move directly docked DATs when a host's
`nodeX` / `nodeY` changed programmatically. Explicit mode therefore resolves
docking before it writes anything:

1. A docked child named in `positions` goes to its exact requested coordinate.
   The explicit child always wins.
2. With `include_docked: true`, an unnamed **direct** docked child follows its
   named host by the same delta.
3. With `include_docked: false`, only explicitly named operators move.
4. Ambiguous ownership, cycles, unsupported nested dock chains or an out-of-range
   carried coordinate reject the whole plan before mutation.

```text
host:              0,   0  -> 200, -120   (explicit)
named docked:     40, -90  -> 430, -220   (explicit wins)
unnamed docked:   40,-180  -> 240, -300   (host delta)
```

The client first reads a compact scalar context and fingerprint, then sends one
mutating `POST /api/editor/reposition`. The bridge recomputes the context,
snapshots every affected position, applies and reads back all coordinates, and
restores the full snapshot after a partial failure. A stale fingerprint causes
zero writes. Receipts distinguish `applied`, `unchanged`, `replayed` and
`failed`, include per-path previous/requested/final positions, and report
rollback truthfully.

The apply is one mutating REST request, so the existing request-level undo
wrapper can cover the complete placement. An undo label is returned only when
the live stack actually proves one new native item; there is still no promise of
one undo item across several REST requests or a whole agent turn.

## Temporary workspaces with `manage_artist_workspace`

`manage_artist_workspace` manages one temporary, bridge-owned layout per bridge
process. It reuses an existing Network Editor and adds exactly one right-hand
viewer pane. It never creates a floating window or persistent pane preset.

The lifecycle has four actions:

| Action | Purpose |
| --- | --- |
| `open` | Schedule one bounded split for the next TouchDesigner frame and return immediately. |
| `status` | Read one compact receipt by opaque `workspace_id`; it never touches the UI. |
| `restore` | Schedule compare-and-swap restoration of the exact bridge-owned layout. |
| `cancel` | Cancel before apply, or run the same verified restoration if apply won the race. |

### Open a TOP output workspace

```json
{
  "action": "open",
  "network_path": "/project1/show",
  "viewer_path": "/project1/show/out1",
  "viewer_mode": "top_output",
  "split_ratio": 0.62,
  "lease_seconds": 300
}
```

`top_output` requires `viewer_path` to resolve to a TOP. A `TOPVIEWER` pane does
**not** accept that TOP directly as its owner. The bridge must instead:

1. snapshot the TOP's parent COMP and its previous current child;
2. make the requested TOP the parent's current child;
3. assign that parent COMP as the `TOPVIEWER` owner; and
4. include both owner and current-child state in compare-and-swap restoration.

If any of that state drifts, restoration conflicts instead of overwriting the
artist's edit.

### Open a panel-controls workspace

```json
{
  "action": "open",
  "network_path": "/project1/show",
  "viewer_path": "/project1/show/controls",
  "viewer_mode": "panel_controls"
}
```

`panel_controls` requires a panel-capable COMP. That COMP itself is the
`PaneType.PANEL` owner. Arbitrary pane types, split directions, pane names,
monitor geometry and force flags are not accepted.

For both modes, `network_path` and `viewer_path` must be explicit, valid and in
the same project root. `split_ratio` is the existing Network Editor's share and
is bounded to `0.35..0.75` (default `0.62`). `lease_seconds` is bounded to
`30..900` (default `300`). Only one non-terminal workspace is allowed.

### Async polling and close verification

The initial `open`, `restore` and `cancel` requests do not wait for TouchDesigner
UI work. The client polls every 50 ms for at most 1.5 seconds. During status
polling, a timeout or lost connection triggers a best-effort cancel and never
becomes an `active` or `restored` success claim.

If the initial `open`, `restore` or `cancel` response is lost to a connection or
timeout error, the client performs exactly one recovery POST with the identical
body and transport-only idempotency key. The bridge returns the original
deduplicated receipt instead of repeating the transition. Domain,
authorization and other deterministic 4xx failures are never retried. If the
second response is also lost, there is no third POST: the caller can inspect
`status`, and the bounded lease remains authoritative.

Every TouchDesigner object is resolved and used only inside a next-frame main-
thread callback. The service retains plain JSON state and scalar identities,
never Pane, OP, Run or callback proxies. After `changeType()`, the old Pane proxy
is discarded because the live build invalidates it.

`Pane.close()` is also deferred on the validated build: the closed pane can
still appear during the same callback. Restore therefore uses two frames:

1. compare the complete post-open fingerprint and close only the exact owned
   pane;
2. on the following frame, reacquire panes by scalar identity and verify that
   the owned pane disappeared and the baseline returned.

Until that later readback passes, the receipt remains `restore_scheduled`,
`cancel_scheduled` or `cleanup_scheduled`. It must not claim `restored`,
post-apply `cancelled` or `expired`.

The first integrated rerun used a three-readback settling window and safely
failed/compensated before the Network Editor viewport stabilized. Raising that
window to 12 exposed later drift from the Network Editor `home()` animation:
the animation outlived the transaction. Because viewer owner assignment is
sufficient, the final workspace path no longer calls `home()`; the 12-readback,
two-identical-fingerprint guard remains as bounded defense. A fresh TOP rerun
then reached `active`, restored the baseline viewport and kept it identical one
second later. Neither intermediate failure became a false success claim.

### Compare-and-swap safety

The bridge snapshots only enough UI state to reverse its own one-split
transaction. Before cleanup it checks the full post-open pane fingerprint, the
source Network Editor and the owned viewer pane. An artist change to owner,
current child, viewport, ratio, name, type or pane set produces `conflicted`
with no cleanup mutation. There is no force path.

Perform Mode, headless/UI-unavailable operation, a missing compatible Network
Editor, a wrong target family, a cross-project target, pane limits, scheduling
failure or stale target all fail closed. UI-only workspace routes are excluded
from graph undo and always report `undo_label: null`.

### Inspect and restore

```json
{ "action": "status", "workspace_id": "<opaque-workspace-id>" }
```

```json
{ "action": "restore", "workspace_id": "<opaque-workspace-id>" }
```

Possible lifecycle states include `scheduled`, `active`,
`restore_scheduled`, `cancel_scheduled`, `cleanup_scheduled`, `restored`,
`cancelled`, `expired`, `suppressed`, `conflicted` and `failed`. A scheduled
receipt is progress, not proof that the editor changed.

## Evidence examples

These labels distinguish observed evidence from expected fail-closed behavior;
current-build PASS does not promote untested edge or platform cases.

### PASS — authenticated current-build routes

```json
{
  "status": "PASS",
  "scope": "TouchDesigner 099 build 2025.32820, macOS, authenticated bridge, ALLOW_EXEC=0",
  "observed": [
    "explicit docked child won over host carry",
    "unnamed direct docked child followed the host delta",
    "explicit apply replayed idempotently and one native undo/redo covered the placement",
    "TOP workspace reached active with a 0.62/0.38 split and restored to one pane",
    "PANEL workspace reached active and cancel restored the baseline",
    "both workspace cleanups proved closed, restored and baseline_verified with undo_label null",
    "the final TOP baseline viewport remained identical one second after restore",
    "terminal restore no-ops did not grow the idempotency map",
    "unauthenticated access returned 401 and an invalid 0.1 split returned 400",
    "no new THREAD CONFLICT appeared in the isolated final reruns"
  ]
}
```

### FAIL — stale or artist-modified state

```json
{
  "status": "FAIL",
  "reason": "artist_layout_changed",
  "result": "conflicted",
  "mutation_applied": false,
  "message": "The captured workspace no longer matches; no pane was closed or rewritten."
}
```

Exact placement similarly fails with zero writes for a stale fingerprint,
selection mismatch, ambiguous docking or invalid path/coordinate. A partial
setter failure is not a clean failure unless the receipt proves full rollback.

### UNVERIFIED — remaining edge and platform evidence

```json
{
  "status": "UNVERIFIED",
  "pending": [
    "live selection-derived placement CAS and induced apply/rollback failure",
    "live artist-change workspace conflict, timeout, disconnect and lease expiry",
    "live Perform Mode suppression and unusual multi-pane layouts",
    "Windows, TouchPlayer, floating panes, other TD builds and real headless runtime"
  ]
}
```

## Compatibility and migration

- Omitting `layout_mode` remains equivalent to `layout_mode: "auto"`. Existing
  legacy and annotation-aware `arrange_network` calls keep their current inputs,
  planners and response shapes.
- Explicit-only fields are rejected in auto mode rather than silently changing
  an old call. Explicit mode is a new structured path; it does not create a
  second placement tool or inflate the tool catalog.
- Only the new explicit route is guaranteed not to fall back to raw Python. The
  pre-existing legacy automatic branch keeps its previous runtime requirements.
- `manage_artist_workspace` is additive. It does not replace
  `focus_network_editor` or `get_editor_context`, and it exposes no generic pane
  manager.
- Reload or reinstall the matching runtime bridge before using either Wave 10
  contract. A bridge without the structured routes must fail; clients must not
  fall back to `/api/exec`.

## Bounded visual critique (unreleased)

`enhance_build.visualCritique` is an opt-in branch of the existing tool. It keeps
the legacy call unchanged, accepts one explicit TOP plus 1–6 bounded numeric
targets, and defaults to preview-only. Mutation still requires the TD-native
**Apply / Keep** broker; Apply uses a proposal-bound CAS, exact readback and a
capability-bound compensating restore.

The exact local `qwen3-vl:8b-instruct-q4_K_M` calibration passed preview,
Apply/readback and restore on TD 2025.32820 with `TDMCP_BRIDGE_ALLOW_EXEC=0`.
Invalid model shape and approval timeout stayed zero-write. Other models, TD
builds and actual headless TD remain **UNVERIFIED**.
