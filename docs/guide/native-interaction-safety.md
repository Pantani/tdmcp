---
description: "Safe, native TouchDesigner decisions and editor primitives: consent, action-aware follow and insertion, transactional TOX export, package reconciliation and custom-parameter lifecycle."
---

# Native interaction & safe editor actions

<FeatureAvailability status="source-only" locale="en" />

tdmcp can now ask for a destructive decision inside TouchDesigner without
holding the original HTTP request open. Wave 1 adds a small, authenticated
interaction broker and structured editor actions that keep working when
`TDMCP_BRIDGE_ALLOW_EXEC=0`.

## The native decision inbox

The runtime bridge has an **Interactions** custom-parameter page. A delete or
overwrite request is queued, returned as an opaque request ID, and presented on
the following TouchDesigner frame. Choose an item in **Choice**, then pulse
**Apply Choice**. **Safe Close** cancels safely: destructive/file prompts resolve
to **Keep**, while OAuth consent resolves to **Deny**.

This inbox is deliberately non-modal. It does not call `ui.messageBox` from the
Web Server DAT callback, so a prompt never keeps the original request open past
the client's normal HTTP timeout. Only one prompt is presented at a time; the
queue, lifetime and retained records are bounded.

Every unsafe terminal path means **Keep**: timeout, close/cancel, lost client,
missing UI, Perform Mode, headless operation, scheduling failure or duplicate
consumption. A prompt can authorize its exact target once. It cannot execute
Python, carry a callable, or approve another operator or file.

Panic, blackout and other emergency paths do not use or wait for this broker.

## Delete / Bypass / Keep

`delete_td_node` with `mode: "delete"` presents exactly:

- **Delete** — destroy the operator after consent;
- **Bypass** — set the operator's bypass flag and preserve it;
- **Keep** — leave the operator unchanged.

The prompt identifies the operator path, type and name and summarizes the local
impact. The result reports the decision, original/final path, applied action,
confirmation policy, request ID, and the per-request TouchDesigner undo label
when the live build exposes one.

### Migration from the old delete behavior

Existing calls with `{ path, mode }` remain valid, but the safe default changed:

- `mode: "delete"` now requires native consent and returns **Keep** when the UI
  cannot decide;
- `mode: "bypass"` remains immediate and reversible;
- `TDMCP_YOLO=1` is the only tool-level skip policy. It is explicit in the
  structured result as `confirmation_policy: "yolo"`; missing UI is never
  interpreted as approval.

Reinstall or reload the runtime bridge with this source before using the new
flow. An older bridge that lacks the broker fails rather than falling back to an
unconfirmed legacy delete.

Batch delete cannot pause a batch for UI consent. A legacy batch delete now
returns `Keep` with `ok: false`. Use the standalone `delete_td_node` flow for
native consent, or make the batch policy explicit with `mode: "bypass"` or
`confirmation_policy: "yolo"`.

Delete is not inherently “impossible to undo.” Its final REST mutation already
runs inside the bridge's `ui.undo` wrapper. A live build probe confirmed that
ordinary nested blocks can collapse into one outer-named undo item, but also
found that creating an `annotateCOMP` closes/replaces the caller's outer block.
One undo entry spanning an arbitrary high-level MCP tool is therefore not safe
to enable yet.

## Save and Save As

`save_td_project` saves the current `.toe`, or accepts an absolute `.toe` path
for Save As. An existing different target requires an **Overwrite / Keep**
decision from the broker. No file dialog, project load, project quit, or raw
Python fallback is exposed.

Success is returned only after the target exists on disk. Untitled projects
require an explicit Save As path. A consent ticket is bound to the normalized
target path and cannot authorize a different file.

## Editor-aware primitives

- `get_editor_context` returns a compact project/build snapshot, Perform Mode,
  panes, the explicitly active Network Editor, owner/current/selected nodes,
  rollover operator/parameter and viewport. Missing UI fields are omitted or
  null with warnings; topology is not dumped.
- `pulse_td_parameter` resolves an operator and parameter, verifies that its
  style is `Pulse`, calls `.pulse()`, and reports typed errors for an invalid
  operator, missing parameter or wrong style.
- `edit_td_node_metadata` edits name, parent, exact position, color, comment and
  supported writable flags. It reads changes back and rolls back a partial
  failure. Parent moves copy and validate the destination before destroying the
  source.
