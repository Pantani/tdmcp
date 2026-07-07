---
name: mcpb-bundle
description: How to migrate the tdmcp Codex Desktop bundle from legacy .dxt to .mcpb (MCP Bundle) and keep it building — covers the manifest schema (verify against the installed packer, never hardcode), the build-mcpb.mjs packer/zip-fallback flow, the npm scripts, and the full .dxt→.mcpb reference sweep across docs and scripts. Use when packaging or migrating the tdmcp desktop bundle.
---

# tdmcp Desktop bundle: .dxt → .mcpb

Anthropic renamed Desktop Extensions from **DXT** (`.dxt`, packer
`@anthropic-ai/dxt`, manifest key `dxt_version`) to **MCPB** (`.mcpb`, packer
`@anthropic-ai/mcpb`, manifest key `manifest_version`). Legacy `.dxt` still
installs in Codex Desktop, but new directory submissions should ship `.mcpb`.

## What this repo already has

`scripts/build-mcpb.mjs` is **already MCPB-aware**: it tries `@anthropic-ai/mcpb`
first, falls back to legacy `@anthropic-ai/dxt`, then to a system `zip`. The
bundle stages `manifest.json` at the archive root + `dist/`, `recipes/`, `td/`,
`README.md`, `LICENSE`, `package.json`, and a production-only `node_modules`. So
the migration is mostly **renaming the output + the references**, not a rewrite.

`dxt/manifest.json` currently declares `"manifest_version": "0.3"` — already the
modern MCPB key (not the legacy `dxt_version`), so the manifest is largely correct.

## The migration, concretely

1. **Manifest — verify, don't guess.** Before touching `manifest_version`, check
   what the installed packer accepts:
   `npx --yes @anthropic-ai/mcpb --help` (look for `pack` / `validate`). If it
   ships a `validate` command, run it against `dxt/manifest.json` and let it tell
   you. Only change `manifest_version` if validation demands it. A wrong value
   breaks install — this is why we verify rather than assume a number.
2. **Output filename** → `tdmcp.mcpb`. In `scripts/build-mcpb.mjs`: change
   `outFile` to `tdmcp.mcpb` and update the log lines (they say `.dxt`). Keep the
   packer-preference order and the zip fallback intact — both must still work.
   Optionally rename the script file to `build-mcpb.mjs` (update the npm script if
   you do).
3. **npm scripts** (`package.json`): rename `build:dxt` → `build:mcpb` pointing at
   the script. Only keep a `build:dxt` alias if something external depends on the
   old name (grep first); otherwise replace it cleanly — no compatibility cruft.
   Check the `version` script too (it stages `dxt/manifest.json`).
4. **Reference sweep** — change user-facing `.dxt` → `.mcpb` in:
   `docs/guide/{install,troubleshooting,glossary}.md` + their `docs/pt/` mirrors,
   `docs/DEPLOYMENT.md`, `docs/reference/cli.md`, `scripts/setup.mjs`,
   `README.md`. Also grep `.github/` for any release workflow that builds or
   uploads `tdmcp.dxt` / runs `build:dxt`.
5. **Release-asset URLs.** Links to
   `releases/latest/download/tdmcp.dxt` point at a *published* asset. After this
   change the **next** release ships `tdmcp.mcpb`; update those links to `.mcpb`
   and record that a new release must be cut so the asset exists (the current
   v0.3.0 asset is still `.dxt`). Note this for the human in migration notes.

## Preserve, don't erase

Where docs explain "one-click Desktop Extension", keep the explanation and add
that `.dxt` still installs (legacy) while `.mcpb` is current. Don't delete info
that helps users who already downloaded the `.dxt`.

## Verify the build still works

```
npm run build          # populate dist/
npm run build:mcpb     # (renamed) → must emit tdmcp.mcpb
unzip -l tdmcp.mcpb     # manifest.json at root + dist/ present
```

The `dxt/` directory name and `dxt/manifest.json` path can stay as-is (internal
paths the script references) — renaming the directory is optional churn and not
required for a valid `.mcpb`. If you rename it, update `build-mcpb.mjs`,
`package.json`'s `version` script, and `sync-manifest-version.mjs`.
