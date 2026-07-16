---
name: tdmcp-project-safety
description: Apply fail-closed consent, scope, undo, and verification rules to TouchDesigner mutations made with tdmcp.
---

# tdmcp project safety

Use this skill whenever a request can delete, overwrite, bypass, move, rename, save, or otherwise
change artist-owned TouchDesigner state.

## Safety rules

- Fail closed. Missing UI, timeout, disconnect, close, malformed input, or broker failure is never
  approval for a destructive action.
- Use native confirmation flows when the tool provides them. Preserve the exact decision in the
  structured result.
- Never overwrite an existing project file without explicit consent.
- Never call project load or quit unless a future, dedicated feature explicitly authorizes it.
- Do not route panic, blackout, freeze, or other emergency controls through a confirmation queue.
- Treat YOLO or confirmation skipping as an explicit policy flag. Report it; do not infer it from
  missing UI or environment state.
- Keep bearer authentication and bridge authorization intact. Do not expose tokens, secrets,
  project contents, or raw script payloads in logs.

## Mutation discipline

1. Resolve exact paths and preconditions before writing.
2. Describe scope and impact, including whether an operation destroys or merely bypasses state.
3. Prefer one named undoable operation when the runtime proves that behavior. Do not promise
   cross-request atomic undo without live evidence.
4. For multi-field edits, verify every applied field and roll back earlier fields if a later field
   fails.
5. Read the final state back before returning success.

When TouchDesigner or the bridge is unavailable, continue with offline schema and unit validation
but label live behavior `UNVERIFIED — pending bridge`.
