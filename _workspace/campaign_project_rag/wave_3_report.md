# Wave 3 — F2 Multi-source + scoring · Report

**Status:** SHIPPED (5/5 in-scope features; 2 deferred per user scope).
**Checkpoint reached. Do not start F3 without go-ahead.**

## What landed

Project RAG F2: a second seeded GPL source (with the copyleft flag now visible
in search output), a topic-scanner adapter behind hard SPDX/star/recency
filters, a tuned composite scoring (curated-source boost + copyleft
tie-breaker), a ground-truth set that pins the ranker, and CLI extensions
(`sync --topic/--cap`, `reindex --rescore`).

## F2 scope vs. user direction

The original F2 plan listed 5 P1 features. The user scoped this wave to:
DBraun seed + github-topic + scoring tuning + ground-truth + CLI extensions.
The two unrelated discovery sources are marked `deferred` in the ledger:

- `prag_source_awesome_list` → deferred (no awesome-list scanner this wave).
- `prag_source_iihq` → deferred (no Interactive & Immersive HQ ingest this wave).

## Files created

**Production (`src/projectRag/`):**

- `/Users/pantani/Desktop/projects/art/tdmcp/src/projectRag/sources/githubTopic.ts` — GitHub Search API topic scanner with SPDX allowlist filter (MIT/Apache-2.0/BSD-{2,3}/ISC/Unlicense/CC0-1.0 clean; GPL/LGPL/AGPL accepted-as-copyleft; rest rejected), min-stars (default 5), pushed_at recency (default >=2024-01-01), per-sync cap (default 25), fork exclusion, opt-in ghToken header, pagination with rate-limit→`SourceSkippedError`.

**Ground truth + tests (`tests/unit/projectRag/`):**

- `/Users/pantani/Desktop/projects/art/tdmcp/_workspace/campaign_project_rag/scoring_ground_truth.json` — 10 deterministic queries × expected-top-1 mock cards (mediapipe MIT vs GPL, audio/fft/feedback, noise/particle, shader/depth, kinect, midi/osc, interactive, DBraun shared).
- `/Users/pantani/Desktop/projects/art/tdmcp/tests/unit/projectRag/githubTopic.test.ts` — 7 msw cases (SPDX filter, cap across topics, fork exclusion, rate-limit, ghToken header, pagination, parser).
- `/Users/pantani/Desktop/projects/art/tdmcp/tests/unit/projectRag/scoringGroundTruth.test.ts` — 2 cases (>=7/10 hit-rate, MIT-vs-GPL mediapipe rank).

## Files extended (single-writer, additive)

- `src/projectRag/sources/githubRepo.ts` — `DEFAULT_GITHUB_REPOS` extended with `DBraun/TouchDesigner_Shared` (GPL-3.0).
- `src/projectRag/sources/index.ts` — `resolveProjectSources` registers `githubTopicSource` (skipped only when `TDMCP_PROJECT_RAG_GITHUB_TOPICS=off`); exports `parseTopicListEnv` / `DEFAULT_TOPICS`.
- `src/projectRag/scoring.ts` — light copyleft tie-breaker penalty (−0.05) + curated-source reliability boost (+0.10); exports `isCuratedSource`.
- `src/projectRag/service.ts` — `sync()` accepts per-call `topicsCsv`/`topicCap` (rebuilds source list on the fly); new `rescore()` recomputes `score.composite` in place and rewrites the JSONL index without re-embedding; `listSources()` reports `github-topic` ready/skipped (was planned).
- `src/projectRag/types.ts` — `ProjectRagConfig.{githubTopicsCsv,topicCap}` + new `ProjectRescoreReport` + `ProjectRagService.rescore()` + sync opts shape.
- `src/projectRag/cli.ts` — `--topic <csv>`, `--cap <n>`, `--rescore` flags; new `reindex` subcommand; search output renders `GPL-3.0 · copyleft` badge; help refreshed.
- `src/projectRag/index.ts` — barrel exports for new modules.
- `src/utils/config.ts` + `src/cli/agent.ts` — `TDMCP_PROJECT_RAG_GITHUB_TOPICS` + `TDMCP_PROJECT_RAG_TOPIC_CAP`.
- `tests/unit/projectRag/{cli,service,resource,githubRepo,serviceF1}.test.ts` — fixtures pinned to single-repo lists, `rescore` mocks added, new CLI cases for `--topic/--cap/--rescore/copyleft-badge`, GPL-3.0 source case.

