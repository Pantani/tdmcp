# Project RAG

> Status: **experimental — F0 foundations only**. Sources/extractors land in F1.

Project RAG is the **technical/project repertoire** sibling to
[Creative RAG](./CREATIVE_RAG.md). It indexes **TouchDesigner projects,
components, snippets and tutorials** with mandatory provenance + license on
every card, so the agent can answer "show me a real `.tox` someone shipped that
does hand tracking with MediaPipe" — and always shows where the file came from
and how you may use it.

It is **opt-in**, **offline-first**, and the search path **never touches the
TouchDesigner bridge, DMX, or Python exec**. The opt-in bridge-quarantine
analyzer (F3) uses a *separate* TD instance on a dedicated port (default
`9981`), never the user's active 9980 bridge.

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

## CLI surface (F0)

```bash
tdmcp project-rag sources          # list configured source slots + status
tdmcp project-rag sync             # (F0: no sources wired yet)
tdmcp project-rag index            # (F0: 0/0/0 reports)
tdmcp project-rag search <query>   # (F0: empty results)
tdmcp project-rag info <id>        # show one card (provenance + license + score)
```

F1 wires the first real sources (`derivative-local` + `github-repo` allowlist
with `torinmb/mediapipe-touchdesigner` MIT and `DBraun/TouchDesigner_Shared`
GPL-3.0). F2 adds the topic scanner, awesome-list discovery, scoring. F3 adds
opt-in bridge-quarantine analysis. F4 wires MCP prompts and a copilot tool.

## MCP resources

Registered ONLY when both gating flags are set:

- `tdmcp://project/cards/{id}` — one card (id = sha256 of `provenance.canonical`).
- `tdmcp://project/search{?q,k,license,type,tags,operator}` — cosine search;
  every result carries provenance + license + rightsNotes.

## Hard rules (security)

- The search path never spawns Python or talks to the active TD bridge.
- The F3 bridge-quarantine analyzer (when enabled) uses a *new*
  `TouchDesignerClient` against `TDMCP_PROJECT_RAG_BRIDGE_PORT` (default 9981).
  tdmcp never auto-spawns a TD process for it.
- Downloaded `.toe`/`.tox` files are NEVER opened in the user's active project.
- Static `.toe`/`.tox` extraction runs under a strict timeout in an isolated
  subprocess with a reduced env.
- License matrix is enforced before any binary is persisted —
  `Derivative-EULA`/`Proprietary-*`/`Unknown`/`Restricted` cards never get
  their binaries stored locally, even if the allowlist would permit it.

See `_workspace/01_design_project_rag.md` for the full design and
`_workspace/01_plan_project_rag_implementation.md` for the phased roadmap.
