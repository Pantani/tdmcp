---
title: Project-scoped ownership
description: Safely own tdmcp packages and MCP client registration per TouchDesigner project.
---

# Project-scoped ownership

<FeatureAvailability status="source-only" locale="en" />

Wave 3 makes local setup explicit, inspectable, and reversible. Package files
can belong to one project instead of an implicit global cache, and client setup
can target one verified native config without replacing unrelated entries.

## Package storage

User scope remains compatible with existing installs:

```text
~/.tdmcp/packages
```

Project scope is opt-in and requires the project directory:

```text
<project>/.tdmcp/packages
```

```bash
tdmcp packages path --scope project --project-dir "$PWD" --json
tdmcp list --installed --scope project --project-dir "$PWD" --json
tdmcp install raytk --scope project --project-dir "$PWD" --dry-run --json
```

The same contract is available through `manage_packages`, while
`install_library_package` accepts project scope without requiring a legacy
`dest_dir`. Project scope rejects a competing `packages_root`, missing project
directories, and symlinked ownership roots.

## Client setup

Native targets in this wave are:

| Client | Project | User |
| --- | --- | --- |
| Claude Code | `<project>/.mcp.json` | `~/.claude.json` |
| Cursor | `<project>/.cursor/mcp.json` | `~/.cursor/mcp.json` |
| Codex | Unsupported, fail closed | `~/.codex/config.toml` |

Plan and inspect before applying:

```bash
tdmcp install-client claude --scope project --project-dir "$PWD" --diff --json
tdmcp install-client claude --scope project --project-dir "$PWD" --write --json
tdmcp install-client claude --scope project --project-dir "$PWD" --check --json
```

Remove only the owned name:

```bash
tdmcp install-client claude --scope project --project-dir "$PWD" --remove --diff --json
tdmcp install-client claude --scope project --project-dir "$PWD" --remove --write --json
```

`--name` selects one safe registration name. JSON keys and TOML sections owned
by other tools are preserved. Invalid, oversized, symlinked, or concurrently
changed configs are rejected. `--write` promotes an atomic sibling file and
verifies the bytes after promotion. Output reports token presence, never the
token value.

Calling `tdmcp install-client <client>` without a scope or action still prints
the legacy ready-to-paste snippet. Explicit `--write --path <file>` also remains
available for compatibility, but native scoped targets are preferred.

## Doctor namespace

The top-level command now has one meaning:

```bash
tdmcp doctor --json
tdmcp doctor --fix
```

Package dependency guidance is explicit:

```bash
tdmcp packages doctor raytk --json
```

Known `tdmcp doctor <package>` calls still route to the package doctor with a
deprecation warning. New scripts should use the namespaced command.

## Evidence language

- **PASS** — offline tests proved scoped resolution, preservation of unrelated
  config, redacted planning, check/remove, concurrent-change rejection, atomic
  read-back, and namespace compatibility.
- **FAIL** — invalid input or unsafe filesystem state is rejected with no tdmcp
  write; a non-zero result is expected.
- **UNVERIFIED — pending bridge** — live package import and reconciliation with
  operators already loaded in TouchDesigner were not claimed without a running
  bridge.

`tdmcp status --json` reports the default `tdmcp` registration at each supported
native target without exposing paths or secret values. Arbitrary `--name`
entries are intentionally not scanned.
