---
title: API stability & deprecation policy
description: The v1.0 API-stability pin for tdmcp — what counts as the public tool contract, the no-breaking-change guarantee across a minor cycle, and the one-minor-warn / next-minor-remove deprecation policy.
---

# API stability & deprecation policy

This page is the formal **stability pin** for the tdmcp tool API on the road to
1.0 (roadmap gate **G1**). It states *what is held stable*, *for how long*, and
*how a change is allowed to break it*.

It is a companion to the [Tool API contract](./tool-contract), which documents
the behavioural invariants every tool follows (naming, input schema, error
handling, offline behaviour, result shape, deprecation mechanics). This page does
**not** restate those rules — it pins them: it defines the surface they apply to,
the guarantee window, and the deprecation timeline. At 1.0 these two pages fold
into a single frozen contract.

## What the public API surface is

The "tdmcp tool" contract has exactly two parts, both read from source:

1. **The `ToolContext` shape** — the dependency-injection object passed to every
   tool handler (`src/tools/types.ts`).
2. **Each tool's Zod `inputSchema`** — the per-tool argument schema exposed via
   `inputSchema: schema.shape`, registered through `server.registerTool(...)`.

Anything not in these two — internal helpers, the bridge REST wire format, the
Python bridge modules in `td/`, the knowledge-base layout, CLI internals — is
**not** part of the pinned public surface and may change in a minor release.

### `ToolContext` fields (as of the v0.9 line)

`ToolContext` (`src/tools/types.ts`) is the injected dependency bundle. Required
fields are always present; optional fields may be `undefined` when the
corresponding feature is off, and a handler **must** degrade gracefully when an
optional dependency is absent.

| Field | Required | Purpose |
| --- | --- | --- |
| `client` | yes | `TouchDesignerClient` — the HTTP client to the TD bridge. |
| `knowledge` | yes | `KnowledgeBase` — embedded operator / Python / pattern reference. |
| `recipes` | yes | `RecipeLibrary` — validated network templates. |
| `logger` | yes | `Logger` — structured logging. |
| `vault?` | no | `Vault` — Obsidian vault, set via `TDMCP_VAULT_PATH`; `undefined` when unconfigured. |
| `allowRawPython?` | no | Whether raw-Python escape-hatch tools may register. `undefined` means allowed (default); only an explicit `false` locks them out. |
| `toolProfile?` | no | Tool-exposure profile; `"safe"` hides destructive/raw-code tools, `"directory"` exposes a compact registry-facing tool set, and `undefined` means `"full"` (default). |
| `llm?` | no | Best-effort LLM backend (vision/captioning/text). Tools must degrade when it is `undefined` or unreachable. |
| `server?` | no | The live `McpServer`, assigned before registration so a few tools can introspect the registry. |
| `creativeRag?` | no | Optional local Creative RAG service (`TDMCP_RAG_ENABLED=1`); backs read-only `tdmcp://creative/*` resources only. |
| `projectRag?` | no | Optional local Project RAG service (`TDMCP_RAG_ENABLED=1 && TDMCP_PROJECT_RAG_ENABLED=1`); backs read-only `tdmcp://project/*` resources only. |

This table is descriptive, not the source of truth — `src/tools/types.ts` is.
The stability **rule** below is what is pinned, not this exact field list (the
list grows by additive optional fields over time).

## The stability guarantee

Across **one full minor release cycle** (one tagged minor with no breaking
change), tdmcp guarantees:

- **No breaking change to `ToolContext`.** Adding a new **optional** field is
  allowed and non-breaking. **Renaming** a field, **removing** a field, changing
  a field's type, or **adding a required** field is breaking and not allowed
  within the cycle.
- **No breaking change to any existing tool's `inputSchema`.** Adding a new
  **optional** field (typically via `.default(...)` or `.optional()`) is allowed.
  **Renaming** a field, **removing** a field, **tightening** a type, or making a
  previously **optional field required** is breaking and not allowed.

A field declared with `.default(...)` is optional from the client's point of
view — the server fills the default before the handler runs — so adding one never
breaks an existing caller.

| Change | Verdict |
| --- | --- |
| Add a new optional `ToolContext` field | ✅ non-breaking |
| Add a new tool | ✅ non-breaking |
| Add an optional / defaulted field to a tool schema | ✅ non-breaking |
| Make a required tool-schema field optional | ✅ non-breaking |
| Rename or remove a `ToolContext` field | ❌ breaking |
| Add a required `ToolContext` field | ❌ breaking |
| Rename or remove a tool-schema field | ❌ breaking |
| Make an optional tool-schema field required, or tighten its type | ❌ breaking |
| Remove a registered tool with no warn cycle | ❌ breaking |

