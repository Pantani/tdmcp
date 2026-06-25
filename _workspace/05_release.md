# tdmcp 0.11.0 release preparation

Date: 2026-06-25
Status: prepared, not tagged or published

## Version

- Target version: `0.11.0`
- Base released version: `v0.10.0`
- Base checkout: `7fbf9422749cff075bf42eccad16e2ef8325f74b`
- Registry/release truth checked before prep:
  - npm `@dpantani/tdmcp` latest: `0.10.0`
  - GitHub latest published release: `v0.10.0`
  - GitHub tag/release `v0.11.0`: not present

## Prepared

- Bumped package and published metadata versions to `0.11.0`:
  `package.json`, `package-lock.json`, `server.json`, `dxt/manifest.json`,
  `safeskill.manifest.json`, and `plugins/tdmcp/.claude-plugin/plugin.json`.
- Promoted the existing post-0.10.0 `CHANGELOG.md` entries into
  `## [0.11.0] - 2026-06-25`.
- Updated `CHANGELOG.md` compare links for `Unreleased`, `0.11.0`, and
  `0.10.0`.
- Updated `docs/ROADMAP.md` so the public roadmap says the latest shipped line is
  `v0.10.0` and the source tree is preparing `v0.11.0`.
- Updated bootstrap/install pins to `v0.11.0` with
  `scripts/sync-manifest-version.mjs` so the `0.11.0` package installs matching
  bridge modules after the tag exists.
- Hardened the external-helper supervisor stall-restart unit test timing after
  the first full Vitest release gate exposed a subprocess-startup flake under
  parallel load.

## Shipping Scope

- Claude Code plugin marketplace metadata for tdmcp.
- Bottobot-derived TouchDesigner knowledge resources and read-only agent tools
  for operator docs, Python API search, technique/tutorial lookup, operator-chain
  validation, migration planning, and offline recipe drafting.
- Kinect wall harp command/tool, external Kinect bridge helpers, normalized
  bridge-status outputs, local source-status diagnostics, and
  `diagnose_hardware_environment`.
- English and Portuguese physical-installations and cookbook examples for
  offline TD knowledge workflows, tutorial-to-recipe drafting, and
  operator-chain compare/validate/draft loops.
- Release, CLI, package metadata, SafeSkill, Glama/pnpm Docker, tool-description
  and tool-count hardening.

## Held Back

- `v0.11.0` npm publish, GitHub tag and GitHub Release are not performed in this
  preparation step; the bootstrap URLs intentionally point to the future
  `v0.11.0` release tag that must exist before publication.
- Live TouchDesigner cook validation remains pending where the changelog/docs
  mark flows as setup-specific or `UNVERIFIED-pending-td`.
- Real Kinect/projector venue validation remains setup-specific and must be run
  against the target hardware before calling those physical-installation flows
  live-validated.

## Validation

- `npm ci` passed and reported 0 vulnerabilities.
- `npm audit --omit=dev --json` reported 0 production vulnerabilities.
- `npm run typecheck` passed.
- `npm run validate:recipes` passed: 50/50 recipes valid.
- `npm run test:bridge` passed: 213 Python bridge tests.
- `npm run build` passed.
- `npm run docs:build` passed and regenerated 332 tool docs.
- `npm exec -- vitest run tests/unit/externalHelperSupervisor.test.ts` passed
  after hardening the stall-restart test timing.
- `npm run test` passed on the rerun: 477 test files, 4804 tests.
- `npm run lint` passed: Biome checked 1152 files.
- `npm run build:mcpb` passed with official `@anthropic-ai/mcpb@2.1.2`,
  producing `tdmcp@0.11.0` / `tdmcp-0.11.0.mcpb` at 7.9 MB.
- `npm pack --dry-run --json` passed for `@dpantani/tdmcp@0.11.0`, producing
  `dpantani-tdmcp-0.11.0.tgz` at 7.49 MB packed / 49.52 MB unpacked.
- `git diff --check` passed.
