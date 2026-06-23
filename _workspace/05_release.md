# tdmcp 0.10.0 release preparation

Date: 2026-06-23
Status: prepared, not tagged or published

## Version

- Target version: `0.10.0`
- Base released version: `v0.9.0`
- `v0.9.0` GitHub Release/tag was backfilled on 2026-06-23 and points to `b10221d7026bad963ea605e24649b1f7e34d9deb`, the scoped npm package restoration commit.

## Prepared

- Bumped package and published metadata versions to `0.10.0`: `package.json`, `package-lock.json`, `server.json`, `dxt/manifest.json`, and `safeskill.manifest.json`.
- Promoted the existing post-0.9.0 `CHANGELOG.md` entries into `## [0.10.0] - 2026-06-23`.
- Updated `CHANGELOG.md` compare links for `Unreleased`, `0.10.0`, and `0.9.0`.
- Updated `docs/ROADMAP.md` so it no longer says the latest GitHub Release is `v0.8.3`.
- Updated bootstrap/install pins to `v0.10.0` with `scripts/sync-manifest-version.mjs` so the `0.10.0` package installs matching bridge modules.

## Shipping Scope

- Recipe library depth (G3), including 18 new first-party recipes and expanded validation.
- AI Show Director mixer scene arming dry-run MVP with approval recheck boundaries.
- Coverage CI gate, exec-off smoke coverage and Connectors Directory prep.
- Docs completeness for v0.7/v0.8 arcs and the API stability pin.
- Hand gesture bus and hand hologram controls.
- Creative RAG and Project RAG follow-ups, including cross-RAG fusion, Project RAG sources, bridge-quarantine analysis and MCP surfaces.
- CI validation hardening and Node engine floor alignment.

## Held Back

- `v0.10.0` npm publish, GitHub tag and GitHub Release are not performed in this preparation step; the bootstrap URLs intentionally point to the future `v0.10.0` release tag that will exist before publication.
- Live TouchDesigner cook validation remains pending where the changelog marks it `UNVERIFIED-pending-td`.
- Connectors Directory acceptance remains an external process.
- Project RAG live bridge validation on a real quarantine `9981` TouchDesigner remains unverified until a reachable bridge is available.

## Validation

- `npm ci` completed; npm reported 7 dev/dependency-tooling audit findings.
- `npm audit --omit=dev --json` reported 0 production vulnerabilities.
- `npm run typecheck` passed.
- `npm run validate:recipes` passed: 50/50 recipes valid.
- `npm run test:bridge` passed: 213 Python bridge tests.
- `npm run build` passed.
- `npm run docs:build` passed and regenerated 318 tool docs without a tracked diff.
- `npm run test` passed: 440 test files, 4563 tests.
- `npm run lint` passed: Biome checked 1081 files.
- `node scripts/sync-manifest-version.mjs` updated bootstrap/install pins to `v0.10.0`.
