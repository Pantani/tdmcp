---
title: Creative RAG (local)
description: "An opt-in, local-only creative repertoire — open-licensed artworks, artists and techniques — that tdmcp can search for inspiration. Repertoire, not policy; no hardware, no DMX, no Python exec."
---

# Creative RAG (local)

> **Status: experimental, shipped on `main` (PR #75 / commit `0956eea`).**
> Off by default (`TDMCP_RAG_ENABLED=0`). When disabled, tdmcp behaves exactly
> as before: the service is never constructed, no `tdmcp://creative/*`
> resources are registered, and the `creative-rag` subcommand prints a
> disabled message and exits 0.

Creative RAG is a **local creative repertoire**: a small, versioned library of
cards describing open-licensed artworks, artists, projects and techniques,
embedded locally so you (and the AI) can search it for *inspiration*. Every
result carries `sourceUrl`, `license` and `rightsNotes`, so attribution and
reuse limits travel with the reference.

**It is deliberately narrow:**

- **Repertoire, not policy.** It supplies creative context only — moods,
  palettes, motion language, technique names. It never decides what is safe to
  run; the AI Party policy runtime
  (`ShowIntentSchema` / `showDirectorRuntime`) remains the sole authority for
  safety.
- **No bridge, no DMX, no Python exec.** No Creative RAG code path touches the
  TouchDesigner bridge, DMX, a fixture, or executes Python. There is **no MCP
  tool** that triggers any physical or in-TD action from a search result. The
  only outbound calls are the four museum HTTP APIs (during explicit `sync`)
  and the local Ollama embeddings endpoint (during `index` and `search`).
- **Not fine-tuning.** No model weights change. Retrieval over a local JSONL
  index.
- **Not `src/knowledge`.** The committed operator/Python/pattern knowledge base
  remains the source of truth for *how TouchDesigner works*. Creative RAG is a
  separate, user-grown library of *what to make*.

---

## In 60 seconds

Prereqs: a local [Ollama](https://ollama.com) install.

```bash
# 1. Start the local embeddings server and pull the default model.
ollama serve &
ollama pull nomic-embed-text

# 2. Opt in.
export TDMCP_RAG_ENABLED=1

# 3. Pull cards from the four live sources into .tdmcp/creative-rag/cards/
tdmcp creative-rag sync

# 4. Embed every card via Ollama into .tdmcp/creative-rag/index.jsonl
tdmcp creative-rag index

# 5. Search.
tdmcp creative-rag search "neon city"
```

That's the whole loop. Re-run `sync` to refresh upstream cards; re-run `index`
afterwards to re-embed only the cards that actually changed.

---

## How it works

Three commands, each with a precise on-disk + network footprint.

### `tdmcp creative-rag sync`

Fetches source manifests over HTTP and writes per-card files locally.

- **Network**: HTTPS calls to the four museum APIs listed below. No keys.
- **Disk writes**: `cards/<id>.md` (atomic write) per item; `binaries/<id>.jpg`
  only when the item's license is in `TDMCP_RAG_LICENSE_ALLOWLIST` (default
  `CC0,PublicDomain`). Items with no license signal land as `license: Unknown`
  with no binary.
- **`id`**: `sha256(sourceUrl)` (hex). The card path is rejected by `getCard`
  if it doesn't match `/^[0-9a-f]{64}$/` (path-traversal guard).
- **Tombstones**: a card is tombstoned (`tombstone: true` in frontmatter,
  binary removed) only when **its own source synced successfully this run and
  did not re-emit the id**. Partial `--source` runs and failed sources never
  tombstone live cards.

```bash
tdmcp creative-rag sync                     # all live sources, --limit 10 each
tdmcp creative-rag sync --source met        # one source
tdmcp creative-rag sync --source met --source artic --limit 25
```

### `tdmcp creative-rag index`

Reads every (non-tombstoned) card on disk, embeds it via local Ollama, and
rewrites `index.jsonl`.

- **Network**: `POST {TDMCP_RAG_OLLAMA_URL}/api/embed` (default
  `http://127.0.0.1:11434/api/embed`), 30 s timeout. Request body:
  `{ "model": "<TDMCP_RAG_EMBED_MODEL>", "input": ["<card text>", ...] }`.
  Accepts both the current `{ "embeddings": [[...]] }` shape and the legacy
  `{ "embedding": [...] }`. Failures raise typed
  `OllamaConnectionError` / `OllamaTimeoutError` / `OllamaApiError`.
- **Disk reads**: every `cards/*.md`.
- **Disk writes**: `index.jsonl` (atomic rewrite). Cards already embedded with
  the same `contentHash` + `embeddingModel` are skipped (cached). Tombstoned
  ids are purged from the JSONL before re-embedding.

```bash
tdmcp creative-rag index
```

### `tdmcp creative-rag search "<query>"`

Cosine ranks the local index against an embedding of your query.

- **Network**: one `POST /api/embed` for the query string.
- **Disk reads**: `index.jsonl` is loaded into memory.
- **Disk writes**: none.
- **Filters**: optional `--license` / `--type` / `--tags` CSVs; `--k` (default
  `10`) caps result count.

```bash
tdmcp creative-rag search "kinetic monochrome motion" --k 5 --license CC0,PublicDomain
tdmcp creative-rag search "botanical growth" --k 8 --type artwork --tags nature,line
```

For the MVP corpus size (hundreds of cards), in-memory cosine is instant and
dependency-free.

---

## Reference

### Environment variables

All keys are opt-in and parsed/validated in `src/utils/config.ts` (Zod).

| Env var | Default | Behavior |
|---|---|---|
| `TDMCP_RAG_ENABLED` | `false` | Master switch. Accepts `1`/`true` (case-insensitive) ⇒ on; `0`/`false`/empty ⇒ off. When off, the service is never constructed, the resources are not registered, and the subcommand exits 0 with a disabled message. |
| `TDMCP_RAG_DATA_DIR` | `.tdmcp/creative-rag` | Where cards, binaries and the index live. Gitignored. |
| `TDMCP_RAG_OLLAMA_URL` | `http://127.0.0.1:11434` | Local Ollama base URL. The embed endpoint is `{url}/api/embed`. |
| `TDMCP_RAG_EMBED_MODEL` | `nomic-embed-text` | Must be pulled (`ollama pull nomic-embed-text`). |
| `TDMCP_RAG_LICENSE_ALLOWLIST` | `CC0,PublicDomain` | CSV of license values for which **binaries** may be stored. Cards themselves are always stored. |

### CLI

```text
tdmcp creative-rag sync   [--source <id>]... [--limit <n>] [--json]
tdmcp creative-rag index                                   [--json]
tdmcp creative-rag search <query> [--k <n>] [--license CSV] [--type CSV] [--tags CSV] [--json]
```

- `--source <id>` (sync only, repeatable): scope to one or more sources. Valid
  ids: `artic`, `rijksmuseum`, `met`, `cleveland`.
- `--limit <n>` (sync only): per-source item cap. Default `10`.
- `--k <n>` (search only): top-k. Default `10`.
- `--license <csv>` (search only): allowed values
  `CC0, PublicDomain, CC-BY, CC-BY-SA, Unknown, Restricted`.
- `--type <csv>` (search only): allowed values
  `project, artist, artwork, technique, cue_reference`.
- `--tags <csv>` (search only): free-text tag filter (set logic on card tags).
- `--json`: emit machine-readable output.

### Live sources

Four open-data museum APIs, all keyless, license-aware per item:

| Source | API base | License signal |
|--------|----------|----------------|
| Art Institute of Chicago | `https://api.artic.edu/api/v1` | `is_public_domain` (boolean) ⇒ `PublicDomain`, else `Unknown` |
| The Met | `https://collectionapi.metmuseum.org/public/collection/v1` | `isPublicDomain` (boolean) ⇒ `PublicDomain` / CC0, else `Unknown` |
| Rijksmuseum | `https://data.rijksmuseum.nl` | Linked-Art rights statement ⇒ `CC0` / `PublicDomain` / `Unknown` |
| Cleveland Museum of Art | `https://openaccess-api.clevelandart.org/api/artworks` | `share_license_status` (`"CC0"` ⇒ `CC0`), else `Unknown` |

`sync` pulls a **bounded** number of items per source (default 10, `--limit`
overrides) to stay polite to upstream. It is not a full mirror.

Nine further sources (`europeana`, `wikimedia`, `smithsonian`, `harvard`,
`cooperhewitt`, `internetarchive`, `wikiart`, `portfolios`, `shadertoy`) ship
only as documented stubs in `plannedStubs.ts`; they are **not** wired into
`sync`. See the roadmap follow-ups.

### License policy

Pure function of the card's `license`, decided at sync time — no runtime
prompt or override.

- A binary is **only** downloaded/stored if `license` is in
  `TDMCP_RAG_LICENSE_ALLOWLIST`.
- A source that gives no license signal ⇒ `license: Unknown` and **no binary
  is ever downloaded**. The card still exists (text + `sourceUrl`) so it is
  searchable as a reference.
- A card the upstream drops on re-sync (404 / removed) is **tombstoned**, not
  silently deleted, so removed references are auditable.

`license` values: `CC0` · `PublicDomain` · `CC-BY` · `CC-BY-SA` · `Unknown` ·
`Restricted`.

### MCP resources (read-only)

Registered **only** when `TDMCP_RAG_ENABLED=1`:

- `tdmcp://creative/cards/{id}` — one card as JSON. Tombstoned ids return
  absent. Invalid id ⇒ `{ "error": "Card \"<id>\" not found." }`.
- `tdmcp://creative/search{?q,k,license,type,tags}` — top-k cards as JSON
  (`{ query, count, results }`). Empty `q` ⇒
  `{ "error": "Search needs a \"q\" query parameter.", "results": [] }`.

Both are read-only: reading a resource never mutates state, never calls the
bridge, never runs Python.

### Card format

Cards are Markdown files with YAML frontmatter under `cards/<id>.md`,
validated by `CreativeRagCardSchema` in `src/creativeRag/schema.ts`
(`schemaVersion: 1`).

```yaml
---
schemaVersion: 1
id: "<sha256 of sourceUrl>"
type: artwork            # project | artist | artwork | technique | cue_reference
title: "Composition VIII"
artist: "Wassily Kandinsky"
sourceUrl: "https://www.artic.edu/artworks/123"
sourceName: "Art Institute of Chicago"
license: PublicDomain    # CC0 | PublicDomain | CC-BY | CC-BY-SA | Unknown | Restricted
rightsNotes: "Public domain per source is_public_domain flag."
year: 1923
medium: "Oil on canvas"
tools: []                # creative tools/media used by the original work
tags: ["geometric", "high-contrast", "kinetic"]
visualLanguage: "hard-edged geometry, primary colors on white"
motionLanguage: "implied rotational motion"
interaction: null
materials: "oil"
lighting: null
palette: ["#e4332a", "#1f4fa6", "#f2c200"]
tdmcpAffordances: ["create_generative_art", "create_kaleidoscope"]
contentHash: "<sha256 of the canonical card text>"
embeddingModel: "nomic-embed-text"   # set by `index`
tombstone: false
---
Free-text body: a short creative note about why this reference is useful.
```

`tdmcpAffordances` only ever lists existing Layer-1 tool names. They are
hints, not actions — reading a card never invokes them.

### JSONL index record

`index.jsonl` is one JSON object per line, one per embedded card:

```json
{"id":"<sha256>","contentHash":"<sha256>","embeddingModel":"nomic-embed-text","embedding":[0.0123,-0.045],"title":"...","type":"artwork","license":"PublicDomain","tags":["geometric"],"sourceUrl":"...","sourceName":"..."}
```

Search loads the file into memory, computes cosine similarity against the
query embedding, applies `license` / `type` / `tags` filters, and returns
top-k.

---

## Troubleshooting

- **`ECONNREFUSED 127.0.0.1:11434` on `index` or `search`.** Ollama is not
  running. Start it: `ollama serve`.
- **`OllamaApiError` mentioning model not found.** Pull the embedding model:
  `ollama pull nomic-embed-text` (or whichever `TDMCP_RAG_EMBED_MODEL` you
  set).
- **`sync` returns 0 cards.** Either your `--source` list is empty / typoed
  (valid ids: `artic`, `rijksmuseum`, `met`, `cleveland`), or you passed
  `--limit 0`. Sync with no `--source` covers all four live sources at
  `--limit 10` each.
- **`EACCES` / "not writable" on first sync.** The data dir
  (`TDMCP_RAG_DATA_DIR`, default `.tdmcp/creative-rag`) needs to be writable
  by the user running tdmcp. Fix permissions there or point the env var at a
  writable location.
- **A card I expected is missing after `index`, listed as tombstoned.** Its
  upstream source synced successfully but did not re-emit the id — the
  upstream removed it. Re-running `sync` will rebuild a fresh card if the
  upstream brings the work back.

---

## Limits (MVP)

- **In-memory cosine over JSONL only.** No LanceDB / no native deps. A
  `TDMCP_RAG_BACKEND=lancedb` vector store is a documented follow-up
  (see the [roadmap](./ROADMAP)), kept out of the default install.
- **Four sources only.** The other nine are planned stubs.
- **Bounded sync.** Not a full mirror; a per-run item cap (`--limit`).
- **English-leaning embeddings.** `nomic-embed-text` default; a multilingual
  swap (e.g. `bge-m3`) is a follow-up, not a redesign.
- **No write tools.** Read-only resource + CLI only.
