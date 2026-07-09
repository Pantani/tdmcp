# v0.13.1 release prep

Date: 2026-07-09
Target version: 0.13.1
Branch: Pantani/cx/prepare-v0.13.1

## Prepared in this PR

- Bump package, lockfile, MCPB manifest, server metadata, safeskill manifest, and TouchDesigner bridge-version probes to 0.13.1.
- Promote the current CHANGELOG Unreleased entries into 0.13.1.
- Keep public bootstrap/self-install URLs pinned to v0.13.0 during PR review; they must be advanced to v0.13.1 immediately before creating the tag.

## Shipped content

- RayTK native integration through editable ROP node graphs:
  - `create_raytk_op`
  - `create_raytk_scene`
  - `tdmcp://raytk/operators`
  - `tdmcp://raytk/operators/{category}`
- RayTK package version-gate correction for TD 2025.30770+.
- Glama/MCP directory metadata and tool-description fixes for `TDMCP_TOOL_PROFILE`.
- Creative RAG Smithsonian URL fallback fix for records missing `record_link`.

## Held back until after merge

- No tag was created.
- No GitHub Release was created.
- No npm publish was run.
- No post-CI TouchDesigner `.tox` release asset was generated or uploaded.
