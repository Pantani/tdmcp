# v0.13.2 release preparation

Date: 2026-08-11
Target version: 0.13.2
Source branch: main
Source before release-prep edits: `2640f18f970b591771f58d3b1624259944d8736b`

## Prepared locally

- Bump `package.json`, `package-lock.json`, MCPB/server/safeskill manifests and
  both TouchDesigner bridge-version probes to 0.13.2.
- Advance bootstrap and self-install references to `v0.13.2` so the npm package,
  future tag and generated `.tox` resolve to the same source tree.
- Promote the post-v0.13.1 CHANGELOG entries into the dated 0.13.2 section and
  align the roadmap with the 0.13.2 release candidate.
- Build and inspect the MCPB and npm tarball locally.
- Export and hash the tag-pinned TouchDesigner bridge `.tox` from a disposable
  live TouchDesigner project.

## Publication boundary

- npm publication is intentionally left to the package owner.
- No commit, push, tag, GitHub Release or release-asset upload is part of this
  preparation pass.
- The `v0.13.2` tag must point at the exact source used for npm publication so
  bootstrap URLs inside the package resolve to matching code.
- After the tag workflow publishes `tdmcp.mcpb`, attach the already verified
  `tdmcp_bridge_package.tox` to the same GitHub Release and compare its hash.

## Validation evidence

- **PASS — release gate:** `npm run release:check` passed after the dependency
  refresh: typecheck, Biome, 60/60 recipe validation/lint, 6,227 passing Vitest
  tests (1 skipped), 705 passing bridge tests, TypeScript build and MCPB build.
- **PASS — docs:** `npm run docs:build` generated the 508-tool reference, the
  three-skill discovery index, 14/14 availability checks and the VitePress site.
- **PASS — CI quality gates:** Ruff, dependency-cruiser, cyclomatic/cognitive
  complexity ratchets, Bottobot import and agent-catalog generation all pass.
- **PASS — coverage:** 711 Vitest files passed with 86.94% statements, 74.03%
  branches, 86.86% functions and 88.84% lines.
- **PASS — dependencies:** both `npm audit` and `npm audit --omit=dev` report
  zero vulnerabilities after refreshing patched transitive versions.
- **PASS — MCPB:** `tdmcp.mcpb`, 9,480,205 bytes,
  SHA-256 `95426d4e3284acf0bc44751cbe3ced02832b47a92b0a3fc806d0335cbcad491d`.
- **PASS — npm tarball:** `dpantani-tdmcp-0.13.2.tgz`, 9,941,274 bytes,
  SHA-256 `a65bfe9fe9ee1fda7d7ecb722bd5d2ffcdf41301a2e4b24d3379cb2f03b386be`.
  The real tarball passed `npm publish --dry-run --access public`; its package,
  README and bridge bootstrap were inspected at `0.13.2` / `v0.13.2`.
- **PASS — TouchDesigner `.tox`:** `dist/tdmcp_bridge_package.tox`, 3,342 bytes,
  SHA-256 `7f2809c04a3de1acb697c9a77422f025cd75fc986e293f21dab35b36c1447dba`.
  It was exported from a disposable live TouchDesigner project with the exact
  `repo_zip=https://github.com/Pantani/tdmcp/archive/refs/tags/v0.13.2.zip`
  argument. `export_package()` embeds that value into the package callback,
  README and `Repozip` parameter before saving the COMP. The `.tox` is an opaque
  TouchDesigner binary, so the embedded URL is not independently recoverable
  with ordinary archive or string-inspection tools.
