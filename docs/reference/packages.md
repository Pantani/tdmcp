---
description: "Install and stage TouchDesigner community libraries with tdmcp's manifest-driven package manager."
---

# Package Manager

`tdmcp install <lib>` stages trusted, manifest-listed TouchDesigner community
packages under explicit user or project ownership. User scope remains the
compatible default at `~/.tdmcp/packages`; project scope uses
`<project>/.tdmcp/packages` and requires `--project-dir`. It works when
TouchDesigner is closed. If the TD bridge is reachable and a package exposes a
safe `.tox` import path, tdmcp can also import it under
`/project1/tdmcp_packages/<package_id>`.

## Everyday Commands

```bash
tdmcp search shader
tdmcp list --available
tdmcp info shader-park-td --json
tdmcp install mediapipe-touchdesigner --scope project --project-dir "$PWD" --dry-run --json
tdmcp install raytk
tdmcp packages doctor comfyui-td
tdmcp packages --help
tdmcp packages path
```

Storage-aware `list`, `install`, `uninstall`, and `packages path` accept
`--scope user|project`, `--project-dir <dir>`, and the advanced user-only
`--packages-root <dir>` override. Project scope rejects ambiguous root overrides,
missing projects, files, and symlinked project/package directories. MCP tools
use the equivalent `scope`, `project_dir`, and `packages_root` fields.

Bare `tdmcp doctor` now diagnoses the effective tdmcp environment. The old
`tdmcp doctor <known-package>` form is temporarily accepted with a deprecation
warning; new automation should use `tdmcp packages doctor [package]`.

`install-bridge` is separate and unchanged:

```bash
tdmcp install-bridge
```

## Support Levels

`full` packages have manifests, aliases, dry-run plans, cache/stage support, artifact detection, installed-state tracking, and mocked install coverage. They may still stage instead of live-import when the package is a collection or template.

`stage-only` packages are safe to download and place on disk, but should be opened or imported manually.

`doctor-only` packages need external runtimes such as models, CUDA/TensorRT, ComfyUI, Ableton, or Bitwig. tdmcp gives preflight guidance and does not pretend those dependencies are installed.

`deferred` items are not install targets in this pass.

## Included Packages

Fully supported:

- `mediapipe-touchdesigner`
- `raytk`
- `functionstore-tools`
- `touchdesigner-shared`
- `shader-park-td`
- `sop-to-svg`
- `augmenta-touchdesigner`
- `simplemixer`

Doctor/stage guidance:

- `td-yolo`
- `td-depth-anything`
- `comfyui-td`
- `touchdiffusion`
- `geopix`
- `td-ableton`
- `td-bitwig`

## Safe Dry Runs

Use `--dry-run --json` before staging anything:

```bash
tdmcp install mediapipe-touchdesigner --dry-run --json
```

Dry-runs do not download archives, extract files, write installed state, or contact TouchDesigner.

## Importing Into TouchDesigner

When TouchDesigner is closed or the bridge is unreachable, install reports say `staged` and include the staged path plus next steps. When the bridge is live and a package has a safe `.tox`, tdmcp imports into:

```text
/project1/tdmcp_packages/<package_id>
```

It will not overwrite an existing package node unless you pass `--yes`.

## Safe live reconciliation

Use the MCP tool `manage_packages` with `action: "reconcile"` before removing a
package that still has a live TouchDesigner target. The first call is always a
dry-run and returns an expiring `plan_id`; only a unique target whose bounded
marker matches package ID, source fingerprint, ref and scope is actionable.

Apply the unchanged plan with one explicit choice:

- **Keep** changes nothing;
- **Bypass** preserves the live COMP and its local install record;
- **Delete** asks for native **Delete / Bypass / Keep** consent, unless the MCP
  server was started with explicit YOLO policy.

Deletion quarantines staged files before the live mutation, commits the local
registry only after TD confirms deletion, and restores or returns a
`partial_failure` remediation when the phases cannot converge. Foreign,
markerless, unreadable, mismatched and duplicate targets fail closed. A legacy
`uninstall` call with a recorded live target now returns this dry-run plan instead
of deleting local state first.

## Security Model

tdmcp downloads archives, validates archive paths, extracts into its package cache, scans for artifacts, and writes an installed registry. It does not execute third-party Python, shell scripts, npm postinstall hooks, pip installs, model downloads, CUDA/TensorRT setup, Ableton setup, Bitwig setup, ComfyUI setup, or arbitrary downloaded code by default.

`--allow-python-deps` and `--allow-external` are acknowledgements for doctor/report guidance. They do not run dependency installers in this implementation.

The reconciliation routes are bearer-authenticated structured operations and
remain available with `TDMCP_BRIDGE_ALLOW_EXEC=0`; they never execute a package's
scripts or treat missing UI as approval.

## Developer Notes

Package manifests live in `src/packages/registry.ts`. Add a manifest with:

- `id`, `aliases`, `displayName`, `description`
- `homepage`, `source`, `license`, `tags`
- `packageType`, `supportLevel`, `platforms`, `tdVersionRange`
- `requiresTouchDesignerBridge`, `externalDependencies`
- `installStrategy`, `healthChecks`, `importHints`
- `uninstallStrategy`, `securityNotes`

Add tests under `tests/unit/packageManager.test.ts` for aliases, dry-run behavior, doctor behavior, mocked install/stage behavior, and any package-specific safety rule. Mark heavy model/runtime integrations as `doctor-only` unless the TD-side adapter can be staged safely without hidden external work.
