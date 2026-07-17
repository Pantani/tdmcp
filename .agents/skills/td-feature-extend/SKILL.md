---
name: td-feature-extend
description: "Implement or fix an EXISTING tdmcp capability whose work must edit current source, tests, CLI, LLM, resource, package, or tool files. Use for backlog items labelled EXTENSION, existing-tool changes, CLI/AI workflow extensions, and QA fixes that cannot obey the new-files-only td-builder contract. Also use for continue, resume, re-run, update, fix, or improve requests on a prior extension build. Do not use for a brand-new isolated tool (td-feature-build) or a Python bridge REST vertical slice (tdmcp-bridge-endpoint)."
---

# td-feature-extend — safely change an existing capability

Existing-surface work needs a different contract from parallel new-tool builds. A
new-tool builder stays isolated by touching only new files; an extension must edit
files that other features may also need. This skill makes that mutation explicit,
serialized when ownership overlaps, and independently testable.

## Input contract

Receive an implementable spec and a manifest entry containing:

- `id` and `build_mode: "extension"`;
- an explicit `ownership[]` file/glob lease;
- `depends_on[]` and any shared schema consumed or owned;
- probe-first risks and required tests;
- the authoritative worktree path.

If `ownership[]` is missing or overlaps another active extension/bridge builder,
stop before editing and ask the campaign leader to serialize or repartition the
work. Concurrent edits to the same existing file are merge hazards, not harmless
parallelism.

## Boundaries

- A brand-new isolated MCP tool plus its new test belongs to `td-feature-build`.
- Any work that edits `td/`, bridge routes, `touchDesignerClient.ts`, or wire
  validators as one REST vertical slice belongs to `tdmcp-bridge-endpoint` and runs
  sequentially.
- Registry-only wiring of new tools belongs to `td-feature-integrate`.
- This skill owns existing product files only when the manifest grants an explicit
  lease. It never broadens that lease silently.

## Procedure

### 1. Re-establish reality

1. Confirm the requested worktree, branch, and HEAD.
2. Run `git status --short` and inspect diffs for every leased file.
3. Treat existing changes as another person's work unless the campaign artifact
   proves they belong to this feature. Preserve and reconcile; never overwrite.
4. Read the spec, the existing implementation, its nearest tests, and both sides
   of every boundary the change crosses.
5. Trace call sites before choosing the lease. Keep a consumer-only output change
   at that consumer; do not widen a shared helper or schema unless at least two
   consumers need the new contract or the spec explicitly makes it shared.

### 2. Baseline the slice

Run the smallest relevant existing test before editing. For TypeScript changes,
also confirm `npm run typecheck` is available. Record a pre-existing failure rather
than disguising it as an extension regression.

### 3. Implement the smallest coherent patch

- Edit only leased files and any newly created support/test files explicitly named
  in the spec.
- Preserve the public contract unless the spec deliberately versions it.
- Keep handlers fail-forward and return friendly `isError` results rather than
  throwing.
- Keep ESM `.js` imports, strict TypeScript, Biome style, and deterministic TD node
  placement.
- Reuse existing schemas, helpers, services, and result envelopes before adding a
  parallel abstraction.
- Prefer the narrowest contract owner. A convenient shared helper is not a reason
  to make unrelated callers inherit new fields or semantics.
- Do not stage, commit, push, tag, publish, deploy, or bump versions.

### 4. Test both sides of boundaries

At minimum, verify every changed producer and consumer together:

| Extension boundary | Producer | Consumer |
|---|---|---|
| Tool schema ↔ CLI | Zod schema/handler | `src/cli/agent.ts` command |
| LLM policy ↔ tool catalog | router/calibration | exposed tool set |
| Resource/prompt ↔ registry | export/definition | registration and caller |
| Runtime report ↔ test | real return shape | assertion/validator |
| Package manifest ↔ installer | owned files/version | reconcile/update/remove |

Add or strengthen focused tests for the changed behavior. Do not settle for an
import-only test or a cast that hides the runtime shape.

### 5. Verify the slice

Run, in this order:

1. focused Vitest/msw tests for the leased surface;
2. `./node_modules/.bin/biome check <changed-files>`;
3. `npm run typecheck`;
4. `npm run build`;
5. any domain suite named by the spec (recipes, bridge, CLI, OAuth, docs).

The integrator/QA later run the full repository gates. A focused failure must be
fixed before handoff; an unrelated project-wide failure must be recorded with
evidence.

### 6. Handoff

Write `_workspace/02_extend_<feature>.md` containing:

- leased and changed files;
- contract before/after;
- tests and exact results;
- shared schema/consumer notes for the integrator;
- probe-live items as `UNVERIFIED`, never inferred PASS;
- any overlap or follow-up risk.

Tell the integrator and QA which boundaries need cross-checking. On re-invocation,
read the prior report and apply feedback as a diff; do not rewrite a green patch.

## Error handling

| Situation | Response |
|---|---|
| Dirty leased file from unknown work | Stop that file, report overlap, continue only on disjoint leased files |
| Ownership collision discovered mid-build | Preserve both diffs; ask leader to serialize; do not resolve by discarding either side |
| Focused regression | Fix once; on repeat failure return precise blocker and leave the feature unshipped |
| Spec requires bridge route | Hand off to `tdmcp-bridge-engineer`; do not improvise `/api/exec` or a second route mechanism |
| Live TD unavailable | Complete offline tests, mark runtime checks `UNVERIFIED — pending bridge` |

## Test scenarios

### Normal extension

Input: extend `get_td_topology` in two existing files plus one focused test. The
manifest grants those paths, no active lease overlaps, baseline passes, the patch
adds deterministic order/cycle fields, focused test + Biome + typecheck pass, and
the handoff records the producer/consumer shape.

### Ownership collision

Input: source-backed DAT work leases `param_text_service.py`, but that file is dirty
from caller-code security hardening. The builder makes no edit to it, reports the
overlap, and returns `blocked-dep` rather than replacing or duplicating the WIP.

### Bridge reroute

Input: an extension needs a new `/api/chop-window` endpoint. The builder stops the
bridge portion and routes it to `tdmcp-bridge-engineer`, while retaining only any
disjoint Node-side policy work explicitly granted by the manifest.
