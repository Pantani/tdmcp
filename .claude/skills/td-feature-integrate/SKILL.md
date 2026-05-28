---
name: td-feature-integrate
description: "Wire builders' isolated tdmcp tool files into the shared registries, CLI, and docs as a single writer, conflict-safe, and confirm a green typecheck + build. Use when integrating/wiring/registering new tdmcp tools, adding their CLI commands, resolving build breaks after parallel feature work, or merging several builders' files into the registry without conflicts."
---

# td-feature-integrate — single-writer wiring

You are the one agent that edits shared files. Builders left the registry, CLI, and docs untouched so they could run in parallel; you converge their work into a green, fully-wired tree. Do it additively and conflict-safe.

## Procedure

1. **Re-verify state first.** This branch may have concurrent agents. Run `git status` and `git diff` on the shared files you're about to edit; understand what's already in flight before changing anything.
2. **Register each tool.** Add the builder's `register…` to its layer array in `src/tools/layer<N>/index.ts`. Confirm `src/tools/index.ts` aggregates all layer arrays (it usually already does — verify, don't duplicate).
3. **Add the CLI command** in `src/cli/agent.ts`. The CLI maps 1:1 onto a tool handler — match the command name and `--params` surface to the tool's schema so QA's tool↔CLI check passes.
4. **Docs regenerate — don't hand-edit.** `docs/reference/tools.md` is produced by `scripts/gen-tool-docs.ts` from the live registry on every docs build. Never edit it by hand; just confirm the new tool appears after a regen.
5. **Confirm green.** Run `npm run typecheck` and `npm run build`. Both must pass with every new tool registered and every new CLI command present.

## Conflict-safe editing — non-negotiable

- **Edit additively.** Insert the new registrar/command; don't reorder or reformat unrelated entries. Reviewable diffs = no merge pain.
- **Stage by explicit path.** When staging, `git add <specific files>` — **never `git add -A` / `git add .`**. Parallel agents' in-flight files (and secrets) must not be swept in. This rule has bitten this repo before.
- **Don't overwrite changes you didn't make.** If a shared file has uncommitted edits that aren't yours, reconcile or flag to the leader — it's likely a concurrent agent's work, not stale cruft.
- Lint with `./node_modules/.bin/biome check .` directly (not `npm run lint` — RTK proxy false error).

## Staleness to flag for QA

A connected `mcp__tdmcp__*` server runs the **previous build** until restarted. After your `npm run build`, the live MCP tools still won't reflect the new code until the server restarts — tell QA so they restart (or validate via the agent CLI / bridge) before concluding a new tool is broken.

## Error handling

- If the build breaks, bisect to the offending feature: wire the rest, leave that one unregistered, and send its builder a precise `file:line` fix request. Don't block the whole batch on one bad file.
- If two builders exported colliding symbol names or targeted the same index position, get them disambiguated before wiring.

## Output

Updated `index.ts` / `agent.ts`; a wiring summary at `_workspace/03_integrate.md` listing every shared file touched, every registrar + CLI command added, and the `npm run typecheck` + `npm run build` results. Then message `td-qa` the list of newly wired tools + CLI commands to validate, plus the restart-for-staleness reminder.
