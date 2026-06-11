---
name: tdmcp-quality-audit
description: "Run or maintain the full tdmcp repo quality-audit team: command sweeps, all package/Makefile/CI gates, security review, usability/flow review, refactor/test-gap analysis, coverage hardening, QA, and follow-up fix waves. Use whenever the user asks for a complete audit, improve repo/code quality, test all commands, find security/usability failures, refactor debt, add missing tests, re-run the audit, continue a previous quality wave, or verify the repo is ready."
---

# tdmcp-quality-audit

Use this skill for broad repository quality campaigns. It coordinates existing
tdmcp specialists instead of replacing them: `tdmcp-test-coverage` handles focused
coverage waves, and `td-feature-qa` handles tool/CLI/docs/bridge boundary QA.

## Execution mode: hybrid fan-out/fan-in

This environment runs coordinated sub-agents rather than `TeamCreate`. Spawn the
independent auditors in parallel, then fan their reports into one lead-owned plan.
Implementation happens in small waves after QA verifies the findings.

## Agent roster

| Agent | Focus | Output |
|---|---|---|
| `tdmcp-quality-audit-lead` | scope, orchestration, shared edits, wave plan | `_workspace/quality-audit/00_scope.md`, `05_plan.md` |
| `tdmcp-command-auditor` | scripts, Makefile, CI, CLI command health | `_workspace/quality-audit/01_commands.md` |
| `tdmcp-security-auditor` | trust boundaries, raw Python, env redaction, package safety | `_workspace/quality-audit/02_security.md` |
| `tdmcp-ux-flow-auditor` | first-run, docs-to-command parity, CLI help/errors | `_workspace/quality-audit/03_usability.md` |
| `tdmcp-refactor-test-auditor` | coverage gaps, weak tests, complexity, refactor seams | `_workspace/quality-audit/04_refactor_tests.md` |
| `tdmcp-quality-qa` | verifies evidence and first patch wave | `_workspace/quality-audit/06_qa.md` |

## Phase 0 - Context check

1. Read `AGENTS.md`, `CLAUDE.md`, `package.json`, `Makefile`,
   `.github/workflows/*.yml`, `vitest.config.ts`, and existing
   `_workspace/quality-audit/` reports.
2. Decide run mode:
   - no quality workspace: fresh audit;
   - existing reports + user asks to continue/fix/re-run: partial re-run;
   - new broad request: archive prior reports under
     `_workspace/quality-audit/archive/<timestamp>/` before a fresh audit.
3. Check git status. Do not revert unrelated user changes.

## Phase 1 - Scope and command policy

Create `_workspace/quality-audit/00_scope.md` with:

- requested scope;
- current branch and dirty-state summary;
- commands that are safe one-shot;
- commands requiring timeout;
- commands requiring TouchDesigner, hardware, network, or credentials;
- commands that are publish/destructive and must not run without explicit user
  approval.

Command policy:

- Select the command runner before executing gates:
  - if `command -v rtk >/dev/null 2>&1` succeeds, use `rtk` for shell commands
    and follow local repo instructions such as `rtk proxy zsh -lc` for pipelines
    or shell control flow;
  - if `rtk` is unavailable, record that fallback in `00_scope.md` and run the
    same commands through the normal shell/Codex exec path without failing the
    audit solely because the wrapper is missing.
- Safe baseline: `npm run typecheck`, `npm run build`, `./node_modules/.bin/biome
  check .`, `npm test`, `npm run validate:recipes`, `npm run test:bridge`,
  `npm run docs:build`, `make complexity`, `npm run deps:check`,
  `npm run coverage:harness`.
- Classify before running: `dev`, `start`, `docs:dev`, `docs:preview`,
  `smoke:live`, `docs:clips`, `import:bottobot`, `prepublishOnly`,
  `npm publish`, tag/push/version commands, and any server command.
- Long-running commands need timeout, readiness probe, and cleanup.
- TouchDesigner and hardware commands are UNVERIFIED when the bridge/device is
  unavailable; they are not failures by themselves.

## Phase 2 - Parallel audit

Spawn the four auditors in parallel:

1. `tdmcp-command-auditor`
2. `tdmcp-security-auditor`
3. `tdmcp-ux-flow-auditor`
4. `tdmcp-refactor-test-auditor`

Each report must use PASS / FAIL / UNVERIFIED buckets and include file:line or
command evidence. Avoid generic recommendations that cannot become a patch or a
test.

## Phase 3 - Synthesis

The lead reads all reports and writes `_workspace/quality-audit/05_plan.md`:

- deduped findings;
- severity and confidence;
- first safe patch wave;
- deferred items requiring TD, hardware, network, or user credentials;
- suggested tests and exact commands;
- owner for each item.

Patch waves should be small:

- Wave A: regression tests for concrete security/CLI/tool behavior.
- Wave B: behavior-preserving refactors guarded by tests.
- Wave C: command/CI/docs harness improvements.
- Wave D: live TouchDesigner/hardware verification.

## Phase 4 - QA before edits

Run `tdmcp-quality-qa` against the reports. It must reject:

- claims without evidence;
- command passes with no command output;
- weakened test thresholds;
- broad rewrites without failing tests or measurable risk;
- unverified live checks reported as passing.

## Phase 5 - Implement a wave

Only after QA, implement the smallest useful wave. For coverage-heavy work, invoke
`tdmcp-test-coverage` and keep writers on disjoint test files. For boundary
quality issues, invoke `td-feature-qa`. After edits, run narrow tests first, then
the relevant gates from Phase 1.

## Phase 6 - Final report

Update `_workspace/quality-audit/06_qa.md` with final command results and report:

- what was fixed;
- what was tested;
- what remains FAIL;
- what remains UNVERIFIED and why;
- next wave recommendation.

## Error handling

- Retry deterministic local command failures once after checking dependencies.
- If dependencies are missing, run `npm ci` only when appropriate for the checkout
  and record that it was required.
- If generated files change from docs/build commands, inspect the diff before
  keeping it.
- Do not run publish, tag, push, credential, destructive, or hardware-control
  commands without explicit approval.

## Test scenarios

Normal flow: user asks for a complete quality audit. The lead creates
`00_scope.md`, four auditors run in parallel, QA verifies evidence, Wave A adds
two CLI/config security regression tests, and gates pass. The final report keeps
TouchDesigner live smoke as UNVERIFIED if the bridge is offline.

Error flow: `docs:build` regenerates `docs/reference/tools.md` and fails because a
tool schema is broken. The command auditor records FAIL, the lead routes the
boundary to `td-feature-qa`, a focused test locks the schema behavior, docs build
is re-run, and the final report names the fixed file and command.
