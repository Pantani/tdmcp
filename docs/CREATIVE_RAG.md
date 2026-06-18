---
title: Creative RAG (local)
description: "An opt-in, local-only creative repertoire — open-licensed artworks, artists and techniques — that tdmcp can search for inspiration. Repertoire, not policy; no hardware, no DMX, no Python exec."
---

# Creative RAG (local)

> **Status: experimental, shipped.** The Creative RAG MVP is implemented and
> wired. The feature is **opt-in and off by default** (`TDMCP_RAG_ENABLED=0`).
> When disabled, tdmcp behaves exactly as before: the service is never
> constructed, no `tdmcp://creative/*` resources are registered, and the
> `creative-rag` subcommand prints a disabled message and exits 0.

## In 60 seconds

Prereqs: a local [Ollama](https://ollama.com) install.

```bash
# 1. Start the local embeddings server and pull the default model.
ollama serve &
ollama pull nomic-embed-text

# 2. Opt in.
export TDMCP_RAG_ENABLED=1

# 3. Pull cards from the live sources into .tdmcp/creative-rag/cards/
tdmcp creative-rag sync

# 4. Embed every card via Ollama into .tdmcp/creative-rag/index.jsonl
tdmcp creative-rag index

# 5. Search.
tdmcp creative-rag search "neon city"
```

Re-run `sync` to refresh upstream cards; re-run `index` afterwards to re-embed
only the cards that actually changed.

---

## What it is

Creative RAG is a **local creative repertoire**: a small, versioned library of
cards describing open-licensed artworks, artists, projects and techniques,
indexed so the model (and you) can search it for *inspiration* — "show me
kinetic, high-contrast, monochrome motion references", "what public-domain
botanical illustrations could seed a growth system". Each result carries its
`sourceUrl`, `license` and `rightsNotes` so attribution and reuse limits travel
with the reference.

It is deliberately narrow:

- **Repertório, não policy.** It is *contextual repertoire*, not a decision
  engine. It never decides what is safe to run. It mirrors the boundary in the
  [AI Party LLM Training Plan](./AI_PARTY_LLM_TRAINING_PLAN): the policy runtime
  (`ShowIntentSchema` / `showDirectorRuntime`) remains the sole authority for
  safety. Creative RAG only supplies *creative* context — moods, palettes,
  motion language, technique names, and the names of existing tdmcp tools that
  could realize a look.
- **Not fine-tuning.** No model weights change. No training. It is retrieval
  over a local JSONL index.
- **Not `src/knowledge`.** The committed operator/Python/pattern knowledge base
  stays the source of truth for *how TouchDesigner works*. Creative RAG is a
  separate, user-grown library of *what to make*.

### Hard boundary — no hardware, no DMX, no exec

**No Creative RAG code path touches the TouchDesigner bridge, DMX, a fixture,
or executes Python.** It is a CLI subcommand plus a **read-only** MCP resource.
There is **no MCP tool** that triggers any physical or in-TD action from a
search result. The only outbound network calls are:

1. the upstream source HTTP APIs (the live museum/archive sources), during an
   explicit `creative-rag sync`; and
2. the local Ollama embeddings endpoint, during `creative-rag index` **and**
   `creative-rag search` (the query is embedded before ranking).

Both are local/opt-in and isolated: an Ollama or network failure surfaces as a
typed error and **never** brings down other tools or the server.

## Included sources (MVP)

Four open-data museum APIs, all keyless and license-aware per item:

| Source | API base | License signal | Notes |
|--------|----------|----------------|-------|
| Art Institute of Chicago | `https://api.artic.edu/api/v1` | `is_public_domain` (boolean) ⇒ `PublicDomain`, else `Unknown` | IIIF image URL built from `config.iiif_url` + `image_id`. |
| The Met | `https://collectionapi.metmuseum.org/public/collection/v1` | `isPublicDomain` (boolean) ⇒ `PublicDomain` / CC0, else `Unknown` | Two-step: `search` → `objects/{id}`. |
| Rijksmuseum | `https://data.rijksmuseum.nl` | Linked-Art rights statement ⇒ `CC0` / `PublicDomain` / `Unknown` | Two-step: `search/collection` (OrderedCollectionPage) → resolve each `id` as Linked-Art JSON; image via `shows` → VisualItem → DigitalObject → `access_point`. Keyless. |
| Cleveland Museum of Art | `https://openaccess-api.clevelandart.org/api/artworks` | `share_license_status` (`"CC0"` ⇒ `CC0`), else `Unknown` | Single-call list; image from `images.web.url`. Keyless. |

> Sync pulls a **bounded** number of items per source (default 10, configurable
> per run via `--limit`) to keep the MVP fast and polite to the upstream APIs.
> It is not a full mirror.

### Live sources (post-MVP additions)

Three further sources are now wired into `sync`. Two are key-gated: with **no**
key set the adapter logs one clear skip line and returns nothing (so a `sync`
over all sources still succeeds), and the key value is **never** logged.

| Source | API base | Env key | License mapping | Notes |
|--------|----------|---------|-----------------|-------|
| Smithsonian Open Access | `https://api.si.edu/openaccess/api/v1.0/search` | `TDMCP_RAG_SMITHSONIAN_KEY` | `media.usage.access == "CC0"` ⇒ `CC0`, else `Unknown` | Single-call search (`q="online_media_type:\"Images\" AND media_usage:CC0"`). Verified live. |
| Wikimedia Commons | `https://commons.wikimedia.org/w/api.php` | _(keyless)_ | `extmetadata.License` code: `cc0`⇒`CC0`; `pd`/`public`⇒`PublicDomain`; `cc-by-sa*`⇒`CC-BY-SA`; `cc-by*`⇒`CC-BY`; else `Unknown` | Single call via `generator=categorymembers` over `Category:CC-Zero` + `imageinfo`. Verified live. |
| Europeana | `https://api.europeana.eu/record/v2/search.json` | `TDMCP_RAG_EUROPEANA_KEY` | per-item `rights[0]` CC/RS URI, classified by the shared Rijksmuseum CC/RS classifier | Verified against a live keyed sync. The `guid` carries the wskey in its query string — it is stripped so the persisted `sourceUrl`/`id` never embed the key. |

## Planned sources (stubs)

Six further sources are scoped but **not** implemented. They ship as
documented stubs with `status: "planned"` and an explicit reason, so the build
team and users know *why* each is deferred. None are wired into `sync`.

| Source | Reason deferred |
|--------|-----------------|
| Harvard Art Museums | Requires an API key (auth). |
| Cooper Hewitt | Requires an API key (auth). |
| Internet Archive | Mixed/unclear licensing per item (ambiguous license); needs scraping of rights metadata. |
| WikiArt | No official open API; would require scraping and licenses are restricted. |
| Behance / Vimeo / artist portfolios | No open license; copyrighted (restricted) — reference-only, never ingest binaries. |
| Shadertoy | Per-shader licensing varies and often unspecified (ambiguous license); covered better by tdmcp's existing ISF/Shadertoy import tools. |

## License policy (coded, not runtime-decided)

The policy is a pure function of the card's `license`, decided at sync time —
there is no runtime prompt or override:

- A binary (image) is **only** downloaded/stored if the card's `license` is in
  `TDMCP_RAG_LICENSE_ALLOWLIST` (default `CC0,PublicDomain`).
- A source that gives **no** license signal ⇒ the card's `license` is set to
  `"Unknown"` and **no binary is ever downloaded**. The card still exists
  (text + `sourceUrl`) so it is searchable as a reference.
- A card that **disappears on re-sync** (upstream returns 404 / drops it) is
  **tombstoned** (`tombstone: true`, binary removed), never silently deleted —
  so a removed reference is auditable rather than vanishing.

`license` values: `CC0` · `PublicDomain` · `CC-BY` · `CC-BY-SA` · `Unknown` ·
`Restricted`.

## Configuration

Config-backed env vars are opt-in and parsed/validated in `src/utils/config.ts`
(Zod). The Smithsonian and Europeana API keys are the exception: they are read
directly from the environment by their source adapters (never threaded through
`CreativeRagConfig`), so they are validated/redacted at the config layer for
logging but consumed in-source. Env vars follow the existing `TDMCP_*` convention.

| Env var | Config key | Default | Notes |
|---------|-----------|---------|-------|
| `TDMCP_RAG_ENABLED` | `ragEnabled` | `0` (false) | Master switch. When 0, no resource, no context injection, subcommand is a no-op-with-message. |
| `TDMCP_RAG_DATA_DIR` | `ragDataDir` | `.tdmcp/creative-rag` | Cards, binaries, index live here. Gitignored. |
| `TDMCP_RAG_OLLAMA_URL` | `ragOllamaUrl` | `http://127.0.0.1:11434` | Local embeddings endpoint. |
| `TDMCP_RAG_EMBED_MODEL` | `ragEmbedModel` | `nomic-embed-text` | Must be pulled (`ollama pull nomic-embed-text`). **Multilingual libraries.** The default `nomic-embed-text` is English-leaning. For Portuguese, Spanish, French (or mixed) repertoires set `TDMCP_RAG_EMBED_MODEL=bge-m3` and run `ollama pull bge-m3`, then `tdmcp creative-rag index --rebuild` (existing JSONL lines carry the old model id and are skipped on rebuild). Alternate: `mxbai-embed-large`. |
| `TDMCP_RAG_LICENSE_ALLOWLIST` | `ragLicenseAllowlist` | `CC0,PublicDomain` | CSV; licenses for which binaries may be stored. |
| `TDMCP_RAG_EMBED_BATCH` | `ragEmbedBatch` | `64` | Inputs per Ollama embed POST. `index` splits the card set into batches of this size; the one-vector-per-input guard fires per batch. Range 1–512. |
| `TDMCP_RAG_BACKEND` | `ragBackend` | `jsonl` | Index backend. `jsonl` is the in-memory full-load store. `lancedb` is an **experimental** scale path using the optional `@lancedb/lancedb` dependency. |
| `TDMCP_RAG_SMITHSONIAN_KEY` | _(read in-source)_ | _(unset)_ | API key for the Smithsonian source. Read directly from the env by the adapter (never threaded through config or logged); unset ⇒ that source is skipped. |
| `TDMCP_RAG_EUROPEANA_KEY` | _(read in-source)_ | _(unset)_ | API key for the Europeana source. Read directly from the env by the adapter (never threaded through config or logged); unset ⇒ that source is skipped. |

### LanceDB backend (experimental, optional dependency)

`TDMCP_RAG_BACKEND=lancedb` selects a LanceDB-backed index store instead of the
default JSONL. It requires the **optional** dependency `@lancedb/lancedb`, which
is declared as an optional `peerDependency` and is therefore **not** installed by
a default `npm install`. To use it, install it explicitly:

```bash
npm install @lancedb/lancedb
```

If the optional dependency is **absent** (or its first table access fails), the
store factory logs a clear warning and **falls back to the JSONL backend** — so
a `lancedb` misconfiguration never breaks `sync`/`index`. Search scores are
re-computed with cosine over the ANN candidate window so they are byte-for-byte
comparable with the JSONL backend.

## CLI usage

```bash
# 1. Pull cards from the live sources into TDMCP_RAG_DATA_DIR/cards/ as Markdown
#    + YAML frontmatter. Honors the license policy (binaries only for allowlisted
#    licenses; missing license => Unknown, no binary; 404 => tombstone).
tdmcp creative-rag sync [--source artic --source rijksmuseum --source met] [--limit 10]

# 2. Embed every card via Ollama POST /api/embed and write the JSONL index.
#    Cached by contentHash + embeddingModel, so re-running only embeds new/changed cards.
tdmcp creative-rag index

# 3. Cosine search the local index, top-k, with optional filters.
tdmcp creative-rag search "kinetic monochrome motion" --k 5 --license CC0,PublicDomain
tdmcp creative-rag search "botanical growth" --k 8 --type artwork --tags nature,line
```

When `TDMCP_RAG_ENABLED=0`, every subcommand prints a one-line "Creative RAG is
disabled (set TDMCP_RAG_ENABLED=1)" message and exits 0 — never an error.

## MCP resources (read-only)

Registered **only** when `TDMCP_RAG_ENABLED=1`:

- `tdmcp://creative/cards/{id}` — one card as JSON (full frontmatter; always
  includes `sourceUrl`, `license`, `rightsNotes`). `{id}` is the card id.
- `tdmcp://creative/search?q=...` — read-only search; returns top-k cards with
  `sourceUrl`/`license`/`rightsNotes` on every item. Supports `q`, `k`,
  `license`, `type`, `tags` query params.

Both are **read-only**: reading a resource never mutates state, never calls the
bridge, never runs Python.

## Card format

Cards are Markdown files with YAML frontmatter under
`TDMCP_RAG_DATA_DIR/cards/<id>.md`, validated by a Zod schema (`schemaVersion: 1`).

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
# embedding lives in the JSONL index, not the card file
tombstone: false
---
Free-text body: a short creative note about why this reference is useful.
```

`tdmcpAffordances` only ever lists **existing** Layer-1 tool names (verified
against the live registry — e.g. `create_generative_art`, `create_particle_system`,
`create_kaleidoscope`, `create_growth_system`, `create_kinetic_text`,
`create_point_cloud`). They are hints, not actions — reading a card never invokes them.

## JSONL index format

`TDMCP_RAG_DATA_DIR/index.jsonl` (gitignored). One JSON object per line, one per
embedded card:

```json
{"id":"<sha256>","contentHash":"<sha256>","embeddingModel":"nomic-embed-text","embedding":[0.0123,-0.045, ...],"title":"...","type":"artwork","license":"PublicDomain","tags":["geometric"],"sourceUrl":"...","sourceName":"..."}
```

Search loads the JSONL into memory, computes cosine similarity between the query
embedding and each row, applies `license`/`type`/`tags` filters, and returns
top-k. For the MVP corpus size (hundreds of cards), in-memory cosine is
instant and dependency-free.

## Ollama embedding flow

`index` reads each card, computes its `contentHash`, and skips any card already
embedded with the same `contentHash` + `embeddingModel` (cache). For the rest it
calls `POST {ragOllamaUrl}/api/embed` with `{ "model": ragEmbedModel, "input": ["<card text>", ...] }`
and reads `{ "embeddings": [[...]] }` (the legacy single `{ "embedding": [...] }`
shape is also accepted). Failures raise typed
`OllamaConnectionError` / `OllamaTimeoutError` / `OllamaApiError` (mirroring
`src/td-client/types.ts`); the CLI reports them cleanly and the server is
unaffected.

## Troubleshooting

- **Ollama offline / `ECONNREFUSED 127.0.0.1:11434`.** Start the daemon:
  `ollama serve &`. Override the URL with `TDMCP_RAG_OLLAMA_URL` if you run it
  on another host/port.
- **Model not pulled.** Ollama returns a "model not found" error on the first
  `index`/`search`. Run `ollama pull $TDMCP_RAG_EMBED_MODEL` (default
  `nomic-embed-text`).
- **Empty source allowlist / nothing synced.** `sync` accepts `--source` and
  `--limit`. With no `--source`, all live sources run with the default per-run
  cap. Key-gated sources (Smithsonian, Europeana) are silently skipped when
  their `TDMCP_RAG_*_KEY` env is unset — the log line says so, but `sync`
  returns success.
- **Non-writable data dir.** `TDMCP_RAG_DATA_DIR` (default `.tdmcp/creative-rag`)
  must be writable. Permission errors surface as typed errors from `sync`/`index`.
- **Unexpected tombstone.** A card is tombstoned only when **its own source
  successfully synced this run and did not re-emit the id**. If you see one
  unexpectedly, the upstream removed (or relicensed-away) the item. Re-running
  `sync` will pick up the latest state; the tombstone is auditable history,
  not data loss.
- **LanceDB warned, fell back to JSONL.** `TDMCP_RAG_BACKEND=lancedb` requires
  the optional `@lancedb/lancedb` dependency. Install it explicitly
  (`npm install @lancedb/lancedb`) or accept the default JSONL backend.

## Limits

- **LanceDB is experimental and opt-in.** The default backend is in-memory
  cosine over JSONL, with no native deps. `TDMCP_RAG_BACKEND=lancedb` enables the
  LanceDB store via the **optional** `@lancedb/lancedb` dependency (not in the
  default install; falls back to JSONL when absent) — see the LanceDB backend
  section above.
- **Seven live sources.** Four keyless museum APIs plus Smithsonian, Wikimedia
  Commons, and Europeana (all verified against a real sync). Six more remain
  planned stubs (above).
- **Bounded sync.** Not a full mirror; a per-run item cap.
- **Multilingual swap.** `nomic-embed-text` (default) is English-leaning. To
  index a Portuguese, Spanish, French, or mixed repertoire, set
  `TDMCP_RAG_EMBED_MODEL=bge-m3` (or the larger `mxbai-embed-large`) and run
  `ollama pull bge-m3`. Then rebuild the index: `tdmcp creative-rag index
  --rebuild`. Switching models **invalidates existing index lines** (their stored
  `embeddingModel` no longer matches the runtime model); `--rebuild` re-embeds
  everything with the new model. See the env table above for the full config
  reference.
- **No write tools.** Read-only resource + CLI only.
