---
description: "Teach tdmcp your taste in TouchDesigner — a persistent session profile plus corpus-learning tools that distil your palettes, naming and favourite generators so the AI builds in your style."
---

# Session profile & corpus learning

By default every conversation starts cold. This arc lets tdmcp **remember your
taste** across sessions: a persistent profile the AI loads in one read, fed by
tools that learn your conventions from a live project, from your own library of
notes, or from a standing record of your preferences.

Reach for this when you find yourself repeating the same instructions — "always
magenta on black", "name containers in snake_case", "I prefer the particle flock
over the GPU field" — and want the assistant to start from your style instead of
a generic default.

## The session profile

**`load_session_profile`** (the AI-layer tool) reads or initialises
`~/.tdmcp/session-profile.json` — a cross-session snapshot that caches the latest
outputs of the learning tools below. It returns a unified JSON with a
`loaded_at` timestamp and `style_memory`, `recent_work`, `conventions` and
`corpus_style` sections, creating sensible defaults if no file exists. Override
the path with `TDMCP_SESSION_PROFILE_PATH`.

The same data is exposed read-only as the **`tdmcp://session/profile`** MCP
resource, so an agent can pull all your preferences in a single resource read at
the start of a turn.

> *"Load my session profile so you know my style before we build."*

## The learning tools

These four tools (the vault group — they need an
[Obsidian vault](/reference/tools#obsidian-vault) via `TDMCP_VAULT_PATH`)
populate the profile. None of them mutate your TouchDesigner project:

- **`style_memory`** reads, updates or summarises a standing `Memory/style.md`
  note — your long-lived record of palettes, default energy, banned moves,
  favourite generators and naming/layout conventions. Modes: `show` (a compact
  one-line context for the LLM), `read` (full structured), `update` (field-wise
  merge).
- **`learn_conventions`** walks a live TouchDesigner subtree read-only and
  extracts your house conventions — naming case, colour tags, container shapes,
  parameter defaults, layout direction — writing them to `Memory/conventions.md`
  and optionally merging confident signals into `Memory/style.md`. No TD
  mutations.
- **`learn_from_my_corpus`** is the offline companion: it walks your vault corpus
  (Recipes, Components, Looks, Setlists, Moodboards) and distils palette, naming,
  recipe-shape and parameter preferences into `Memory/corpus_style.md`. No
  TouchDesigner required — pure filesystem read.
- **`recall_similar_work`** ranks your memory notes by similarity to a visual
  goal (query tokens plus tag/operator overlap) and returns the closest prior
  recipes, params and prompts so the agent can reuse them.

> *"Learn my conventions from `/project1`, then learn from my vault corpus, and
> update my style memory with anything you're confident about."*

## A typical flow

1. Configure a vault (`TDMCP_VAULT_PATH`) and build a few things you like.
2. Run `learn_conventions` on a project you're proud of and `learn_from_my_corpus`
   over your saved looks; both write to `Memory/*.md`.
3. Run `load_session_profile` to fold those into `~/.tdmcp/session-profile.json`.
4. In future sessions, the AI reads `tdmcp://session/profile` (or you say *"load
   my profile"*) and builds in your style from the first prompt.

## Related: the optional RAG libraries

Corpus learning above is about *your own* taste. tdmcp also ships two opt-in,
local-only retrieval libraries that broaden the well the AI draws from — both
gated behind `TDMCP_RAG_ENABLED=1` and off by default:

- **Creative RAG** — a curated repertoire of techniques and references, exposed
  as `tdmcp://creative/cards/{id}` and `tdmcp://creative/search`. See
  [Creative RAG](/creative-rag).
- **Project RAG** — a local index of TouchDesigner projects/components (also
  needs `TDMCP_PROJECT_RAG_ENABLED=1`), exposed as `tdmcp://project/cards/{id}`,
  `tdmcp://project/search` and `tdmcp://project/sources`. See
  [Project RAG](/project-rag).

Both are read-only and always carry source URL, license and rights notes on every
result. They are documented in full on their own pages; this guide covers the
always-on session-profile path.

## Profile versus project brief

The session profile is user-scoped taste shared across projects. The project brief
is project-scoped intent stored inside that project's `.tdmcp` directory, with an
optimistic revision required for replacement. The local copilot can use both as
untrusted evidence, but neither can override the current request or safety policy.
See [Project context & turn receipts](/guide/project-context-receipts).

## See also

- [Working from your own notes (Obsidian vault)](/guide/prompt-cookbook#working-from-your-own-notes-obsidian-vault)
  in the prompt cookbook.
- [MCP resources](/guide/mcp-resources) for the full `tdmcp://…` resource map.
