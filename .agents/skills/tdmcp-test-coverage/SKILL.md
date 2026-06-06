---
name: tdmcp-test-coverage
description: "Orchestrate any tdmcp test-coverage work: run the coverage harness, inspect coverage gaps, plan focused Vitest/msw or bridge tests, delegate coverage writers, verify coverage deltas, and re-run gates. Use whenever the user asks to raise coverage, add broad regression coverage, create a test harness, improve tests, re-run a coverage wave, or fix a coverage gate."
---

# tdmcp-test-coverage

Use this skill for coverage-improvement work in this repository. The goal is
more tested behavior, not prettier percentages.

## Phase 0 - Context

1. Read `AGENTS.md`, `package.json`, `vitest.config.ts`, and the nearest tests.
2. Run `npm run coverage:harness` unless the user asked for a static-only pass.
3. Read `_workspace/coverage/latest.md`.
4. Treat the actionable scope as `src/**/*.ts`; `src/knowledge/data/**` is
   generated reference data and is intentionally excluded.

## Phase 1 - Select gaps

Choose one to three independent gaps. Prefer seams where a test can lock a real
contract:

- CLI/config: parsing, defaulting, env precedence, diagnostics, and exit behavior.
- Resource/knowledge loaders: URI matching, malformed input, ranking, and stable
  result shape.
- Tool implementations: Zod defaults, bridge payloads, warnings, and `isError`
  paths using msw.
- Server/client boundaries: offline TD behavior, auth forwarding, timeout/retry,
  event streaming, and transport setup.

Skip generated data, docs-only files, and import-only tests.

## Phase 2 - Build tests

For parallel work, spawn `tdmcp-coverage-writer` agents with one seam each. Give
each writer:

- target file(s) and nearest existing test to mirror;
- behavior to assert;
- expected failure mode or branch to cover;
- exact narrow command to run.

The lead is the single writer for shared config, package scripts, and harness
docs. Do not let multiple agents edit the same test file.

## Phase 3 - Verify

Run narrow tests first. Then run:

```bash
npm run typecheck
npm run build
./node_modules/.bin/biome check .
npm run coverage:harness
npm run validate:recipes
npm run test:bridge
```

If a gate fails, fix forward. Do not lower coverage thresholds, delete assertions,
or exclude executable code to pass.

## Phase 4 - Report

Write `_workspace/coverage/wave-<date>.md` with:

- starting and ending coverage summary;
- tests added and behaviors covered;
- commands run;
- PASS/FAIL/UNVERIFIED buckets;
- next suggested gaps from `_workspace/coverage/latest.md`.

## Test scenarios

- Normal flow: coverage harness identifies `src/cli/chat.ts`; writer adds focused
  CLI behavior tests; lead runs coverage and gates; report includes delta.
- Error flow: a new test exposes a production bug; report the failing behavior,
  patch the smallest safe code path, keep the regression test, and re-run gates.
