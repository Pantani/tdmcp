# Wave 2 — F1 MVP (single-source) · Report

**Status:** SHIPPED (6/8 F1 features; 2 deferred per user scope).
**Checkpoint reached. Do not start F2 without go-ahead.**

## What landed

First real source for Project RAG: the `github-repo` adapter, seeded by
default with **`torinmb/mediapipe-touchdesigner` (MIT)**. End-to-end
`sync → index → search` over the local JSONL store works, with mandatory
provenance + license on every persisted card and a license-gated binary
download (`.tox`/`.toe`) that respects `licensePolicy.shouldStoreProjectBinary`.

## F1 scope vs. user direction

The original F1 plan listed three P0 sources (`derivative-local`,
`github-repo:torinmb/...`, `github-repo:DBraun/...`) plus a `toeExpand`
subprocess extractor. The user scoped this wave to **only the
torinmb/mediapipe-touchdesigner source via GitHub API**. The two unrelated
items are marked `deferred` in the ledger (not lost — re-scheduled when
needed):

- `prag_source_derivative_local` → deferred (no local TD install path this wave).
- `prag_toe_expand_extractor` → deferred (no static `.toe`/`.tox` walker — F1
  ingests README + filenames, sufficient for the MVP search).

## Files created

**Production (`src/projectRag/`):**

- `/Users/pantani/Desktop/projects/art/tdmcp/src/projectRag/sources/types.ts` — `SourceAdapter`, `RawProjectItem`, `SourceAdapterContext`.
- `/Users/pantani/Desktop/projects/art/tdmcp/src/projectRag/sources/errors.ts` — `SourceSkippedError` (rate-limit / no-config typed skip).
- `/Users/pantani/Desktop/projects/art/tdmcp/src/projectRag/sources/githubRepo.ts` — adapter (metadata + license + README + top-level `.tox`/`.toe` listing), repo-spec parser, default seed.
- `/Users/pantani/Desktop/projects/art/tdmcp/src/projectRag/sources/index.ts` — `resolveProjectSources(opts)`.
- `/Users/pantani/Desktop/projects/art/tdmcp/src/projectRag/extractors/githubLicense.ts` — GitHub License API (`GET /repos/{owner}/{repo}/license`), SPDX→`ProjectRagLicense`, 404/403 degrade to `Unknown`.
- `/Users/pantani/Desktop/projects/art/tdmcp/src/projectRag/scoring.ts` — composite `technical/license/freshness/reliability` formula.

**Tests (`tests/unit/projectRag/`, 24 new cases, msw-mocked):**

- `/Users/pantani/Desktop/projects/art/tdmcp/tests/unit/projectRag/githubLicense.test.ts` — SPDX mapping, 404/403 graceful, Authorization header forwarding (7 cases).
- `/Users/pantani/Desktop/projects/art/tdmcp/tests/unit/projectRag/githubRepo.test.ts` — spec parser, CSV env parser, full-metadata happy path, rate-limit→`SourceSkippedError`, ghToken header, unknown-license fallback (12 cases).
- `/Users/pantani/Desktop/projects/art/tdmcp/tests/unit/projectRag/serviceF1.test.ts` — end-to-end sync→index→search with mock embedder, license-allowlist gate (binary skip), re-sync idempotence, on-disk card shape (5 cases).

## Files extended (single-writer, additive)

- `src/projectRag/service.ts` — F0 skeleton replaced with full pipeline (source loop, license-gated binary download with sha256, embed-cache, cosine search).
- `src/projectRag/types.ts` — added `ProjectRagConfig.githubReposCsv?`.
- `src/projectRag/cardParser.ts` — `binaryPath`/`binaryHash`/`previewPath` removed from `canonicalForHash` so a binary download never triggers a spurious re-embed.
- `src/projectRag/index.ts` — barrel exports for new modules (scoring, sources, githubLicense).
- `src/utils/config.ts` — `projectRagGithubRepos` field + env mapping (`TDMCP_PROJECT_RAG_GITHUB_REPOS`).
- `src/cli/agent.ts` — `ENV_NAMES.projectRagGithubRepos`.
- `src/projectRag/cli.ts` — `toProjectRagConfig` propagates the new CSV into `ProjectRagConfig`.
- `tests/unit/projectRag/service.test.ts` — F0 cases updated for the F1 `github-repo: ready` status (kept offline via injected `sources: []` + no-op embeddings).
- `docs/PROJECT_RAG.md` + `docs/pt/PROJECT_RAG.md` — full "First source" section with example session, rate-limit/token guidance, and card-shape reference.
- `CHANGELOG.md` — Unreleased entry "Project RAG — MVP first source (F1)".

## Gates (all green)

```
typecheck       : PASS
build           : PASS
biome check .   : PASS (0 errors, 1 unrelated warning)
vitest          : PASS — 4271/4271 (+24 vs F0 baseline 4247)
validate:recipes: PASS — 32/32
test:bridge     : PASS — 196/196
```

TD live validation: **NOT required for F1** (offline-only; search path never
touches the bridge). Ollama is **not required for tests** — the F1 service
test injects a deterministic mock embedder.

## Hard rules verified

- The search path never imports `touchDesignerClient` — grep across
  `src/projectRag/**` stays clean. (F3 bridge-quarantine analyzer remains off
  by default and lives in a separate, not-yet-shipped extractor.)
- Downloaded `.toe`/`.tox` are NEVER opened — they are only written to
  `<dataDir>/binaries/<id>.<ext>` with a sha256 fingerprint, and the path is
  recorded on the card only when `shouldStoreProjectBinary(license, allowlist)`
  returns `true`. Tested by the `license allowlist EXCLUDES MIT` case.
- `provenance` + `license` are mandatory on every card (enforced by the F0
  Zod schema, exercised by every F1 case).
- Rate-limit / no-config conditions surface as typed `SourceSkippedError` —
  never silent zero-items returns. Tested via the 403 "API rate limit
  exceeded" path.
- `getCard()` still regex-guards path-traversal ids (covered by F0 tests).

## Branch + SHA

- Branch: `feature/project-rag`.
- SHA: see `git log -1` after the commit (will be added below the commit step).
- No tag (per policy `commit-and-push-NO-tag` + memory `no-premature-release-tag`).

## Sample CLI output (synthetic, msw-mocked)

```
$ tdmcp project-rag sync
synced: 1 added, 0 updated, 0 tombstoned, 1 binaries stored, 0 skipped (license)

$ tdmcp project-rag index
indexed: 1 embedded, 0 cached/skipped, 1 total cards

$ tdmcp project-rag search "mediapipe hand tracking"
0.812  torinmb/mediapipe-touchdesigner [component] — MIT
        https://github.com/torinmb/mediapipe-touchdesigner
```

## Next — F2 decision (multi-source + scoring)

F2 should add the second P0 source — `github-repo:DBraun/TouchDesigner_Shared`
(GPL-3.0, copyleft flag) — and tune the scoring weights against a small
ground-truth set. The current `github-repo` adapter is already
multi-repo-capable (CSV env var); F2 work is the GPL provenance/flag end
plus a `github-topic` scanner for the `touchdesigner-components` topic, plus
moving scoring weights from "basic" to "tuned" against ~10 expected queries.

**Do not begin F2 until user explicitly confirms.**
