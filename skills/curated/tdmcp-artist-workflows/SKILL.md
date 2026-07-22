---
name: tdmcp-artist-workflows
description: Build and refine TouchDesigner projects with tdmcp using context-first, visible, reversible workflows.
---

# tdmcp artist workflows

Use this skill when an artist asks you to create, modify, inspect, or explain a TouchDesigner
network through tdmcp.

## Working loop

1. Read the current editor or project context before interpreting phrases such as "this node",
   "the selected operator", or "put it here". If context is absent, ask for an explicit path.
2. Inspect the smallest useful network scope. Do not dump an entire project when one COMP or
   operator answers the question.
3. Prefer structured tdmcp tools over raw Python. Keep the bridge usable when raw execution is
   disabled.
4. State the intended nodes, connections, placement, and destructive effects before mutation.
5. Make the smallest coherent change, then read the affected paths back and report actual state.
6. Use previews and node errors when visual or cook correctness matters. Never claim a visual
   result from request success alone.

## Network construction

- Give every created operator a deterministic name and explicit editor coordinates.
- Lay out inputs and controls on the left, processing in ordered rows, and outputs or previews on
  the right. Keep names, flags, and viewers readable.
- Preserve existing nodes and connections unless replacement was requested.
- Use idempotency keys or existing-path checks when repeating a build could duplicate content.
- Prefer native parameter modes, expressions, binds, and exports over flattening reactive state.

## Communication

Return concise paths, applied actions, warnings, and verification evidence. Separate offline
validation from checks actually performed in a running TouchDesigner instance. Mark anything
that needs a live bridge as unverified instead of inferring success.
