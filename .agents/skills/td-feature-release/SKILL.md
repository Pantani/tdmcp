---
name: td-feature-release
description: "Release tdmcp: write the Keep-a-Changelog entry, bump the SemVer version across every manifest, then (autonomously, per project policy) commit, tag, and push — gated on a td-qa PASS, with hard git safety rails. Use when releasing/shipping/cutting a tdmcp version, writing the CHANGELOG, bumping the version, or tagging a release."
---

# td-feature-release — cut and push a version

You convert QA-passed features into a released, pushed version. Project policy authorizes autonomous commit + tag + push. Autonomy ≠ recklessness — the hard rails below always hold.

## Gate first

Do not release unless `td-qa`'s report is **PASS** for everything shipping. Features marked FAIL or critical-UNVERIFIED are held for the next cycle — say which, don't quietly drop or ship them.

## Procedure

1. **CHANGELOG** (`CHANGELOG.md`) — Keep a Changelog format. Add a dated version section with `### Added` / `### Changed` / `### Fixed`. One bullet per feature: what it delivers + its CLI command (pull these from the integrator's shipped-features list). Update the version link reference at the bottom to the new tag.
2. **Version bump (SemVer)** — minor for new features, patch for fixes. Bump **every** manifest that carries a version and confirm they're identical afterward (a cross-manifest version mismatch is a classic release bug): `package.json`, the `.dxt`/plugin manifest, and any version synced into `scripts/setup.mjs` / docs. Grep the repo for the old version string to catch them all.
3. **Commit** — match the repo's commit style (read `git log`: `feat`/`fix`/`docs`/`chore(release)`). Stage by explicit path, message via HEREDOC, end with the `Co-Authored-By: Codex` trailer.
4. **Tag** `vX.Y.Z` and **push** the commit + tag.

## Hard safety rails (always, even autonomous)

- **Stage by explicit path — never `git add -A` / `git add .`.** Concurrent agents may have in-flight files on this branch; stage only what this release intends.
- **Never commit secrets** (`.env`, credentials, tokens). If staged, unstage and flag.
- **New commits only — never `--amend`** a shared/published commit.
- **Never skip hooks** (`--no-verify` / `--no-gpg-sign`). If a pre-commit hook fails, the commit did NOT happen — fix the cause, re-stage, and make a NEW commit (do not amend).
- **Never force-push to `main`/`master`.** If push is rejected (remote ahead), fetch + reconcile; never force a shared branch.

## Output

The CHANGELOG edit + version bumps + commit + tag + push, and a release note at `_workspace/05_release.md`: the version, commit SHA, tag, what shipped, and what was held back (with reason). Done when the tagged commit is pushed and the tree is clean (except deliberately-unstaged concurrent work).

## Follow-up releases

If `_workspace/05_release.md` exists, read the last shipped version, compute the next bump from it, and add a new CHANGELOG section — never re-tag the same version.
