---
name: connectors-directory-spec
description: Authoritative reference for submitting tdmcp to the Anthropic Connectors Directory as a Claude Desktop Extension (MCPB). Use whenever drafting, checking, or fixing the submission — it defines the two submission paths, why tdmcp is a Desktop Extension (never a remote connector), every form field, the rejection-causing gates, and the local-only compliance story. Read this before writing any submission deliverable.
---

# Anthropic Connectors Directory — tdmcp submission spec

The "Claude marketplace" is the **Anthropic Connectors Directory**, surfaced in
Claude Desktop at *Settings → Extensions → Browse extensions* ("Anthropic-reviewed
tools"). There are **two submission paths with separate forms** — picking the
wrong one wastes a ~2-week review cycle.

## Path decision — tdmcp is a Desktop Extension (MCPB)

| Path | For | tdmcp? |
|------|-----|--------|
| **Remote MCP server** (internet-hosted, OAuth 2.0) → *MCP Directory form* | SaaS-style connectors Claude reaches over the network | **NO** |
| **Desktop Extension** (local MCP server bundled as **MCPB**) → *Desktop extension form* | Local servers that run on the user's machine | **YES** |

**Why local:** tdmcp is a Node/stdio server that talks to a Python bridge running
*inside TouchDesigner* at `127.0.0.1:9980`. It cannot be hosted remotely — it must
run next to TD on the artist's machine. So OAuth/hosting requirements **do not
apply**; ignore them. Submit via the **Desktop extension form** (linked from the
official submission docs page).

> `.dxt` was renamed to `.mcpb` (MCP Bundle). Existing `.dxt` still installs, but
> new submissions should ship `.mcpb`. See the `mcpb-bundle` skill.

## Approval gates (these cause rejection)

| Gate | Requirement | tdmcp status |
|------|-------------|--------------|
| **Privacy policy** | Present + complete. Missing = **immediate rejection**. | TODO — docs-author writes it (local-only ⇒ short) |
| **Tool annotations** | Every tool has safety hints (`readOnlyHint`/`destructiveHint`). Missing = ~30% of all rejections. | PASS — all tools annotated (verified in `src/tools/**`) |
| **Production-ready** | Not beta. Stable, versioned, installable. | PASS — v0.3.0 on npm + MCP registry |
| **Public docs URL** | Setup + usage docs. | PASS — https://pantani.github.io/tdmcp/ |
| **Data-handling statement** | What data is handled and where it goes. | TODO — trivial (see below) |
| **Branding** | Logo / icon. | PASS — `docs/public/logo-400.png` (400×400) + favicon |
| **Installable bundle** | A valid `.mcpb`. | TODO — bundle-engineer migrates `.dxt`→`.mcpb` |

## The local-only compliance story (reuse everywhere)

tdmcp's compliance answers are simple because of what it is — state it plainly:

- Runs **entirely on the user's machine**. No accounts, no sign-in, no cloud.
- The MCP server only makes HTTP calls to the user's **own** TouchDesigner bridge
  on `127.0.0.1:9980` (configurable host/port). No other network egress.
- **Collects no user data**, no telemetry, no analytics, sends nothing to the
  author or any third party.
- The user's AI client (Claude/Cursor/Codex) processes prompts under *that
  client's* privacy policy — tdmcp adds no data collection of its own.
- Security note worth stating: the bridge executes Python inside TD and listens on
  `9980`; for untrusted networks the user sets `TDMCP_BRIDGE_TOKEN` /
  `TDMCP_BRIDGE_ALLOW_EXEC=0` (already documented in the architecture docs).

This is the basis for both the **privacy policy page** and the form's
data/compliance fields.

## Form field map (Desktop extension form)

For each field: the canonical answer or who drafts it. Known repo facts are filled.

| Field | Answer / source |
|-------|-----------------|
| Name | `tdmcp` |
| Display name | `TouchDesigner (tdmcp)` (from `dxt/manifest.json`) |
| Tagline (one-liner) | docs-author — reuse `docs/index.md` hero |
| Description | docs-author — reuse `what-is-tdmcp` + README; mention 100+ tools, knowledge base, create→verify→preview |
| Use cases | docs-author — VJ/live audiovisual, generative art, audio-reactive, projection mapping (see prompt-cookbook) |
| Category | Creative / media tools |
| Transport | stdio (Claude Desktop spawns the local server) |
| Auth | None (local) |
| Tools list + annotations | architect derives from `src/tools/**`; each tool's `title`/`readOnlyHint`/`destructiveHint` |
| Data handling / compliance | the local-only story above |
| Privacy policy URL | the new page docs-author publishes (e.g. `https://pantani.github.io/tdmcp/privacy`) |
| Public docs URL | https://pantani.github.io/tdmcp/ |
| Repo | https://github.com/Pantani/tdmcp |
| npm | `@dpantani/tdmcp` |
| MCP registry id | `io.github.Pantani/tdmcp` |
| License | MIT (verify `LICENSE`) |
| Logo / branding | `docs/public/logo-400.png`, favicon |
| Bundle | `tdmcp.mcpb` (from the migrated build) |
| Support channel | `NEEDS HUMAN INPUT` — GitHub Issues URL is the likely answer; confirm |
| Test account credentials | `NEEDS HUMAN INPUT` — likely N/A (no auth); note "local tool, no account" |
| Production-ready confirmation | Yes — v0.3.0 |

## Distinguish from what's already done

- **MCP Registry** (`io.github.Pantani/tdmcp`, active) is the *open* registry —
  already done, feeds PulseMCP etc. It is **not** the Anthropic directory.
- `desktopextensions.com` and `awesome-*` lists are community discovery, not the
  official directory.

## Sources

- Submitting to the Connectors Directory — claude.com/docs/connectors/building/submission
- Connectors Directory FAQ — support.claude.com (article 11596036)
- Desktop Extensions — anthropic.com/engineering/desktop-extensions
