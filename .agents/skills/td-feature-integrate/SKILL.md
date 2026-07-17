---
name: td-feature-integrate
description: "Converge new-tool, existing-surface extension, and bridge slices into tdmcp as the shared-file single writer; verify registry/CLI/docs/client coherence and a green typecheck + build without overwriting leased or dirty work."
---

# td-feature-integrate — single-writer wiring

You are the default single writer for convergence files. New-tool builders leave registries, CLI, and docs untouched; extension/bridge builders may edit existing files only under manifest leases. You converge all handoffs into a green tree without reimplementing leased work or overwriting dirty state.

## Procedure

1. **Re-verify state and leases first.** Read every design/build handoff, then run `git status` and inspect diffs for each convergence file. Stop on an ownership collision or unknown dirty work.
2. **Converge by mode.** Register and wire `new-tool` output; verify `extension` producer/consumer boundaries and add only the remaining shared wiring; verify `bridge` endpoint/client/validator/fallback registration without reopening its serial implementation slice. For every bridge slice, record the selected protection: matching `TDMCP_BRIDGE_TOKEN` on both sides and/or enforced `TDMCP_BRIDGE_ALLOW_EXEC=0`. If runtime is offline, verify the code/config contract and record runtime enforcement as `UNVERIFIED` rather than claiming it was observed.
3. **Respect reserved convergence files.** Layer indexes, `src/tools/index.ts`, `src/cli/agent.ts`, generated-doc inputs, and other wave-wide registries stay with the integrator unless the manifest explicitly transfers a serial lease. An explicit transfer must be recorded in `_workspace/03_integrate.md`.
4. **Add or verify CLI coherence.** CLI maps 1:1 onto handlers — command names, params, types, defaults, and safety annotations must match the implementation schema.
5. **Docs regenerate — don't hand-edit.** `docs/reference/tools.md` is generated from the live registry. Confirm extension and bridge behavior is represented by the correct source docs; never patch generated output manually.
6. **Confirm green.** Run `npm run typecheck` and `npm run build`; when any `td/**/*.py` changed, run `python3 -m py_compile` on every changed Python file. All required gates must pass with every non-quarantined intended wave slice present. Record compile results plus each omitted quarantined slice and blocker in `_workspace/03_integrate.md`.

## Conflict-safe editing — non-negotiable

- **Edit additively.** Insert the new registrar/command; don't reorder or reformat unrelated entries. Reviewable diffs = no merge pain.
- **Stage by explicit path.** When staging, `git add <specific files>` — **never `git add -A` / `git add .`**. Parallel agents' in-flight files (and secrets) must not be swept in. This rule has bitten this repo before.
- **Don't overwrite changes you didn't make.** If a shared file has uncommitted edits that aren't yours, reconcile or flag to the leader — it's likely a concurrent agent's work, not stale cruft.
- **Don't absorb implementation leases silently.** If an extension or bridge handoff is incomplete, return a precise fix request to its owner. The integrator edits leased implementation only when the leader explicitly reassigns that lease.
- Lint with `./node_modules/.bin/biome check .` directly (not `npm run lint` — RTK proxy false error).

## Staleness to flag for QA

A connected `mcp__tdmcp__*` server runs the **previous build** until restarted. After your `npm run build`, the live MCP tools still won't reflect the new code until the server restarts — tell QA so they restart (or validate via the agent CLI / bridge) before concluding a new tool is broken.

## Error handling

- If the build breaks, bisect to the offending feature: integrate the rest when dependencies allow, quarantine that slice, and send its routed builder a precise `file:line` fix request. Don't block the whole batch on one independent failure.
- If two builders exported colliding symbol names or targeted the same index position, get them disambiguated before wiring.
- If ownership overlaps or a leased path has unknown dirty work, do not merge through it; serialize or block the affected slice in the ledger.

## Output

Updated convergence files; a summary at `_workspace/03_integrate.md` listing build mode, ownership lease, every shared file touched, every registrar/CLI/bridge boundary added or verified, transferred leases, quarantined slices, and the `npm run typecheck` + `npm run build` results. Then message `td-qa` what to validate, plus the restart-for-staleness reminder.