- `create_td_node` accepts `placement: "auto" | "explicit"`, exact `node_x` /
  `node_y`, and `viewer`. Omitting placement preserves the previous TD drop
  behavior; reused idempotent nodes keep their existing layout.

## Undo status

The bridge keeps its existing **one undo block per mutating REST request**. New
single-request metadata, Pulse, create and final delete mutations receive useful
receipts. The receipt now reports the actual newest artist-visible native item
when exactly one item was added; when TouchDesigner substitutes a built-in name
such as **Delete Node** or **Change Bypass Flag**, the requested wrapper name is
reported separately by the raw bridge response.

Live validation on TouchDesigner 2025.32820 proved that an ordinary outer block
can undo and redo two nested edits as one item, and that `finally` closes a block
after an exception. It also reproduced the blocker: creating an `annotateCOMP`
inside the outer block created its own **Add Annotate** entry, closed/replaced
the outer block, and made the caller's `endBlock()` fail. Cross-request,
whole-MCP-tool transactions remain held until a TD-safe ownership protocol can
survive operator-specific undo behavior, cancellation and timeouts without
orphaning a transaction.

Automated one-item undo/redo is also **HELD**. A two-item live probe established
that this build exposes stacks newest-first (`stack[0]`) and that native undo and
redo work, but a follow-up identity probe showed that every stack read returns a
fresh plain string. Two unrelated actions can both be named **Delete Node** or
**Change Bypass Flag**; after an intervening artist edit, a label-only check can
still match and undo the wrong action (same-label ABA). Count checks reduce but
cannot eliminate that ambiguity. No public tool or route is registered until TD
exposes a stable item identity or a stronger artist-edit-aware protocol is
proved.

## Wave 7: action-aware, transactional editor workflows

Wave 7 extends existing tools instead of adding aliases. `focus_network_editor`,
`manage_component`, `make_portable_tox`, `manage_packages` and
`add_custom_parameters` now share bounded structured bridge primitives, and the
new `insert_operator_at_selection` tool adds the missing editor mutation. The
routes remain authenticated and work with `TDMCP_BRIDGE_ALLOW_EXEC=0`; the legacy
`manage_component` **load** path is unchanged and still uses its existing
exec-gated implementation.

### Evidence status

| Area | Status | What the evidence proves |
| --- | --- | --- |
| Action-aware Network Editor follow | **PASS — TD 2025.32820 route** | The authenticated route reused visible/compatible panes, replaced current/selection exactly, ran six generation-checked viewport frames, cancelled rapid stale generations and suppressed Perform Mode. A real headless process, other TD builds and unusual multi/floating-pane layouts remain **UNVERIFIED**. |
| Insert at active selection | **PASS — authenticated route, TD 2025.32820** | With auth enabled and bridge exec disabled, single-chain, fan-out, multi-input, deterministic placement, replay/conflict, induced rollback and one-item route undo/redo passed without a thread conflict. Live TD connector proxies required structural owner/path/index identity rather than Python object identity. |
| Transacted `.tox` export | **PASS — authenticated route, TD 2025.32820** | `as_is`/`portable`, exact **Overwrite / Keep**, response-loss recovery by idempotency key, deduplicated retry, cancellation, hashing and cleanup passed with bridge exec disabled. Filesystem artifacts remain outside TD graph undo. |
| Package namespace reconciliation | **PASS — authenticated TD + local storage** | Keep, native Bypass/Delete, explicit audited YOLO, stale-plan rejection, quarantine/registry commit or restore, and TD undo/redo passed end to end. The live fix aligns broker fingerprints on `OPType`; TD undo restores only TD state, not committed registry/filesystem state. |
| Custom-parameter lifecycle | **PASS — authenticated route, TD 2025.32820** | Add/edit/delete/sort/rename/delete-page, exact undo/redo, replay/conflict, induced rollback and rollback undo safety passed. Live fixes cover imported-module ParMode resolution, structural ParGroup identity, style-safe rollback and deterministic clamp/value ordering. EXPORT remains **HELD**. |
| Automated one-item native undo/redo | **REJECTED** | Native undo/redo works, but the live stack exposes only repeatable string labels with no stable item identity. Same-label ABA can target an intervening artist action, so a generic route/tool is permanently rejected. |
| One-request structured operation | **OFFLINE PASS / LIVE ROUTE UNVERIFIED** | Wave 15 adds token-required preview, one-callback commit and capability-authorized receipt observation outside the generic wrapper. The adapter previously passed live journal undo/redo and rollback, but the new public route could not be exercised because the disposable second TD process never opened a listener. No MCP tool is registered. |
| Whole-tool undo across REST requests | **FAIL / REJECTED DESIGN** | TD terminates a dangling undo block when each Web Server DAT callback returns. A later request cannot safely join it; one undo removed only the first probe mutation. The bridge therefore keeps one named undo block per legacy mutating REST request and never carries a block across requests. |
| Colour highlight | **HELD** | Framing/current/selection shipped. Transient colour restoration under overlapping actions and artist edits has no accepted compare-and-swap contract, so Wave 7 does not change node colours. |

