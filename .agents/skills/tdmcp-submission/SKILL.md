---
name: tdmcp-submission
description: Orchestrates the tdmcp Anthropic Connectors Directory (Desktop Extension / MCPB) submission prep — designs the package, writes the privacy page, migrates .dxt→.mcpb, drafts all form answers, and QAs the result. Use for ANY work on the tdmcp directory/marketplace submission, including re-runs after a rejection ("update the submission", "redo the form answers", "re-migrate the bundle", "fix the privacy page", "the directory rejected us"). Drives a 4-agent pipeline (architect → docs-author ∥ bundle-engineer → QA).
---

# tdmcp submission orchestrator

Coordinates four agents to prepare (and re-prepare) tdmcp's submission to the
Anthropic Connectors Directory via the **Desktop Extension (MCPB)** path. Defines
*who works when*; each agent's skill defines *how*.

## Execution mode — sub-agents (this environment has no TeamCreate)

`TeamCreate`/`SendMessage` are **not available** here, so run agents as
sub-agents with the `Agent` tool. For every agent:
- `subagent_type: "general-purpose"`, `model: "opus"`.
- Prompt MUST tell it to **read its definition file** `.Codex/agents/<name>.md`
  and its required skill(s) first, then do the task. The definition file is the
  source of truth (reusable next session); the prompt just points at it + passes
  the task and the relevant `_workspace/` paths.
- Parallelize independent agents by sending multiple `Agent` calls in one message
  (or `run_in_background: true`).

## Data passing — file-based via `_workspace/`

Create `_workspace/` at the repo root for inter-agent artifacts:
- `00_submission-spec.md` — architect → everyone
- `01_migration-notes.md` — bundle-engineer → QA/human
- `02_form-answers.md` — docs-author → QA/human (paste-ready form draft)
- `03_qa-report.md` — QA → human

Final deliverables (privacy page, edited repo files, `tdmcp.mcpb`) land in the
repo proper. `_workspace/` is preserved for audit / re-runs.

## Phase 0: context check (initial vs re-run)

1. If `_workspace/` is absent → **initial run**: full pipeline below.
2. If `_workspace/` exists and the user asks to fix/update one part → **partial
   re-run**: re-invoke only the affected agent(s), pass the prior artifacts +
   the new feedback (e.g. a directory rejection reason). E.g. "privacy page
   rejected" → docs-author only, then QA.
3. If `_workspace/` exists and the user gives fresh inputs → move it to
   `_workspace_prev/` and start a new initial run.

## Pipeline (initial run)

1. **architect** (solo, first). Produces `00_submission-spec.md`. Everything
   downstream depends on it — do not parallelize anything before it finishes.
2. **docs-author ∥ bundle-engineer** (parallel — disjoint file sets):
   - docs-author owns: privacy page(s), `config.ts` nav additions,
     `02_form-answers.md`. (Prose lane.)
   - bundle-engineer owns: `dxt/manifest.json`, `scripts/build-dxt.mjs`,
     `package.json` scripts, `scripts/setup.mjs`, `.dxt`→`.mcpb` text sweep in
     existing docs, `.github/` release workflow, `01_migration-notes.md`. (Code
     lane.)
   - They never edit the same file — that's why they can run together safely.
3. **submission-qa** (solo, last). Runs builds + checks, writes
   `03_qa-report.md`. If it reports blocking issues, loop back to the owning
   agent (partial re-run), then re-run QA on the affected checks.

## Error handling

- An agent failing once → retry once with the failure context. Still failing →
  proceed and record the gap in the final summary; never silently drop it.
- Never bypass a failing gate (`--no-verify`, deleting a check). A red QA gate is
  the signal to fix, not to suppress.
- Conflicting facts (e.g. spec says manifest_version X, packer wants Y) → trust
  the live tool/repo, and have the architect update the spec rather than forcing
  the stale value.

## After the run

Summarize to the user (in Portuguese): what changed in the repo, the contents of
`02_form-answers.md` and the QA verdict, and the explicit **Needs human before
submit** list (support email, privacy contact, cutting a new release so the
`.mcpb` asset exists, and the actual form click — which only the user can do).
Then offer to address any QA nits or feedback.

## Test scenarios

- **Happy path:** no `_workspace/` → architect spec → privacy page + form draft +
  `.mcpb` migration → `npm run docs:build` and `build:mcpb` pass → QA all-PASS
  except human-input items → summary lists those items.
- **Rejection re-run:** user says "directory rejected: privacy policy incomplete"
  → Phase 0 detects existing `_workspace/` → re-invoke docs-author with that
  feedback → QA re-checks the privacy gate only → updated summary.
