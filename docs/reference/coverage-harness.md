# Coverage harness & gate

tdmcp tracks executable-TypeScript test coverage with a small harness on top of
Vitest's v8 coverage provider, and enforces a **no-regression floor** in CI.

## Scope

Coverage is measured over `src/**/*.ts` only. Generated knowledge data
(`src/knowledge/data/**`) is excluded — it is imported reference JSON, not
executable code, so it must never drive the numbers up or down. See
`vitest.config.ts` (`coverage.include` / `coverage.exclude`).

## Commands

| Command | What it does |
|---|---|
| `npm run test:coverage` | Raw Vitest coverage run; **fails if any threshold in `vitest.config.ts` is not met**. This is the gate. |
| `npm run coverage:harness` | Runs the coverage gate, then writes a ranked gap report to `_workspace/coverage/latest.md` and a machine-readable `coverage/coverage-summary.json`. |
| `npm run coverage:harness -- --summary-only` | Re-render the report from the existing `coverage/coverage-summary.json` without re-running the suite. |
| `npm run coverage:harness -- --limit=40 --min-lines=91` | Print more ranked gaps and **fail if line coverage drops below the requested floor** (use the +5pp target while a coverage wave is in flight). |

The report ranks files by a gap score
(`missing_lines*3 + missing_functions*2 + missing_branches`) and buckets the
top files into suggested test waves by surface (entrypoints/CLI/LLM,
resources/knowledge, prompts, tools, server/transport).

## The gate (G2)

The thresholds in `vitest.config.ts` are a **no-regression floor**: they are
locked at the measured baseline, floored to the integer at or below current
coverage. They must always PASS at current coverage and must never be lowered.

### Baseline (2026-06-21)

| Metric | Measured | Locked threshold |
|---|---:|---:|
| Statements | 84.71% | 84 |
| Branches | 70.73% | 70 |
| Functions | 83.02% | 83 |
| Lines | 86.6% | 86 |

CI runs `npm run test:coverage`, so any regression below these floors red-lights
the build. When a coverage wave raises the real numbers, **raise the thresholds
to the new floor** in the same change — that is how the gate ratchets up.

### Tracked +5pp target

The roadmap goal (`docs/ROADMAP.md` → "G2 — Test coverage") is **lines and
branches ≥ baseline + 5 pp**:

| Metric | Baseline | +5pp target |
|---|---:|---:|
| Lines | 86.6% | **≥ 91** |
| Branches | 70.73% | **≥ 75** |

This is the next coverage wave's objective. Drive a wave toward it with
`npm run coverage:harness -- --min-lines=91` (and the ranked gap list), then
ratchet the `vitest.config.ts` floors up as the numbers land. Branches is the
widest gap (70.73% → 75 is ~4.3 pp, roughly 800 uncovered branches), so it needs
the most new tests; lines (86.6% → 91 is ~4.4 pp, ~1,200 uncovered lines) follows
the same wave.