`PASS` is scoped to the evidence named in the row. It does not promote actual
headless TouchDesigner, TouchPlayer, other builds, external filesystem behavior,
or an unrun authenticated end-to-end path.

### Wave 15 operation boundary

`POST /api/operations/preview`, `/commit` and `/receipt` are guarded source-tree
bridge primitives, not MCP tools. They require a configured bearer token before
the request body is parsed and remain usable with
`TDMCP_BRIDGE_ALLOW_EXEC=0`. Preview is read-only. Commit owns one synchronous
callback-journal transaction, and receipt recovery requires the opaque operation
ID, a separate 256-bit capability, the same authenticated principal and the same
bridge instance. Capabilities stay in POST bodies and are never undo labels or
query parameters. The idempotency key only deduplicates an identical commit and
is deliberately absent from terminal receipts.

The source tree does not expose generic undo/redo, receipt-bound revert,
selection-to-component or plan/preview/commit agent orchestration yet. Revert
requires a direction-aware compensation journal plus native Apply/Keep consent;
selection collapse requires live proof of exact topology/reference rollback.
The Wave 15 disposable process did not reach a bridge listener, so those paths
remain `UNVERIFIED` instead of borrowing evidence from the artist's unsaved
project.

### Action-aware Network Editor follow

The legacy `{ paths, animate }` call remains valid. New optional fields make the
receipt and UI policy explicit:

- `action`: `create`, `edit`, `inspect`, `view`, `layout` or `delete`;
- `framing`: `auto`, `selection`, `owner` or `none`;
- `enabled`: an explicit opt-out that returns a typed suppression.

Targets must belong to one parent network. The bridge prefers the active or
already-owning compatible Network Editor, never creates a pane, replaces stale
selection, assigns an explicit current operator and reads back the final owner,
selection and viewport. `animate:true` uses six bounded next-frame ease-out steps;
every step revalidates the pane generation and only the sixth publishes final
readback. A newer generation cancels stale scheduled steps. Disabled follow,
Perform Mode and UI-unavailable sessions do not move the editor. Actual headless
behavior remains **UNVERIFIED**, and colour highlight remains **HELD**.

### Insert at the active selection

`insert_operator_at_selection` requires the exact active Network Editor owner,
single selected operator and current operator returned by `get_editor_context`,
plus an opaque idempotency key. Any context drift fails before creation. The
bridge accepts only a live-creatable same-family operator type, assigns explicit
deterministic non-overlapping coordinates immediately, forces the new viewer off,
and replaces one stable downstream edge while preserving fan-out siblings and
other downstream inputs.

Creation, parameters, placement, connector changes and final readback happen in
one authenticated REST mutation with one request-level undo label. A failure
disconnects/destroys only the new node and verifies the exact original edge
snapshot; retries replay a sanitized receipt, while a reused key with changed
input fails closed. Mouse-interactive `placeOPs`, selected-wire inference,
multi-node insertion and raw Python are not exposed. The final main-thread-only
harness passed the authenticated route on 2025.32820 with bridge exec disabled,
including exact rollback, replay/conflict and route-level undo/redo.

### Transactional TOX export

`manage_component action:"save"` now uses the shared `as_is` transaction, and
`make_portable_tox` uses `portable`. Both validate an absolute `.tox` target,
queue at most one active export, write a unique same-directory temporary file,
verify size/hash/build, atomically promote it and retain a bounded status receipt
for polling and idempotent retry.

