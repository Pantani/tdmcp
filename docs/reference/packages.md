---
description: "Install and stage TouchDesigner community libraries with tdmcp's manifest-driven package manager."
---

# Package Manager

`tdmcp install <lib>` stages trusted, manifest-listed TouchDesigner community packages under `~/.tdmcp/packages`. It works when TouchDesigner is closed. If the TD bridge is reachable and a package exposes a safe `.tox` import path, tdmcp can also import it under `/project1/tdmcp_packages/<package_id>`.

## Everyday Commands

```bash
tdmcp search shader
tdmcp list --available
tdmcp info shader-park-td --json
tdmcp install mediapipe-touchdesigner --dry-run --json
tdmcp install raytk
tdmcp doctor comfyui-td
tdmcp packages path
```

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

## Security Model

tdmcp downloads archives, validates archive paths, extracts into its package cache, scans for artifacts, and writes an installed registry. It does not execute third-party Python, shell scripts, npm postinstall hooks, pip installs, model downloads, CUDA/TensorRT setup, Ableton setup, Bitwig setup, ComfyUI setup, or arbitrary downloaded code by default.

`--allow-python-deps` and `--allow-external` are acknowledgements for doctor/report guidance. They do not run dependency installers in this implementation.

## Developer Notes

Package manifests live in `src/packages/registry.ts`. Add a manifest with:

- `id`, `aliases`, `displayName`, `description`
- `homepage`, `source`, `license`, `tags`
- `packageType`, `supportLevel`, `platforms`, `tdVersionRange`
- `requiresTouchDesignerBridge`, `externalDependencies`
- `installStrategy`, `healthChecks`, `importHints`
- `uninstallStrategy`, `securityNotes`

Add tests under `tests/unit/packageManager.test.ts` for aliases, dry-run behavior, doctor behavior, mocked install/stage behavior, and any package-specific safety rule. Mark heavy model/runtime integrations as `doctor-only` unless the TD-side adapter can be staged safely without hidden external work.
