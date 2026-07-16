---
description: "Build-aware TouchDesigner docs, curated agent skills, deterministic local bundles, and a redacted runtime readiness command."
---

# Build-aware agent & runtime readiness

<FeatureAvailability status="source-only" locale="en" />

Discovery Wave 2 adds local-first documentation and operator-readiness primitives
without opening raw Python or remote installation surfaces. The tools work when
`TDMCP_BRIDGE_ALLOW_EXEC=0`; only the optional running-build comparison needs a
reachable bridge.

## Read TouchDesigner docs for the installed build

`get_td_docs` reads a bounded page or section from TouchDesigner's installed
OfflineHelp corpus first, then the embedded tdmcp knowledge base. It reports the
installed corpus build, the running TD build when reachable, and whether they
match. It never accepts a filesystem path as the query and never returns an
unbounded document or whole corpus.

```json
{
  "query": "Noise TOP",
  "kind": "operator",
  "source": "auto",
  "section": "Parameters",
  "max_chars": 6000
}
```

Web lookup is opt-in twice: the request must allow it and the server-side gate
must be enabled. Web results describe the current Derivative page, not the bytes
installed with a specific TD build, so provenance remains explicit.

Direct CLI parity is available as `tdmcp-agent docs get --json '<json>'`.

## Curated skills, not an arbitrary installer

`manage_agent_skills` manages exactly three package-bundled, host-neutral skills:

- `tdmcp-artist-workflows`
- `tdmcp-project-safety`
- `tdmcp-troubleshooting`

Codex and Claude project/user targets are supported. Mutations default to dry
run, use a bounded ownership manifest, reject symlinks and unowned collisions,
and roll back partial transactions. Locally edited manifest-owned content is not
replaced unless `force_owned_drift` is explicit.

The top-level CLI exposes the same contract:

```bash
tdmcp skills status --host codex --scope project --json
tdmcp skills install --host codex --scope project
tdmcp skills install --host codex --scope project --apply
```

The second command only plans. The third is the first one that writes. This
feature does not download, discover, execute, publish, or install arbitrary
third-party skills.

## Deterministic local bundles

Maintainers can build byte-stable Codex/Claude payloads, canonical manifests,
checksums and deterministic `.skill` archives locally:

```bash
pnpm build:agent-skills -- \
  --output ./build/agent-skills \
  --verify-reproducible \
  --json
```

The command does not install, attach, publish or release anything. Overwrite is
refused unless `--overwrite` is explicit and the destination is already marked
as a tdmcp-owned bundle.

## Redacted runtime readiness

`tdmcp status` reads one effective config/profile, probes only its configured
bridge with bounded GETs, checks the content-free interaction summary, inspects
manifest-owned skill state, and observes exact Claude/Cursor/Codex registration
entries. It never scans ports, mutates TouchDesigner, or prints secrets, project
paths, prompt contents, request IDs, config paths, or client-config values.

```bash
tdmcp status
tdmcp status --json --timeout-ms 1500
tdmcp status --profile venue
tdmcp status --config ./tdmcp.json
```

Exit codes are stable: `0` for a completed probe, `2` for invalid arguments or
config, `3` for bridge offline/timeout, and `4` for rejected, unsupported or
malformed bridge responses. A completed probe may still report `degraded` when
optional readiness is absent.

## Honest evidence examples

**PASS — installed OfflineHelp corpus confirmed locally**

```json
{
  "status": "PASS",
  "source": "installed-offline",
  "installed_corpus_build": "2025.32820",
  "documents_sampled": 9
}
```

**FAIL — explicit config cannot be trusted**

```json
{
  "status": "FAIL",
  "reason_code": "config_invalid",
  "exit_code": 2
}
```

**UNVERIFIED — pending bridge**

```json
{
  "status": "UNVERIFIED",
  "reason": "pending bridge",
  "checks": ["running build comparison", "native UI readiness"]
}
```

The macOS OfflineHelp path and installed 2025.32820 corpus were exercised in
this source tree. Automatic OfflineHelp discovery is macOS-only in this wave;
Windows and Linux require the explicit `TDMCP_TD_DOCS_ROOT` override. Native
Windows/Linux discovery is deferred, and all live bridge fields remain
`UNVERIFIED` until run on those environments.

## Still deferred

OAuth/PKCE arrived in the later [remote connection trust wave](/guide/oauth-pkce);
CIMD and external multi-user/federated authorization remain deferred. Remote
skill catalogs/installers, workspace snapshot/restore,
selection-to-component, insert-at-selection, animated global follow/highlight,
whole-tool undo transactions, broad broker migration, release and deployment
remain outside this wave.