Overwrite now defaults to `overwrite_policy:"refuse"`. Use `"ask"` to request
an exact target-bound **Overwrite / Keep** ticket; missing UI is never consent.
Portable mode snapshots Text/Table DAT file links/content and COMP
`externaltox` state, restores them in `finally`, and is fail-closed outside the
live-proven build unless the operator explicitly opts into a separately tested
build. A `.tox` can succeed while README/manifest sidecars fail; that is reported
as `partial_failure`, never as full package success.

With bridge exec disabled, the structured portable export still runs. The
existing README introspection helper is best-effort and may be skipped with a
warning because that sidecar path remains legacy/exec-gated.

A filesystem write is not TouchDesigner graph undo. No claim is made that
`ui.undo` can remove or restore an exported artifact. Client timeout/disconnect
after dispatch can also be ambiguous; poll the opaque operation ID before
retrying.

### Package namespace reconciliation

`manage_packages action:"reconcile"` is dry-run-first. The plan scans a bounded
project namespace and acts only on a unique marker whose package ID, source
fingerprint, ref and scope match the local install record. Foreign, unreadable,
mismatched, markerless and duplicate candidates are non-actionable.

Apply requires the unexpired `plan_id` and revalidates ownership. **Keep** is a
no-op, **Bypass** preserves the live COMP, and **Delete** requires native consent
unless explicit YOLO policy is active. Local staged files are quarantined before
the registry record changes; a failure restores the quarantine when possible,
and an incomplete cleanup returns `partial_failure` plus remediation. A legacy
uninstall that still has a live TD target now returns this safe reconciliation
plan instead of deleting local state first.

This workflow never runs third-party scripts, installs Python dependencies,
downloads models or configures external applications.

### Custom-parameter lifecycle

Existing `{ comp_path, page, params }` calls still mean transactional add.
`operations` adds bounded `add`, `edit_parameter`, `delete_parameter`,
`sort_page`, `rename_page` and `delete_page` actions in the same tool. Supported
styles are Float, Int, Toggle, Str, Menu, Pulse, Header, OP, TOP, File, Folder,
XYZW and RGBA; legacy RGB/XYZ inputs remain accepted. EXPRESSION and BIND modes
are supported. **EXPORT mode is HELD** and fails before mutation because a
reversible export-source contract was not proved.

The migration intentionally tightens old partial-add behavior: an exact existing
definition is `unchanged`, a conflicting definition fails before replacement,
and a later failure restores the complete custom-page snapshot or reports
`partial_failure`. Built-ins are never editable. Sort must name every ParGroup
exactly once and passes only `par.parGroup` objects to TD, preserving XYZW/RGBA
components. Results are per operation and field; values, expressions and bind
expressions are omitted from idempotency receipts.

### Environment-specific external plugin warning

The macOS alert about being unable to open OS encryption services was diagnosed
on this workstation as a **FAIL of local install trust**, not a tdmcp bridge
failure: the current TouchDesigner bundle has an invalid sealed-resource code
requirement, while the installed FreenectTOP plugin is ad-hoc signed and rejected
by Gatekeeper. The binary being mapped does **not** prove that the operator
registers or cooks; functional activation is **UNVERIFIED**.

Do not delete keychain items, strip quarantine or re-sign the main app as a
shortcut. The safe next experiment is a pristine official TouchDesigner install
verified before launch, first without external plugins and then with a
vendor-signed/notarized plugin in an isolated project.

### Wave 8 result examples

**PASS — verified transaction**

```json
{
  "status": "succeeded",
  "operation_id": "opaque-export-id",
  "verification": { "level": "load_independent" },
  "cleanup": { "pending": false }
}
```

**FAIL — ownership could not be proved**

```json
{
  "status": "failed",
  "code": "package_not_recorded",
  "storage": { "quarantined": false, "recordRemoved": false }
}
```

**UNVERIFIED — evidence boundary**

```json
{
  "status": "UNVERIFIED",
  "checks": [
    "actual headless TouchDesigner",
    "other TouchDesigner builds",
    "external plugin registration and cooking"
  ]
}
```

## Wave 9: trusted portable components and annotation-aware layout

Wave 9 extends existing tools; it does not add duplicate annotation, layout or
package tools. All new TouchDesigner operations use authenticated structured
routes and remain available with `TDMCP_BRIDGE_ALLOW_EXEC=0`.

