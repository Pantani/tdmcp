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

1. the three museum HTTP APIs, during an explicit `creative-rag sync`; and
2. the local Ollama embeddings endpoint, during `creative-rag index`.

Both are local/opt-in and isolated: an Ollama or network failure surfaces as a
typed error and **never** brings down other tools or the server.

## Included sources (MVP)

Three open-data museum APIs, all keyless and license-aware per item:

| Source | API base | License signal | Notes |
|--------|----------|----------------|-------|
| Art Institute of Chicago | `https://api.artic.edu/api/v1` | `is_public_domain` (boolean) ⇒ `PublicDomain`, else `Unknown` | IIIF image URL built from `config.iiif_url` + `image_id`. |
| The Met | `https://collectionapi.metmuseum.org/public/collection/v1` | `isPublicDomain` (boolean) ⇒ `PublicDomain` / CC0, else `Unknown` | Two-step: `search` → `objects/{id}`. |
| Rijksmuseum | `https://data.rijksmuseum.nl` | Linked-Art rights statement ⇒ `CC0` / `PublicDomain` / `Unknown` | Two-step: `search/collection` (OrderedCollectionPage) → resolve each `id` as Linked-Art JSON. Keyless. |

> Sync pulls a **bounded** number of items per source (default 10, configurable
> per run via `--limit`) to keep the MVP fast and polite to the upstream APIs.
> It is not a full mirror.

## Planned sources (stubs)

Ten further sources are scoped but **not** implemented in the MVP. They ship as
documented stubs with `status: "planned"` and an explicit reason, so the build
team and users know *why* each is deferred. None are wired into `sync`.

| Source | Reason deferred |
|--------|-----------------|
| Europeana | Requires an API key (auth) and per-provider rights vary widely (ambiguous license). |
| Wikimedia Commons / Wikidata | Licenses are per-file and mixed (CC-BY-SA, CC0, fair-use); needs robust per-asset rights parsing before binaries can be trusted. |
| Smithsonian Open Access | Requires an API key (auth). |
| Cleveland Museum of Art | Open API, but rights field needs verification per item; deferred to keep MVP to three confirmed shapes. |
| Harvard Art Museums | Requires an API key (auth). |
| Cooper Hewitt | Requires an API key (auth). |
| Internet Archive | Mixed/unclear licensing per item (ambiguous license); needs scraping of rights metadata. |
| WikiArt | No official open API; would require scraping (scraping) and licenses are restricted. |
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

All keys are opt-in and parsed/validated in `src/utils/config.ts` (Zod). Env
vars follow the existing `TDMCP_*` convention.

| Env var | Config key | Default | Notes |
|---------|-----------|---------|-------|
| `TDMCP_RAG_ENABLED` | `ragEnabled` | `0` (false) | Master switch. When 0, no resource, no context injection, subcommand is a no-op-with-message. |
| `TDMCP_RAG_DATA_DIR` | `ragDataDir` | `.tdmcp/creative-rag` | Cards, binaries, index live here. Gitignored. |
| `TDMCP_RAG_OLLAMA_URL` | `ragOllamaUrl` | `http://127.0.0.1:11434` | Local embeddings endpoint. |
| `TDMCP_RAG_EMBED_MODEL` | `ragEmbedModel` | `nomic-embed-text` | Must be pulled (`ollama pull nomic-embed-text`). |
| `TDMCP_RAG_LICENSE_ALLOWLIST` | `ragLicenseAllowlist` | `CC0,PublicDomain` | CSV; licenses for which binaries may be stored. |

A future `TDMCP_RAG_BACKEND=lancedb` is **out of MVP scope** (see Limits).

## CLI usage

```bash
# 1. Pull cards from the three sources into TDMCP_RAG_DATA_DIR/cards/ as Markdown
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

## Limits (MVP)

- **No LanceDB / no native deps.** In-memory cosine over JSONL only. A
  `TDMCP_RAG_BACKEND=lancedb` vector store is a documented follow-up, **out of
  scope** here, to keep the default install free of heavy native dependencies.
- **Three sources only.** The other ten are planned stubs (above).
- **Bounded sync.** Not a full mirror; a per-run item cap.
- **English-leaning embeddings.** `nomic-embed-text` is the default; multilingual
  models are a config swap, not redesigned here.
- **No write tools.** Read-only resource + CLI only.
