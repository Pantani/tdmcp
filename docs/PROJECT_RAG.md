# Project RAG

> Status: **experimental — F2 (multi-source + tuned scoring)**.
> Bridge-quarantine analysis lands in F3.

Project RAG is the **technical/project repertoire** sibling to
[Creative RAG](./CREATIVE_RAG.md). It indexes **TouchDesigner projects,
components, snippets and tutorials** with mandatory provenance + license on
every card, so the agent can answer "show me a real `.tox` someone shipped that
does hand tracking with MediaPipe" — and always shows where the file came from
and how you may use it.

It is **opt-in**, **offline-first**, and the search path **never touches the
TouchDesigner bridge, DMX, or Python exec**. The opt-in bridge-quarantine
analyzer (F3, not yet shipped) will use a *separate* TD instance on a dedicated
port (default `9981`), never the user's active 9980 bridge.

## When to use it

| Question | Reach for |
|---|---|
| "Inspire me with an artist that uses generative growth aesthetics" | **Creative RAG** |
| "Show me real `.tox` examples that do FFT + Feedback I can rebuild" | **Project RAG** |
| "What MediaPipe-TD wrapper should I look at?" | **Project RAG** |
| "Which museum has open-access generative-art works?" | **Creative RAG** |

The two RAGs share the embedding model + storage layer + opt-in gating but
keep their cards in **separate data directories** so one can never leak into
the other.

## Gating

Project RAG is OFF by default. Activation requires BOTH flags:

```bash
export TDMCP_RAG_ENABLED=1            # parent RAG switch (off by default)
export TDMCP_PROJECT_RAG_ENABLED=1    # project-rag switch (default ON when RAG is on)
```

When either flag is off, `tdmcp project-rag …` prints a friendly disabled
message and exits 0; the MCP resources are not registered.

## Seeded sources (F2)

F2 ships **two P0 repos** out of the box plus a topic scanner:

