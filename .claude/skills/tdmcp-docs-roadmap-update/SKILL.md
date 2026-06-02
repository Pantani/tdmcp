---
name: tdmcp-docs-roadmap-update
description: >
  Updates tdmcp docs and roadmap for newly shipped or newly merged capabilities.
  Use when asked to atualizar docs, atualizar roadmap/rodamap, reconcile release
  docs, document new features, sync docs with CHANGELOG/package release, refresh
  cookbook examples after a feature wave, re-run/continue/fix a docs-roadmap pass,
  or check whether docs/ROADMAP.md is current. Runs a sub-agent workflow:
  release audit -> roadmap/docs edit + cookbook sync -> QA.
---

# tdmcp-docs-roadmap-update

Updates the repo's documentation surfaces after feature waves or releases:
`docs/ROADMAP.md`, high-level docs named by the audit, EN/PT prompt cookbooks,
and generated reference docs.

**Execution mode:** sub-agents. This environment does not use `TeamCreate`;
spawn the role agents defined in `.claude/agents/` and coordinate them from the
main session.

## Phase 0: Context Check

Before spawning agents:

1. Inspect `git status --short`.
2. Check whether `_workspace/docs_release_audit.md`,
   `_workspace/roadmap_docs_update.md`, `_workspace/cookbook_sync_update.md`, or
   `_workspace/docs_roadmap_qa.md` already exist.
3. Decide execution mode:
   - no prior workspace files -> full run;
   - prior files + user says update/re-run/continue -> refresh only affected
     phases;
   - prior files + new release/tag/feature input -> refresh audit first, then
     re-run writers.

Preserve unrelated local changes. Do not reset or revert user edits.

## Phase 1: Release And Feature Audit

Spawn `docs-release-auditor`:

```text
Read .claude/agents/docs-release-auditor.md and execute it.
Audit current local package, CHANGELOG, ROADMAP, README, cookbook docs,
CLI/resource surfaces, generated docs, npm package version, GitHub releases, and
tags. Write _workspace/docs_release_audit.md.
```

The audit is mandatory whenever release wording, tool counts, or "latest"
features are involved.

## Phase 2: Docs Writing

After `_workspace/docs_release_audit.md` exists, spawn these agents in parallel
when their write sets are both needed:

**Roadmap/docs editor**

```text
Read .claude/agents/roadmap-docs-editor.md and execute it.
Use _workspace/docs_release_audit.md. Update docs/ROADMAP.md and any high-level
docs named by the audit. Do not edit generated docs or cookbook files. Write
_workspace/roadmap_docs_update.md.
```

**Cookbook sync**

```text
Read .claude/agents/docs-cookbook-sync.md and execute it.
Use _workspace/docs_release_audit.md and _workspace/roadmap_docs_update.md if it
exists. Update docs/guide/prompt-cookbook.md and docs/pt/guide/prompt-cookbook.md
for docs-worthy new features, keeping locales in parity. Write
_workspace/cookbook_sync_update.md.
```

If only roadmap docs or only cookbook docs are affected, run only the relevant
writer.

## Phase 3: Generated Docs And QA

Run the docs generation/build gate from the main session:

```bash
npm run docs:build
npm run validate:recipes
git diff --check
```

Then spawn `docs-roadmap-qa`:

```text
Read .claude/agents/docs-roadmap-qa.md and execute it.
Use the release audit and writer summaries. Verify release claims, EN/PT parity,
generated docs behavior, VitePress media embeds, and command outcomes. Write
_workspace/docs_roadmap_qa.md.
```

If QA finds narrow issues, fix them in the main session or re-run only the
responsible writer.

## Data Flow

- Auditor writes `_workspace/docs_release_audit.md`.
- Roadmap editor writes `_workspace/roadmap_docs_update.md`.
- Cookbook sync writes `_workspace/cookbook_sync_update.md`.
- QA writes `_workspace/docs_roadmap_qa.md`.
- Final docs edits remain in normal repo files.

## Quality Rules

- Verify live release state before claiming a public version is current.
- Keep public release, local `HEAD`, and planned backlog distinct.
- Never hand-edit generated `docs/reference/tools.md`.
- Keep EN/PT cookbook examples in parity.
- Use `withBase('/examples/...')` for VitePress video embeds.
- Treat missing media assets as description-only or explicit follow-up, not as
  silent broken links.

## Test Scenarios

**Normal flow:** a new release lands. Audit confirms package/npm/GitHub agree,
roadmap is updated with shipped and remaining work, cookbook gets matching EN/PT
entries, `npm run docs:build`, `npm run validate:recipes`, and
`git diff --check` pass.

**Error flow:** npm or GitHub release checks fail. Auditor marks release state
unverified; writers avoid definitive public-release claims; QA records residual
risk and asks for a retry or human release confirmation.