`manage_annotation action:"edit"` edits an existing `annotateCOMP` title, body,
RGBA colour and exact `x`, `y`, `w`, `h` bounds. The bridge resolves every
writable alias before mutation, snapshots the complete supported state, applies
and reads back each requested field, and restores the snapshot after a partial
failure. Text and comment values are redacted from bridge logs and receipts.
Text DAT fallbacks created by the legacy create path are intentionally not
accepted by edit.

`arrange_network` keeps its legacy behavior unless `annotation_aware:true` is
set. The opt-in path reads one bounded geometry snapshot, rejects ambiguous
overlapping annotation membership, plans groups without raw Python, and applies
positions with a snapshot fingerprint. A stale editor context fails before
mutation. Docked DATs move by their host delta; `resize_annotations:true` fits
non-empty boxes to their contents plus `annotation_padding` (default `80`). An
identical second run reports zero moved nodes.

For portable artifacts, `validate_library_asset` accepts
`validation_mode:"deep_roundtrip"` only with an authenticated, explicitly
quarantined bridge on a port other than `9980`. It loads the `.tox` into a unique
scratch holder, waits bounded frames, compares the declared component contract,
captures bounded errors/external references, and always attempts cleanup.
Missing runtime or missing proof returns **UNVERIFIED**, never PASS.

`make_portable_tox` now records a versioned provenance sidecar by default. It
binds the final TOX hash to a canonical package-manifest hash, source COMP
identity, TD/tdmcp build and only the Git commit/dirty state. It never records
tokens, environment values, diffs, project contents or repository roots. Use
`provenance_policy:"require_clean"` (and optionally `expected_git_commit`) for a
strict release preflight; unavailable, dirty or mismatched Git state fails
before export. Existing targets still require explicit native overwrite consent,
and TOX plus provenance are promoted as one recoverable pair.

The optional `help_snapshot` inventories bounded operator types and explicitly
named TD Python APIs, reads only the installed exact-build OfflineHelp corpus,
writes a deterministic `docs/td-help` index/README, and reruns the quarantine
round-trip after attachment. Caps, missing installed pages or build mismatch are
reported honestly as **UNVERIFIED**. `attach_docs_as_assets` can refresh the same
snapshot later and atomically updates an existing provenance manifest hash.

### Wave 9 result examples

**PASS — exact-build artifact contract and cleanup verified**

```json
{
  "validation_mode": "deep_roundtrip",
  "roundtrip": {
    "verdict": "PASS",
    "runtime": { "td_build": "2025.32820" },
    "cleanup": { "verified": true }
  }
}
```

**FAIL — strict provenance policy rejects before export**

```json
{
  "status": "FAIL",
  "code": "git_worktree_dirty",
  "export_started": false
}
```

**UNVERIFIED — bounded help inventory cannot prove every entry**

```json
{
  "status": "UNVERIFIED",
  "reason": "operator_type_cap",
  "available": 1,
  "truncated": 7
}
```

## Honest result examples

**PASS — offline contract and state confirmed**

```json
{
  "status": "PASS",
  "decision": "Keep",
  "action_applied": "keep",
  "applied": false,
  "final_path": "/project1/noise1"
}
```

**FAIL — an invalid structured operation**

```json
{
  "status": "FAIL",
  "error": {
    "code": "invalid_parameter_type",
    "message": "pulse: parameter Gain has style Float, expected Pulse"
  }
}
```

**UNVERIFIED — outside the tested runtime**

```json
{
  "status": "UNVERIFIED",
  "reason": "runtime not exercised",
  "checks": ["actual headless TouchDesigner", "builds other than 2025.32820"]
}
```

`UNVERIFIED` is not a pass. The graphical 2025.32820 matrix passed; run separate
live validation before depending on the same semantics in headless mode, another
build or a show-critical external filesystem.

## Deferred follow-ups

OAuth/PKCE arrived as a later opt-in HTTP authorization wave; see
[OAuth, PKCE & TouchDesigner consent](/guide/oauth-pkce). These waves do not add
remote skill catalogs/installers,
workspace snapshot/restore, selection-to-component,
animated global highlight, broad bridge refactoring, or migration of
every destructive command to the broker. Those remain separate follow-ups.
Curated bundled skills and build-aware local docs arrived in the next source-tree
wave; see [Build-aware agent & runtime readiness](/guide/build-aware-runtime).
