# Project RAG

> Status: **experimental — F3 (TD-bridge quarantine analysis, opt-in)**.
> F0+F1+F2+F3 shipped. F4 (prompts/resources/copilot tool) pending.

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

### Interactive & Immersive HQ tutorials (CC-BY-NC-SA, opt-in, default OFF)

The `iihq` source ingests the **text** of the
[Interactive & Immersive HQ "Introduction to TouchDesigner" manual](https://github.com/interactiveimmersivehq/Introduction-to-touchdesigner)
as `tutorial` cards (one per chapter `.md` file). It is **off by default** and
must be opted into explicitly:

```bash
export TDMCP_PROJECT_RAG_IIHQ=1          # enable the source (default OFF)
export TDMCP_PROJECT_RAG_IIHQ_REF=master # branch/tag/SHA override (default: master)
$ tdmcp project-rag sync --source iihq
```

**License posture — non-commercial.** The manual is licensed
**CC-BY-NC-SA-4.0**, declared in the repo's README prose (the GitHub License API
reports `license: null`). The adapter therefore hard-stamps every card with
`license: "CC-BY-NC-SA"` / `licenseConfidence: "declared"` — it never runs SPDX
detection — and search output renders the obligations inline. Using these cards
means you must:

- **Attribute** *The Interactive & Immersive HQ*.
- Use the material **non-commercially** only.
- Re-share any derivative **under the same license** (share-alike).

