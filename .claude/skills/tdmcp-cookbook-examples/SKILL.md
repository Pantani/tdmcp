---
name: tdmcp-cookbook-examples
description: >
  Adds new visual examples to the tdmcp prompt cookbook documentation — both the
  English and Portuguese versions. Use when asked to: add more cookbook examples,
  create visual examples for the docs, show more surprising things you can do,
  add entries to the prompt cookbook, expand the cookbook, or any
  request to extend the cookbook with new prompts and results. Runs a 3-phase
  pipeline: curate candidates → write EN → write PT.
---

# tdmcp-cookbook-examples

Adds new, visually impressive examples to `docs/guide/prompt-cookbook.md` (EN)
and `docs/pt/guide/prompt-cookbook.md` (PT).

**Execution mode:** sub-agents (sequential curation → parallel EN+PT writing).

## Phase 0: context check

Before doing anything, check:
- Does `_workspace/cookbook_candidates.md` already exist?
  - YES + the user asked to "re-run" or "update" → skip curation, reuse candidates.
  - YES + user gave new direction → rename old to `_workspace/cookbook_candidates_prev.md`, re-curate.
  - NO → proceed with full Phase 1.

## Phase 1: curate

Spawn the `cookbook-curator` agent with this prompt:

```
Read the task description in .claude/agents/cookbook-curator.md and execute it.
Survey src/tools/layer1/index.ts, src/tools/layer2/index.ts, recipes/*.json,
docs/ROADMAP.md, CHANGELOG.md, and docs/guide/prompt-cookbook.md.
Produce _workspace/cookbook_candidates.md with 15-20 new cookbook candidates.
```

Wait for it to finish before continuing.

## Phase 2: write (parallel)

Once `_workspace/cookbook_candidates.md` exists, spawn two writer agents **in parallel**:

**EN writer:**
```
Read .claude/agents/cookbook-writer.md for your role and format rules.
Language: English.
Target file: docs/guide/prompt-cookbook.md
Candidates: _workspace/cookbook_candidates.md
Add all candidates marked for EN to the target file, following the exact format.
Write a summary to _workspace/cookbook_write_en.md when done.
```

**PT writer:**
```
Read .claude/agents/cookbook-writer.md for your role and format rules.
Language: Brazilian Portuguese.
Target file: docs/pt/guide/prompt-cookbook.md
Candidates: _workspace/cookbook_candidates.md
Add all candidates to the target file, translating from the EN prompts in the
candidates file. Match the existing PT file's voice and format.
Write a summary to _workspace/cookbook_write_pt.md when done.
```

## Phase 3: QA

After both writers finish, do a quick consistency check:

1. Count entries in EN file vs PT file — the number of new entries should match.
2. Spot-check 3 random new entries: verify the tool name in the result-description
   exists in `src/tools/layer1/index.ts` or `src/tools/layer2/index.ts`.
3. Check no media reference (`/examples/SLUG.mp4` or `.png`) points to a file that
   already exists in `docs/public/examples/` under a conflicting name.
4. Verify both files still start with valid YAML frontmatter.

If any check fails, note it in `_workspace/cookbook_qa.md` with what needs fixing.
Do not auto-fix — report to the user.

## Final report to the user

After all phases complete, summarize:
- How many new entries were added and to which sections
- Any new sections that were created
- QA issues (if any), with the file path to fix
- A note that media files (`.mp4` / `.png`) referenced in new entries don't exist
  yet — the user should capture them from TD and drop them in `docs/public/examples/`
  (or leave the entries as description-only; the cookbook already has many without media)

## Re-run behavior

If candidates and writer summaries already exist and the user wants to add more:
- Read the existing `_workspace/cookbook_candidates.md`
- Identify what was already written (from the summary files)
- Curate only for the gaps the user specifies, appending to the candidates file
- Re-run only the affected writers