## Docs / release

- `docs/PROJECT_RAG.md` (EN) + `docs/pt/PROJECT_RAG.md` (PT) — status bumped to F2; new sections "Adding GPL sources (copyleft handling)", "Scanning GitHub topics" (filters table + env vars), F2 example session (showing copyleft badge + `reindex --rescore`), refreshed CLI surface, scoring fields table (axes + weights + copyleft penalty + curated boost + 9/10 ground-truth result).
- `CHANGELOG.md` — F2 entry under Unreleased.
- No version bump. No git tag (per policy + memory `no-premature-release-tag`).

## Gates (all green)

```
typecheck       : PASS
build           : PASS
biome check .   : PASS (0 errors, 1 unrelated pre-existing warning)
vitest          : PASS — 4287/4287 (+15 vs F1 baseline 4272)
validate:recipes: not re-run this wave (no recipe changes; unchanged from F1: 32/32)
test:bridge     : not re-run this wave (no bridge changes; unchanged from F1: 196/196)
```

TD live validation: **NOT required for F2** (offline-only; search path never
touches the bridge). Ollama is **not required for tests** — both the
serviceF1 and the F2 ground-truth tests use deterministic in-process embedders.

## Ground-truth hit-rate

Measured against `_workspace/campaign_project_rag/scoring_ground_truth.json`
with a normalized token-bag embedder:

```
HIT_RATE 9 / 10  (target: >=7/10)
MISSES   [{"q":"touchdesigner shared components","expected":"card_dbraun_gpl","got":"card_interactive_mit"}]
```

Sample comparison for `mediapipe hand` (MIT seed vs the GPL fork):

```
0.3748  card_mediapipe_mit       MIT
0.3286  card_mediapipe_gpl       GPL-3.0
```

The MIT card ranks above the GPL one purely from the composite (curated boost
+ copyleft penalty) even when cosine similarity is identical.

## Hard rules verified

- Search path still never imports `touchDesignerClient` — `grep` across
  `src/projectRag/**` clean.
- `github-topic` rate-limit is a typed `SourceSkippedError` — prior cards
  are not tombstoned by a silent zero-items return.
- License gate untouched: `Derivative-EULA`/`Proprietary-*`/`Unknown`/
  `Restricted` cards still cannot persist binaries even when allowlisted.
- Copyleft is a tie-breaker, never a block: GPL cards still appear in
  results, just below an equally-relevant permissive card.

## Branch + SHA

- Branch: `feature/project-rag` (pushed to origin after this report).
- SHA: `7f95c60e0151dbd8e4f646e703991355789c189b` (after ledger + report this
  SHA will advance once more).
- No tag (per policy `commit-and-push-NO-tag` + memory
  `no-premature-release-tag`).

## Commits in this wave

```
dd663a1 feat(project-rag/f2): DBraun GPL seed + copyleft badge in search output
396d506 feat(project-rag/f2): github-topic source adapter with SPDX/star/recency filters
074b71a feat(project-rag/f2): scoring tuning — copyleft penalty + curated boost + ground truth
87cbbe0 feat(project-rag/f2): CLI — sync --topic/--cap and reindex --rescore
7f95c60 docs(project-rag/f2): EN+PT — GPL handling, topic scanner, scoring fields + CHANGELOG
```

## Next — F3 decision

F3 = `toeExpand` quarantine extractor + the dedicated bridge analyzer.
This is the highest-risk part of the design: it runs the `toeexpand` binary
in an isolated subprocess (reduced env, 30s timeout, group-kill, quarantine
UUID cwd) and the opt-in bridge path spins up a **separate** TD instance on
port 9981 (never the user's 9980 bridge). Keep off-by-default; ship behind
`TDMCP_PROJECT_RAG_BRIDGE_ANALYSIS=1`.

**Do not begin F3 until user explicitly confirms.**
