---
title: Tool API contract
description: The stable contract every tdmcp MCP tool follows — invariants every client can rely on as the project consolidates toward 1.0.
---

# Tool API contract

This page documents the invariants every tdmcp MCP tool follows from v0.8.x
onward and that will be **frozen at 1.0**. The full per-tool reference is the
generated [Tools reference](./tools); this page covers the rules behind it so
clients (Claude / Cursor / Codex / custom MCP clients) can rely on a stable
shape.

Changes that break any invariant below require a major version bump.

## 1. Naming

- Tool names are `snake_case`, registered via `server.registerTool(name, …)`
  inside the file's `registerX` function.
- A name shipped under a tagged release stays the same identity from 1.0
  forward. A renamed tool keeps an alias under the old name for at least one
  minor release before the alias is dropped.

## 2. Input schema

- Every tool defines a Zod schema and exposes it as
  `inputSchema: schema.shape`.
- Any field declared with `.default(...)` is **optional from the client's
  point of view** — the server fills the default before calling the
  implementation.
- Required fields stay required; making a required field optional is
  non-breaking, but the reverse (tightening) requires a major bump.

## 3. Error handling

- A handler **never throws**. Validation failures and TouchDesigner errors are
  serialized into `isError: true` results via the `errorResult` helper.
- TouchDesigner-side failures are normalized by `friendlyTdError` so the
  client sees a single readable shape regardless of which `TdError` subtype
  was raised by the bridge client.

## 4. Offline behavior

- When the TouchDesigner bridge is unreachable, a tool returns
  `isError: true` with a friendly message ("TouchDesigner bridge not running
  at…") instead of timing out silently or crashing the server.
- The MCP server itself stays up — every other tool, resource, and prompt
  remains callable while the bridge is offline.

## 5. Result shape

- `content[0].text` is a short human-readable description of what happened —
  safe to surface to an end user.
- `structuredContent` is the machine-readable payload. New keys are
  **additive**; existing keys keep their type and meaning across minor
  versions.
- A tool that returns no useful structured payload may omit
  `structuredContent`, but if it ever ships one it does not later remove it.

## 6. Deprecation policy

- A tool flagged for removal is first marked deprecated in the registry, kept
  registered as an alias, and stays callable for at least one minor release.
- The deprecation note documents the replacement tool (if any) so MCP clients
  can migrate without guessing.

## What this is **not**

- Not a per-tool spec — that's [Tools reference](./tools), regenerated from
  the live registry on every docs build.
- Not a promise that every internal helper is stable — only the registered
  tool surface is.
- Not a freeze on adding new tools. The contract governs **how** tools behave,
  not how many ship.
