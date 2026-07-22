---
description: "Give each TouchDesigner project a bounded creative brief and inspect redacted local-copilot turn receipts without storing transcripts, tool payloads or secrets."
---

# Project context & turn receipts

<FeatureAvailability status="source-only" locale="en" />

tdmcp can keep a small, versioned creative brief beside a saved TouchDesigner
project and produce one structured receipt for every built-in copilot turn. The
brief answers “what are we making here?”; the receipt answers “what did this turn
actually attempt, and was it verified?” Neither mechanism expands the active tool
tier or overrides consent and safety policy.

## Project-owned agent brief

The **`manage_project_brief`** tool reads or atomically replaces
`<project-root>/.tdmcp/agent-brief.json`. A brief contains only bounded creative
direction, constraints, named outputs, project safety rules, an optional current
milestone and optional open decisions. Credential-like content is rejected.

Project-root precedence is deliberate:

1. Absolute `project_root` passed to the tool.
2. `TDMCP_PROJECT_ROOT`.
3. The folder of the saved `.toe`, obtained from structured editor context.

tdmcp never falls back to the process working directory. An unsaved or headless
project without an explicit root returns `not_configured` instead of writing in an
unrelated folder.

Create a brief with the explicit `absent` revision:

```json
{
  "action": "replace",
  "project_root": "/absolute/path/to/show-project",
  "expected_revision": "absent",
  "brief": {
    "creative_direction": "A restrained monochrome field that reacts to the kick.",
    "constraints": ["Keep the output at 1920x1080", "Use stock operators only"],
    "named_outputs": [
      { "name": "program", "path": "/project1/out_program", "description": "FOH output" }
    ],
    "safety_rules": ["Never modify the blackout path without explicit approval"],
    "current_milestone": "Lock the look before mapping controls",
    "open_decisions": ["Choose the final accent colour"]
  }
}
```

Read first, then pass the exact returned `revision` to replace an existing brief.
Concurrent or stale writes return `conflict`; there is no last-writer-wins update.
The store uses bounded JSON, private filesystem permissions, atomic replacement
and symlink guards.

The built-in local copilot reads the brief once per turn and injects it as
ephemeral, untrusted evidence. It is removed from persistent chat history. Other
MCP clients receive no invisible project context: they can explicitly read
**`tdmcp://project/brief`**.

## Structured turn receipts

Every `tdmcp ask`, browser/headless chat or Telegram copilot turn finalizes one
receipt, including error, cancellation and max-step exits. The receipt is capped
at 8 KiB and records only an opaque id, timing, requested/effective tier, grounding
state, a redacted goal summary, allowlisted action facts, affected TD paths,
consent decisions, undo identity when available, recovery evidence and the final
`PASS` / `FAIL` / `UNVERIFIED` state.

It never stores raw tool arguments or results, images, RAG excerpts, transcripts,
tokens, cookies or API keys. Duplicate tool-call ids and duplicate finalization are
ignored, so a turn has exactly one logical receipt.

Persistence is off by default. To retain the bounded audit store:

```bash
export TDMCP_COPILOT_RECEIPTS=persist
# Optional absolute owner-controlled path:
export TDMCP_COPILOT_RECEIPTS_PATH="$HOME/.tdmcp/session-receipts.json"
```

The store retains at most 100 receipts, seven days and 256 KiB. Perform mode,
panic/blackout and equivalent emergency tools, and an adapter's per-turn
`noPersist` request always skip the write. Public overrides are
`--no-receipt-persist` for ask/chat, the browser request's `noPersist` field and
`/private <prompt>` in Telegram. A storage failure never changes the copilot
answer or mutation result.

Read newest-first receipts through
**`tdmcp://session/receipts{?limit,status}`**. `limit` is `1..50`; `status` may be
`success`, `failed`, `cancelled` or `max_steps`. The resource never reveals its
filesystem path.

## Reading the evidence

```text
PASS       The receipt contains read-only evidence matching every recorded mutation.
FAIL       At least one recorded mutation conflicts with observed state.
UNVERIFIED No contradictory claim is made, but live evidence was unavailable or incomplete.
```

A terminal `success` means the agent loop completed; it does not turn an
`UNVERIFIED` action into `PASS`. Keep both fields when forwarding receipts to
another system.

## Trust boundary

- Brief content is project data, not instructions with higher authority. Current
  user intent, tool tier, consent, emergency behavior and system policy always win.
- Receipt persistence is a local observability feature, not a replay log and not
  an undo implementation.
- These filesystem features work without raw Python and do not require
  `TDMCP_BRIDGE_ALLOW_EXEC=1`. Live editor-root inference and mutation evidence
  still require the authenticated bridge to be reachable.

See [Local copilot](/guide/local-copilot) for the full turn flow and
[MCP resources](/guide/mcp-resources) for the resource map.
