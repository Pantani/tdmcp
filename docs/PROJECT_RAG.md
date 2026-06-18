# Project RAG

> Status: **experimental — F1 MVP (first source wired)**. Multi-source +
> scoring tuning land in F2; bridge-quarantine analysis in F3.

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

## First source: `torinmb/mediapipe-touchdesigner`

F1 ships **one P0 source**: the `github-repo` adapter, seeded by default with
[`torinmb/mediapipe-touchdesigner`](https://github.com/torinmb/mediapipe-touchdesigner)
(MIT). It is fetched entirely via the GitHub REST API (no local `git clone`,
robust for CI), with per-card provenance + SPDX-detected license.

You can override the seed (or add more repos) by setting a CSV:

```bash
export TDMCP_PROJECT_RAG_GITHUB_REPOS="torinmb/mediapipe-touchdesigner,DBraun/TouchDesigner_Shared"
```

`owner/repo[@ref]` syntax pins a branch/tag/SHA.

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
# 1. Pull cards from the configured repos (~4 HTTP requests / repo)
$ tdmcp project-rag sync
synced: 1 added, 0 updated, 0 tombstoned, 1 binaries stored, 0 skipped (license)

# 2. List the available sources and their status
$ tdmcp project-rag sources
ready    github-repo  (GitHub repo allowlist (TDMCP_PROJECT_RAG_GITHUB_REPOS)) — unauthenticated (limit 60 req/h)
planned  derivative-local  (TouchDesigner OP Snippets + Palette (local install)) — F2
planned  github-topic  (GitHub topic:touchdesigner-components) — F2
planned  awesome-touchdesigner  (monkeymonk/awesome-touchdesigner (discovery)) — F2

# 3. Embed new/changed cards (cache hits skip re-embedding)
$ tdmcp project-rag index
indexed: 1 embedded, 0 cached/skipped, 1 total cards

# 4. Semantic search across the local index
$ tdmcp project-rag search "mediapipe hand tracking"
0.812  torinmb/mediapipe-touchdesigner [component] — MIT
        https://github.com/torinmb/mediapipe-touchdesigner

# 5. Read one card fully (provenance + license + score)
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
tdmcp project-rag sources           # list configured source slots + status
tdmcp project-rag sync              # pull cards from selected sources
tdmcp project-rag sync --source github-repo --limit 5
tdmcp project-rag index             # embed new/changed cards (uses Ollama)
tdmcp project-rag search <query>    # cosine search the local project index
tdmcp project-rag search <query> --license MIT,Apache-2.0 --type component --tags tox
tdmcp project-rag info <id>         # show one card (provenance + license + score)
```

All commands support `--json` for machine-readable output.

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