- [`torinmb/mediapipe-touchdesigner`](https://github.com/torinmb/mediapipe-touchdesigner) — **MIT** (permissive)
- [`DBraun/TouchDesigner_Shared`](https://github.com/DBraun/TouchDesigner_Shared) — **GPL-3.0** (copyleft; flagged in search output)

Both are fetched via the GitHub REST API (no local `git clone`, CI-robust),
with per-card provenance + SPDX-detected license.

You can override the seed (or add more repos) by setting a CSV:

```bash
export TDMCP_PROJECT_RAG_GITHUB_REPOS="torinmb/mediapipe-touchdesigner,DBraun/TouchDesigner_Shared,foo/bar@v1"
```

`owner/repo[@ref]` syntax pins a branch/tag/SHA.

### Adding GPL sources (copyleft handling)

Project RAG accepts copyleft licenses (`GPL-2.0`, `GPL-3.0`, `LGPL-*`,
`AGPL-3.0`) but treats them as a *yellow flag*, never a block:

- Cards are indexed and binaries are downloaded as usual.
- Search output renders the license as `GPL-3.0 · copyleft` so the obligation
  is visible at a glance.
- The scoring composite applies a small **copyleft tie-breaker penalty**
  (`−0.05`) so an equally relevant permissive (MIT/Apache/BSD/ISC/MPL) card
  ranks above a copyleft one. The penalty is a nudge, not a block — a strong
  semantic match still beats the penalty.
- The matrix is enforced by `licensePolicy` in
  [`src/projectRag/licensePolicy.ts`](https://github.com/Pantani/tdmcp/blob/main/src/projectRag/licensePolicy.ts);
  `Derivative-EULA`, `Proprietary-*`, `Unknown`, and `Restricted` cards never
  get their binaries persisted regardless of the allowlist.

If you want to **exclude** GPL results from a search entirely, pass
`--license MIT,Apache-2.0,BSD-2-Clause,BSD-3-Clause,ISC,MPL-2.0,CC0,PublicDomain`.

### Scanning GitHub topics

The `github-topic` source scans the GitHub Search API for repos tagged with
TouchDesigner-relevant topics and surfaces the highest-signal matches:

```bash
# Default topics (in priority order):
#   touchdesigner-components, touchdesigner-tool,
#   touchdesigner-tools, touchdesigner
$ tdmcp project-rag sync --source github-topic

# Override topics per-run (CSV) and cap the result count:
$ tdmcp project-rag sync --topic touchdesigner-components --cap 10

# Disable the topic scanner entirely for this run:
$ tdmcp project-rag sync --topic off

# Or via env (persistent):
$ export TDMCP_PROJECT_RAG_GITHUB_TOPICS=touchdesigner-components,touchdesigner
$ export TDMCP_PROJECT_RAG_TOPIC_CAP=15
```

Hard filters applied **before** any extraction:

| Filter | Default | Configurable via |
|---|---|---|
| SPDX allowlist | MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, Unlicense, CC0-1.0 (clean); GPL/LGPL/AGPL accepted as copyleft; everything else rejected | hardcoded for safety |
| Min stars | 5 | (constructor option) |
| Min `pushed_at` recency | `>=2024-01-01` | (constructor option) |
| Per-sync cap | 25 repos total across topics | `--cap N` / `TDMCP_PROJECT_RAG_TOPIC_CAP` |
| Forks | rejected | hardcoded |
| GitHub token | optional but recommended | `TDMCP_PROJECT_RAG_GH_TOKEN` |

A rate-limit response (HTTP 403 with "rate limit" body) becomes a typed
`SourceSkippedError` — prior cards are never tombstoned because the source
quietly returned zero items.

### GitHub rate limits & token

The adapter uses the public GitHub API. Without authentication you get **60
requests/hour** per IP. With a Personal Access Token (no scopes needed for
public repos) you get **5,000 requests/hour**:

```bash
export TDMCP_PROJECT_RAG_GH_TOKEN="ghp_xxxxxxxxxxxxxxxxxxxxxxxxx"
```

When the unauthenticated quota is exhausted, the adapter raises a typed
`SourceSkippedError` — **not** a silent zero-items return (which would
incorrectly tombstone every prior card from that source).

### Example session

```bash
# 1. Pull cards from the configured repos + topic scanner
$ tdmcp project-rag sync
synced: 14 added, 0 updated, 0 tombstoned, 12 binaries stored, 2 skipped (license)

# 2. List the available sources and their status
$ tdmcp project-rag sources
ready    github-repo   (GitHub repo allowlist (TDMCP_PROJECT_RAG_GITHUB_REPOS)) — authenticated
ready    github-topic  (GitHub topic scanner (touchdesigner-components et al.)) — authenticated
planned  derivative-local      (TouchDesigner OP Snippets + Palette (local install)) — F2
planned  awesome-touchdesigner (monkeymonk/awesome-touchdesigner (discovery)) — F2

# 3. Embed new/changed cards (cache hits skip re-embedding)
$ tdmcp project-rag index
indexed: 14 embedded, 0 cached/skipped, 14 total cards

# 4. Semantic search — copyleft badge appears for GPL/LGPL/AGPL results
$ tdmcp project-rag search "mediapipe hand tracking"
0.812  torinmb/mediapipe-touchdesigner [component] — MIT
        https://github.com/torinmb/mediapipe-touchdesigner
0.341  DBraun/TouchDesigner_Shared [component] — GPL-3.0 · copyleft
        https://github.com/DBraun/TouchDesigner_Shared
        rights: Copyleft (GPL-3.0): derived work must preserve license.

# 5. Re-rank without re-embedding (e.g. after tuning weights)
$ tdmcp project-rag reindex --rescore
rescored: 14 of 14 cards (no re-embed)

# 6. Read one card fully (provenance + license + score)
$ tdmcp project-rag info <id> --json | jq .
```

### What a card carries

Every persisted card includes the v2 schema's mandatory fields:

- `provenance.sourceName` — e.g. `github:torinmb/mediapipe-touchdesigner`
- `provenance.sourceUrl` — canonical clickable URL
- `provenance.canonical` — hashing base for the card id
- `provenance.commitOrVersion` — branch/tag/SHA resolved at sync time
- `provenance.fetchedAt` — ISO timestamp
- `license` + `licenseConfidence` (`spdx-detected` from the GitHub License API)
- `binaryHash` (sha256) + `binaryPath` (relative to the data dir) when the
  license allowlist permits storing the `.tox`/`.toe`
- `score.composite` — `technical · 0.45 + license · 0.25 + freshness · 0.15 + reliability · 0.15`
  (weights configurable via `TDMCP_PROJECT_RAG_SCORE_WEIGHTS`)

`Derivative-EULA`, `Proprietary-*`, `Unknown`, and `Restricted` cards are
**never** allowed to persist binaries locally, even if the allowlist would
permit them — the license matrix is enforced before any download.

## CLI surface

```bash
tdmcp project-rag sources                           # list source slots + status
tdmcp project-rag sync                              # pull cards from all sources
tdmcp project-rag sync --source github-repo --limit 5
tdmcp project-rag sync --topic touchdesigner-components --cap 10
tdmcp project-rag sync --topic off                  # disable topic scanner for this run
tdmcp project-rag index                             # embed new/changed cards (Ollama)
tdmcp project-rag reindex --rescore                 # recompute score WITHOUT re-embedding
tdmcp project-rag search <query>                    # cosine search the local index
tdmcp project-rag search <query> --license MIT,Apache-2.0 --type component --tags tox
tdmcp project-rag info <id>                         # show one card
```

All commands support `--json` for machine-readable output.

## Scoring (F2 tuning)

`finalRank = cosineSim * score.composite`. The composite is a weighted sum
of four 0..1 axes plus a copyleft tie-breaker:

| Field | What it captures | Default weight |
|---|---|---|
| `technical` | `log10(operatorMixTotal+1)/3 · 0.5` plus bonuses for top-level files, exposed params, scripts, preview image, body length | `0.45` |
| `license` | `licenseScore(license)` — CC0/PublicDomain = 1.0, MIT/Apache/BSD/ISC/MPL = 0.95, CC-BY* = 0.8, Derivative-EULA = 0.85, GPL/LGPL/AGPL = 0.7, Proprietary-Free = 0.4, Unknown = 0.2 | `0.25` |
| `freshness` | `exp(-age_in_days / 365)` from `provenance.fetchedAt` | `0.15` |
| `reliability` | `spdx-detected/declared` → 0.85, `heuristic` → 0.6, `unknown` → 0.4; **curated sources** (default tdmcp seed list) get `+0.10` | `0.15` |
| `copyleftPenalty` | `−0.05` applied after the weighted sum when license is GPL/LGPL/AGPL — tie-breaker only, never a block | `−` |

Override weights via `TDMCP_PROJECT_RAG_SCORE_WEIGHTS=technical:license:freshness:reliability`
(e.g. `0.55:0.20:0.15:0.10` to bias the ranker toward purely technical fit),
then run `tdmcp project-rag reindex --rescore` to apply them without spending
embedder cycles.

The default weights were tuned against
`_workspace/campaign_project_rag/scoring_ground_truth.json` (10 query →
expected-top-1 cards) and achieve **9/10 hit-rate** in
`tests/unit/projectRag/scoringGroundTruth.test.ts`.

## MCP resources

Registered ONLY when both gating flags are set:

- `tdmcp://project/cards/{id}` — one card (id = sha256 of `provenance.canonical`).
- `tdmcp://project/search{?q,k,license,type,tags,operator}` — cosine search;
  every result carries provenance + license + rightsNotes.

## Hard rules (security)

- The search path never spawns Python or talks to the active TD bridge.
- The F3 bridge-quarantine analyzer (when shipped) will use a *new*
  `TouchDesignerClient` against `TDMCP_PROJECT_RAG_BRIDGE_PORT` (default 9981).
  tdmcp never auto-spawns a TD process for it.
- Downloaded `.toe`/`.tox` files are **NEVER** opened in the user's active project.
- License matrix is enforced before any binary is persisted —
  `Derivative-EULA`/`Proprietary-*`/`Unknown`/`Restricted` cards never get
  their binaries stored locally, even if the allowlist would permit it.

See `_workspace/01_design_project_rag.md` for the full design and
`_workspace/01_plan_project_rag_implementation.md` for the phased roadmap.
