---
name: tdmcp-troubleshooting
description: Diagnose tdmcp and TouchDesigner bridge problems with bounded checks and evidence-backed recovery steps.
---

# tdmcp troubleshooting

Use this skill when tdmcp cannot reach TouchDesigner, a structured operation fails, a node cooks
with errors, or the observed network differs from the requested result.

## Diagnose in layers

1. Check local runtime status: package version, configuration source, bridge URL, authentication
   readiness, and whether the endpoint is reachable.
2. If reachable, read bridge info and TouchDesigner build before testing mutating operations.
3. Inspect the exact operator path, parameters, connections, cook errors, and preview relevant to
   the failure.
4. Distinguish unsupported endpoint, invalid input, authorization failure, timeout, connection
   refusal, and TouchDesigner-side error. Do not collapse them into "offline".
5. Reproduce with the smallest structured read or mutation. Do not use arbitrary Python merely to
   bypass a missing first-class operation.

## Recovery boundaries

- Do not disable authentication or enable raw execution as a generic repair.
- Do not delete or overwrite artist content to make a health check pass.
- Preserve the configured bridge port; parallel analysis or test bridges must use isolated ports.
- After a repair, repeat the original bounded check and report both the prior failure and current
  evidence.
- If a check requires a running UI, hardware, pane, or saved project, mark it unverified when that
  dependency is absent.

Useful evidence includes exact endpoint status, typed error code, operator path, parameter name,
TouchDesigner build, and the command or tool result that verified recovery. Redact tokens and
project-sensitive content.
