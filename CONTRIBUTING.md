# Contributing to tdmcp

Thanks for helping build AI-native tooling for TouchDesigner!

## Dev setup

```bash
npm install
npm run import:bottobot   # populate src/knowledge/data
npm run build
npm test
```

Before opening a PR, run the same core checks as CI:

```bash
npm run import:bottobot
npm run typecheck
npm run lint
npm run validate:recipes
npm run build
npm test
npm run build:mcpb
npm run test:bridge
```

`npm run docs:build`, `make complexity`, `npm run deps:check`, and
`npm run coverage:harness` are not required by the main CI workflow, but they are
the expected local checks for docs, architecture/complexity, and broad test
hardening work.

- **TypeScript** is ESM + strict; relative imports use `.js` extensions.
- **Biome** handles formatting and linting (`npm run format` to auto-fix).
- Every tool defines a Zod `inputSchema`, validates input, and never throws out of
  its handler — TD failures become friendly `isError` results.

## Adding a tool

Tools live in `src/tools/layer{1,2,3}/`. Each file exports an `…Impl(ctx, args)`
function (unit-testable with a mocked client) and a `register…` registrar, then is
added to that layer's `index.ts`. Layer 1 tools build inside a fresh container,
run an error check, and capture a preview via the helpers in
`src/tools/layer1/orchestration.ts`.

## Contributing a recipe

Recipes are JSON files in `recipes/` matching `RecipeSchema`
(`src/recipes/schema.ts`):

```bash
npm run validate:recipes
```

Each recipe lists `nodes` (named), `connections` (by node name), exposed
`parameters`, and optional `glsl_code` / `python_code` keyed by node name. A
parameter `value` that equals another node's name resolves to that node's path at
build time (handy for COMP references and feedback targets).

## Creative RAG sources: probe-live required

Every PR that adds or edits files under `src/creativeRag/sources/**` **must**
show a green `probe-live` CI check before merge. Mock-only tests are
insufficient: two past regressions — a Europeana API-key leak (the adapter
echoed the key inside `sourceUrl` query params) and a Rijksmuseum card-shape
drift (the `license` field silently changed type) — both passed mocks and
landed broken. The probe-live gate hit the real upstream and would have caught
both.

### Running locally

```bash
npx tsx scripts/probe-creative-source.ts <source-id>
# source-id: artic | cleveland | europeana | met | rijksmuseum | smithsonian | wikimedia

# With JSON output (good for CI log capture):
npx tsx scripts/probe-creative-source.ts europeana --json

# Limit items (default 3):
npx tsx scripts/probe-creative-source.ts rijksmuseum --limit=1
```

Set the required credential env vars first (e.g. `EUROPEANA_API_KEY`). A
`SourceSkippedError` (exit code 3) means the credential is missing — fix it
before running.

Exit codes:

| Code | Meaning |
|------|---------|
| 0 | Probe passed |
| 2 | Shape drift, redaction failure, or unknown source |
| 3 | Missing credential — NOT a pass |
| 4 | Upstream unreachable after retry |

### Escape hatch (sustained upstream outage)

Use the escape hatch only when the upstream has been verifiably unreachable for
**more than 24 hours** and is documented in the PR description.

Two conditions must **both** be satisfied:

1. A repo maintainer manually sets `TDMCP_PROBE_LIVE_SKIP=1` on the workflow
   run (via a dispatched re-run or repository variable).
2. The PR carries the label **`skip-probe-live`** — application is restricted
   to maintainers (CODEOWNERS / branch protection).

The PR description **must** contain a line:

```text
Probe-live skip reason: <explanation>
```

The workflow will reject the skip if this line is absent.

When both conditions are met, the workflow posts a sticky PR comment with the
actor name and reason so reviewers see the trail.

**Follow-up obligation:** open a tracking issue referencing the PR and re-run
`probe-live` against the fixed upstream within **7 days of merge**. The issue
title should be `probe-live follow-up: re-run for <source-id> after outage`.

### Rate limits

Rijksmuseum and Smithsonian have daily API caps. If your PR triggers many CI
re-runs in one day, run `probe-creative-source.ts` locally and ask a
maintainer to trigger the final CI run before merge.

### Branch-protection note

The `probe-live` required-status-check must be added to the `main` ruleset by
a repo admin after the workflow first runs green on a no-op PR. If you are a
maintainer landing the first probe-live PR, remember to add it.

## TouchDesigner bridge

The Python bridge is under `td/`. Keep all TD-global usage (`op`, `app`,
`project`) inside functions so the modules import cleanly, and run
`python3 -m py_compile` on changed files.