Any change marked breaking requires a **major** version bump.

## How this is enforced

`npm run api:check` runs as the **Tool API Stability** job in CI and as part of
`npm run release:check`. It reads the surface from source, using the real tool
registry and the TypeScript compiler, and compares it with the committed baseline
in `api-surface/baseline.json`. For each tool it asks whether the new schema still
accepts everything the baseline accepted. The check fails when:

- a change is breaking under the table above and has not been acknowledged;
- a custom Zod refinement is added to an existing field, or a `.refine()` or
  transform is rewritten;
- `package.json` has moved to a version the baseline does not pin.

Additive changes pass without touching the baseline. A changed default is printed
as a note, because this policy does not classify it.

### Acknowledging an intentional break

A failing run prints an `id` for each break. To accept one, add it to
`api-surface/acknowledged-breaks.json` with the reason, in the same PR:

```json
{
  "acknowledged": [
    {
      "id": "tool:find_td_nodes|.limit|bound-tightened:maximum|d4e5f6a7",
      "reason": "Caps the result size to protect the bridge. Agreed in #123; major bump planned."
    }
  ],
  "history": []
}
```

An `id` includes a hash of the exact change, so an acknowledgement does not cover
a later, further tightening of the same field. An acknowledgement that no longer
matches a break fails the check until it is removed. Acknowledging a break does
not change this policy: it still needs the major bump described above, and it
still counts against the G1 cycle.

### At each release

Run `npm run api:update` in the same commit as the version bump, so the baseline
pins what the release ships. It refuses to run while a break is unacknowledged. It
moves acknowledged breaks to `history` with the version that accepted them, which
is the record to check when judging a G1 cycle. Copy them into `CHANGELOG.md`.

### What the check cannot see

- **Handler behaviour.** A handler that starts rejecting an input the schema still
  accepts is not detected.
- **The inside of a `.superRefine()`.** Zod hides its body in a closure, so adding
  one is detected but rewriting one is not. Values a `.refine()` captures from an
  enclosing scope are not compared either.
- **Types behind `ToolContext` fields.** The field's type text is compared, not the
  definition of a type it names, such as `TouchDesignerClient`.

A tool counts as deprecated, and so removable without an acknowledgement, only if
its description starts with `Deprecated`. Removing it in a patch of the minor that
announced the deprecation still fails.

A Zod upgrade can change what a built-in check accepts. The check reports that as a
break to review, because it reaches clients the same way a schema edit does.

## Deprecation policy

Removals are never silent. The policy is **one-minor warn, next-minor remove**:

1. **Warn (minor _N_).** The item is marked deprecated:
   - a `CHANGELOG.md` entry under that minor records the deprecation and names
     the replacement (if any);
   - the tool's **description** is annotated as deprecated so MCP clients see it
     at the call site;
   - the tool stays **registered and callable** — for a renamed tool, the old
     name is kept as an alias.
2. **Remove (minor _N+1_).** No earlier than the next minor, the deprecated item
   (or alias) is removed, and the removal is recorded in `CHANGELOG.md`.

So any deprecated tool or alias stays callable for **at least one full minor
release** after the deprecation is announced, giving clients a window to migrate
without guessing. Where there is a replacement, the deprecation note points to
it.

## Relationship to G1 and 1.0

Roadmap gate **G1 — Tool API stability** has two parts: completing one tagged
minor cycle with no breaking change to the surface above, and this
`API_STABILITY.md` pin. This file satisfies the second part. When 1.0 ships, the
guarantee window widens from "one minor cycle" to "the 1.x line": breaking the
pinned surface then requires a **2.0** major bump, and this page plus the
[Tool API contract](./tool-contract) become the single frozen contract clients
can build against.

### When the clock starts

The cycle is measured from a **baseline tag** to the **next tagged minor**. It
completes when that minor, and every tag between it and the baseline, has no
breaking change against the baseline. A breaking change in any tag, patches
included, makes that tag the new baseline.

**The current baseline is v0.13.2**, so G1's first part closes when v0.14.0 is
tagged with no breaking change against it.

v0.13.2 reset the clock. It was a patch release, yet it tightened existing fields
without a major bump, contrary to the guarantee above:

| Tool | Fields tightened in v0.13.2 |
| --- | --- |
| `find_td_nodes` | `limit`, `parent_path`, `pattern`, `type` |
| `focus_network_editor` | `paths` |
| `add_custom_parameters` | `comp_path`, `page`, `params`, including stricter `params[]` entries that now reject unknown keys |
| `plan_visual` | `description` |

These limits stay in place. Calls that fall outside them now fail validation.