**Text only, never binaries.** The adapter fetches markdown body text (capped at
8,000 chars/file) and never sets a `binaryUrl`. `CC-BY-NC-SA` binaries are
hard-denied by `licensePolicy`
([`src/projectRag/licensePolicy.ts`](https://github.com/Pantani/tdmcp/blob/main/src/projectRag/licensePolicy.ts))
regardless of any allowlist, so no `.tox`/`.toe`/example files are ever stored.
Only the `Basics`, `CHOPs`, `COMPs`, `DATs`, `GLSL`, `MATs`, `Optimization`,
`Python`, `SOPs`, `TOPs`, and `User_Interface` chapter directories are ingested;
`img/` and `TouchDesigner Example Files/` are excluded.

A GitHub rate-limit (HTTP 403) or unreachable source becomes a typed
`SourceSkippedError` — prior cards are never tombstoned. Set
`TDMCP_PROJECT_RAG_GH_TOKEN` to raise the API quota.

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
ready    derivative-local      (TouchDesigner Palette + OP Snippets (local install)) — local-only
planned  awesome-touchdesigner (monkeymonk/awesome-touchdesigner (discovery)) — see sources --discovery

# 2b. Browse the suggest-only discovery queue (never auto-ingested)
$ tdmcp project-rag sources --discovery
discovery queue (suggest-only, 60 candidates) — review before ingest:
  [Components] Mediapipe TD
        https://github.com/torinmb/mediapipe-touchdesigner — hand/face tracking

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
tdmcp project-rag sources --discovery               # suggest-only awesome-list queue (no auto-ingest)
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
- `tdmcp://project/sources` *(F4)* — configured sources + their status
  (`ready` / `skipped` / `planned` / `failed`), so the agent knows which
  sources are indexed before searching.

## F4 — AI surface (prompts, copilot tool, CLI cross-link)

F4 is the **AI-facing layer** on top of F0–F3. Everything is offline, opt-in,
and gated by `TDMCP_RAG_ENABLED=1 && TDMCP_PROJECT_RAG_ENABLED=1`.

### MCP prompt — `project_rag_context`

Runs `service.search(query, k, { license })` over the configured Project RAG
index and returns a prompt message that lists the top-k cards as
*authoritative reference* — title, license, optional rights notes, and
`tdmcp://project/cards/{id}`. Args: `query` (free text), `k` (1–10, default 5),
`license` (CSV like `CC0,MIT,Apache-2.0`).

When Project RAG is not enabled or the service throws, the prompt **silently
degrades** to a stock prompt that mentions the issue and continues with the
model's own knowledge — it never blocks the turn. Same fallback for an empty
search result (with the `tdmcp project-rag sync` hint).

### MCP resource — `tdmcp://project/sources`

Read-only JSON list of `{ name, displayName, status, reason? }` so an agent
can tell ahead of search which sources are indexed locally vs. configured
but skipped/planned/failed.

### Copilot tool — `project_rag_search`

A read-only (`mutates: false`) LLM tool advertised to `tdmcp ask`, `tdmcp chat`,
the loopback chat server, and the Telegram copilot. Args mirror the CLI:
`query`, `k` (default 5, max 20), and optional filter arrays `license`,
`type`, `operator`, `tags`. The tool is added to the catalog by
`resolveTools(tier, { projectRag: ctx.projectRag !== undefined })` — so when
Project RAG is disabled, **the tool is absent from the catalog, not refused
at call time**. A small model never sees a tool it cannot use.

### CLI cross-link tip (Creative RAG → Project RAG)

When `tdmcp creative-rag search` returns few results (default threshold ≤ 2)
**and** Project RAG is enabled **and** the user is in text mode (not
`--json`), the CLI prints a single stderr line:

```text
tip: also try `tdmcp project-rag search "<query>"` — more sources may match in the local project repertoire.
```

The suggestion is informational only — it does not alter search behavior,
machine output (`--json`), or exit codes. It exists so an artist who tried
the wrong RAG first can pivot without re-reading the docs.

### Cross-RAG ranking — fuse both corpora (opt-in)

When both RAG corpora are enabled, `tdmcp ask` can fuse Creative RAG and
Project RAG results into **one** ranked reference block using
[Reciprocal Rank Fusion (RRF)](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf):
`rrf(d) = Σ 1/(k + rank)`. RRF is **rank-based**, so it sidesteps the fact that
the two corpora score on incomparable scales (Creative is cosine `0..1`;
Project is `cosineSim * composite`). Enable it with:

```text
export TDMCP_RAG_ENABLED=1          # parent switch
export TDMCP_PROJECT_RAG_ENABLED=1  # project-rag switch (default ON when parent is on)
export TDMCP_RAG_FUSION=1           # cross-RAG fusion (default OFF)
export TDMCP_RAG_FUSION_K=60        # RRF k constant (positive int 1..1000, default 60)
```

Fusion activates **only** when `TDMCP_RAG_ENABLED && TDMCP_PROJECT_RAG_ENABLED
&& TDMCP_RAG_FUSION` and **both** corpora return at least one result. If either
corpus is empty, missing, or errors, `tdmcp ask` falls back to its existing
single-corpus creative-context block — behaviour is identical to leaving the
flag off. Lower `k` sharpens the weight of top ranks; higher `k` flattens it.

## F3 — bridge-quarantine analysis (opt-in)

F3 ships **two artifact analyzers** for downloaded `.toe`/`.tox` files. Both
run completely off the user's main TouchDesigner instance — neither can
disturb a live show.

### Static analyzer (`toeExpand`)

Wraps an external `toeexpand`-style CLI (whatever you put on `PATH`) and runs
it inside a quarantine subprocess:

- `spawn()` only — no shell interpolation.
- Reduced environment: only `PATH`, `HOME`, `LANG=C.UTF-8`. No `TDMCP_*` leak.
- 30 s hard timeout (configurable via `TDMCP_PROJECT_RAG_ANALYZE_TIMEOUT_MS`).
- Group-kill on timeout (`setsid` / `detached:true` + `kill(-pgid)`).
- Per-call UUID cwd under `os.tmpdir()/tdmcp-prag-toe/` — `try/finally`
  cleanup on every exit path.
- The `.toe`/`.tox` is copied into the quarantine cwd; Node never opens it.
- When the binary is absent on `PATH` the analyzer returns `skipped` (NOT
  `failed`) so a normal sync without `toeexpand` installed just records that
  static analysis was skipped and moves on.

Set the binary path explicitly when needed:

```bash
export TDMCP_PROJECT_RAG_TOEEXPAND_BIN=/usr/local/bin/toeexpand
```

### Dynamic analyzer (quarantine bridge)

When you want to actually cook the artifact, F3 can drive a **dedicated
TouchDesigner instance** bound to a **separate port** (default `9981`,
never `9980`). The user's main TD is never touched.

Setup is doc-driven and idempotent — `tdmcp project-rag bridge install`
prints the walkthrough and probes whether the bridge is reachable:

```text
$ tdmcp project-rag bridge install
tdmcp project-rag bridge install — quarantine bridge setup
…
  1. Open a fresh TouchDesigner instance (do NOT reuse the one tdmcp drives
     for live work).
  2. Inside that instance, install the tdmcp bridge: tdmcp install-bridge
  3. Edit the Web Server DAT's "port" parameter from 9980 → 9981.
  4. Save as tdmcp_bridge_qa.toe.
  5. Enable F3:
       export TDMCP_PROJECT_RAG_BRIDGE_ANALYSIS=1
       export TDMCP_PROJECT_RAG_ENABLED=1
       export TDMCP_RAG_ENABLED=1
…
Probe: http://127.0.0.1:9981 — OFFLINE
```

> **Quarantine opt-in (required to load artifacts).** The bridge route that
> opens a `.toe`/`.tox` (`POST /api/project/load`) is **default-DENY**: loading an
> artifact replaces or imports into the running project, so it is refused (HTTP
> 403) unless that instance is explicitly marked as a throwaway quarantine via
> `export TDMCP_PROJECT_RAG_QUARANTINE=1` in its environment. This is a
> bridge-side guard independent of `TDMCP_BRIDGE_ALLOW_EXEC` — installing the
> bridge on your main TD can never let a stray caller load over your open project.

The analyzer:

- Instantiates a **new** `TouchDesignerClient` bound to
  `TDMCP_PROJECT_RAG_BRIDGE_PORT` (default `9981`). It **refuses** to use port
  `9980` — calling `analyze` with the port wired to `9980` returns
  `failed: "refusing to use main TD port 9980"`.
- Probes the bridge with `GET /api/info`. If the probe throws a connection
  error → returns `skipped` (NOT `failed`) so the offline path is the safe
  default.
- On a reachable bridge: collects network errors via `getNetworkErrors("/")`
  and tries to capture a preview of `/project1/out1`. Partial-success
  tolerant: a missing preview still produces `ok` with `errorCount`.

### Commands

```bash
# Analyze one file directly through the quarantine bridge.
# Exit 0 on ok/skipped; exit 1 only on real failure.
tdmcp project-rag analyze /absolute/path/to/component.tox
tdmcp project-rag analyze ./some.toe --json

# Sync, then run the bridge analyzer over every downloadable card.
# Persists analysisStatus on each card so subsequent runs skip already-ok cards.
tdmcp project-rag sync --bridge
tdmcp project-rag sync --bridge --json
```

`analysisStatus` is stored on the card YAML frontmatter:

```yaml
analysisStatus: ok           # cooked cleanly in quarantine TD
analysisReason: "bridge offline at http://127.0.0.1:9981"  # set on skipped/failed
```

It is **excluded from the card's contentHash** (treated as persistence
metadata, like `binaryPath`) so a re-sync of unchanged source content stays a
cache hit even after the analyzer runs.

### Threat model recap

| Risk | Mitigation |
|---|---|
| User runs `sync --bridge` and a malicious `.tox` corrupts their show file | Quarantine bridge runs in a **separate TD instance** on **separate port** — the user's main 9980 TD is never reached |
| A long-running cook hangs the agent | 30 s hard timeout (configurable); for the static analyzer, group-kill on the subprocess; for the bridge, a `Promise.race` cap |
| Subprocess sees `TDMCP_BRIDGE_TOKEN` and leaks it | Reduced env (`PATH`, `HOME`, `LANG` only) — no `TDMCP_*` is forwarded |
| Bridge offline produces noisy "failed" report | Offline always degrades to `skipped`; `exit 0` on skip; the report records which cards weren't analyzed |
| Path traversal via crafted artifact name | Static analyzer copies the file under a fixed basename (`input<ext>`) inside a UUID cwd — the input path never reaches the subprocess argv |

## Hard rules (security)

- The search path never spawns Python or talks to the active TD bridge.
- The F3 bridge-quarantine analyzer uses a *new* `TouchDesignerClient`
  against `TDMCP_PROJECT_RAG_BRIDGE_PORT` (default 9981) and refuses to fall
  back to the default 9980 client. tdmcp never auto-spawns a TD process.
- Downloaded `.toe`/`.tox` files are **NEVER** opened in the user's active project.
- License matrix is enforced before any binary is persisted —
  `Derivative-EULA`/`Proprietary-*`/`Unknown`/`Restricted` cards never get
  their binaries stored locally, even if the allowlist would permit it.

See `_workspace/01_design_project_rag.md` for the full design and
`_workspace/01_plan_project_rag_implementation.md` for the phased roadmap.
