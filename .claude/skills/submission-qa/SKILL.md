---
name: submission-qa
description: Verification methodology and gate checklist for the tdmcp Connectors Directory submission — run the docs build, build and inspect the .mcpb bundle, sweep for stale .dxt references, and cross-check the form-answer draft against the real requirements. Use to validate the submission package before a human submits, by executing commands and quoting evidence, not by trusting that work was done.
---

# Submission QA — verify by executing

The cost of a miss is a ~2-week rejection cycle. So every gate is checked by
**running something and quoting the output**, never by reading a builder's claim.
"Looks complete" is not a result; a command transcript is.

## Gate checklist

Produce a table `gate | PASS/FAIL | evidence`. Gates:

| Gate | How to verify |
|------|---------------|
| Privacy page exists + linked | Open the page file(s); confirm the nav entry in `docs/.vitepress/config.ts` points to its clean URL. Confirm the page actually states the data-handling story (not a stub). |
| Docs build | `npm run docs:build` exits 0. VitePress fails on dead internal links, so this also catches a bad nav link. |
| Bundle builds | `npm run build` then `npm run build:mcpb` (or the renamed script). Confirm `tdmcp.mcpb` is emitted. |
| Bundle is valid | `unzip -l tdmcp.mcpb` shows `manifest.json` at root + `dist/`. If `npx --yes @anthropic-ai/mcpb validate` exists, run it on the manifest and capture the result. |
| No stale refs | `grep -rn "\.dxt\|build:dxt" docs/ scripts/ README.md package.json .github/ 2>/dev/null` (exclude `dist/`, `node_modules/`). Every hit must be an intentional legacy note. |
| Annotations intact | `grep -rEo "readOnlyHint|destructiveHint" src/tools | wc -l` is non-zero and matches expectation; spot-check a read tool has no `destructiveHint` and a write tool does. (#1 rejection cause — confirm no regression.) |
| Form completeness | Every field in `00_submission-spec.md`'s field map has an answer in `02_form-answers.md` or an explicit `NEEDS HUMAN INPUT`. List the human inputs. |
| Manifest sane | `node -e "JSON.parse(require('fs').readFileSync('dxt/manifest.json'))"` parses; `manifest_version`, `name`, `version`, `server.entry_point` present. |

## Report format

Write `_workspace/03_qa-report.md`:
1. **Gate table** (above) with command output as evidence.
2. **Blocking issues** — anything FAIL. Each with the exact file:line or command
   and what the owner (docs-author / bundle-engineer) must change.
3. **Non-blocking nits** — cosmetic / nice-to-have.
4. **Needs human before submit** — every `NEEDS HUMAN INPUT` (support email,
   privacy contact, test account, new release to publish the `.mcpb` asset).

## Principles

- You need to **run scripts**, so operate with `general-purpose` capability, not a
  read-only profile.
- **Incremental:** when a gate fails, report it precisely and (on re-run)
  re-execute only the affected check rather than the whole suite.
- **Don't fix.** Independent verification is your value — hand fixes back to the
  owning agent. If you fix and verify your own fix, the check is no longer
  independent.
- **Cross the boundary.** The high-value check isn't "does the file exist" — it's
  "does the form answer match what the page/manifest/repo actually says". E.g.
  the privacy URL in `02_form-answers.md` must resolve to the page docs-author
  actually created; the tool list in the form must match `src/tools/**`.
