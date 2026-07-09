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

## Release execution

- Public bootstrap/self-install URLs were advanced to v0.13.1 after the PR merged
  to `main`, immediately before creating the release tag.
- The `v0.13.1` tag and GitHub Release should point at the `main` commit that
  includes those advanced pins.
- npm publish is handled separately by the package owner; verify
  `@dpantani/tdmcp@0.13.1` against npm after publication completes.
- The post-CI TouchDesigner `.tox` release asset remains a required follow-up
  after the GitHub Release workflow publishes `tdmcp.mcpb`.
