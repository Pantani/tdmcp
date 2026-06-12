---
title: AI-Controlled Party
description: "Run a safe AI-assisted party rehearsal with tdmcp and TouchDesigner: local dashboard, ShowIntent policy, approvals, simulated effects, Telegram, Ollama and TD boundaries."
---

# AI-Controlled Party

AI-Controlled Party is a show mode pattern for using tdmcp and TouchDesigner as
an AI co-pilot for live visuals. The AI can suggest and select approved cues,
change visual mood, draft announcements and react to operator or Telegram text.
TouchDesigner remains the deterministic stage runtime, and the human operator
keeps final authority over hazardous effects.

The current implementation is a **local rehearsal POC**, not autonomous show
control. It proves the decision loop, dashboard, audit trail, optional local LLM
path, optional Telegram path and optional TouchDesigner visual surface. It does
not prove venue hardware.

```text
dashboard / Telegram / operator text
  -> optional Ollama parser or deterministic fallback
  -> ShowIntent envelope
  -> policy decision
  -> allow, approval queue or block
  -> simulation or TouchDesigner control-panel update
  -> real hardware only after a separate venue adapter and approval gates exist
```

## What exists now

| Surface | Status | What it proves |
| --- | --- | --- |
| `tdmcp-agent show-director` | Shipped policy CLI | Validates one `ShowIntent`, returns `allow`, `require_approval` or `block`, and updates approval/audit JSON without connecting to TD or hardware. |
| `tdmcp-agent ai-party-poc` | Shipped offline producer runner | Runs the seven-moment producer rehearsal with fan-in, policy decisions, approval state, audit summary and simulated effects only. |
| `npm run ai-party:dev` | Local live rehearsal POC | Starts the Live Nervous System backend and dashboard, normally at `http://127.0.0.1:8787/`. |
| `npm run ai-party:dry` | Fast smoke proof | Runs the deterministic doors -> mood -> brand -> fog approval -> approval -> audio-reactive -> safety proof sequence with no external service. |
| `npm run ai-party:td-build` | Optional TD visual surface | Builds `/project1/ai_party_poc` with a control panel, visual TOP chain, simulated DMX table, disabled DMX placeholder and `preview_out`. |
| `npm run ai-party:telegram` | Optional local Telegram path | Uses Bot API long polling with allowlisted chat IDs; it replies through Telegram but still routes every request through the same policy layer. |
| `tdmcp-agent ai-party` | Earlier Hermes/Telegram gateway | Dry-runs one Telegram/Hermes-style message through the Show Director policy surface. It remains policy-only and does not build a TD context. |

The dashboard includes command input, example chips, cue deck, approval queue,
live state, TouchDesigner preview status, event-log filters and a safety panel.
The local service writes JSONL audit events to
`POC_EVENT_LOG_PATH` (`./data/ai-party-poc-events.jsonl` by default).

## Recommended local rehearsal

Start with the offline proof:

```bash
npm run ai-party:dry
npm run ai-party:test
```

Then run the dashboard:

```bash
npm run ai-party:dev
```

Open the printed URL. Useful test prompts:

- `deixa a sala mais premium tropical`
- `prepara fumaça curta no próximo drop`
- `blackout total e strobo máximo e raw dmx`

Expected behavior:

- The first prompt selects a safe visual cue or mood.
- The fog prompt creates an approval item; approving it still simulates the
  physical effect unless live gates and a real adapter are deliberately added.
- The blackout / max-strobe / raw-DMX prompt is blocked and logged.

## Optional Ollama

Set a local model only if you want the LLM parser in the loop:

```bash
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5:3b
npm run ai-party:dev
```

No specific model is required for the POC. If Ollama is unavailable or
`OLLAMA_MODEL` is unset, the dashboard reports that state and uses deterministic
fallback parsing for the built-in demo commands.

## Optional TouchDesigner preview

Start the tdmcp bridge, then build the demo network:

```bash
npm run ai-party:td-build
```

The builder creates or replaces `/project1/ai_party_poc`. Every created operator
gets explicit `nodeX` / `nodeY` coordinates so the network is readable instead
of stacked. The dashboard preview endpoint targets:

```text
/project1/ai_party_poc/preview_out
```

Cue and mood actions can update the TD control panel when the bridge is
reachable. Physical effects remain represented by a simulated DMX table and a
disabled output placeholder.

## Optional Telegram bench

Use Telegram long polling for local rehearsal:

```bash
TELEGRAM_BOT_TOKEN=... \
TELEGRAM_ALLOWED_CHAT_IDS=123456789 \
TELEGRAM_POLLING_ENABLED=true \
npm run ai-party:telegram
```

Supported commands include `/status`, `/cues`, `/cue <cue_name>`,
`/mood <text>`, `/fog <seconds> <intensity>`, `/approve <approval_id>`,
`/reject <approval_id>`, `/panic` and `/demo`.

Keep Telegram allowlisted. Webhook mode is deployment work, not the local POC
path.

## Safety model

The LLM only interprets text into structured `ShowIntent` JSON. It never gets to
dispatch raw DMX, raw Python, arbitrary endpoints, fixture channels, mixer
commands, PA actions or laser / moving-head control.

Allowed low-risk intents:

- `announce`
- `change_mood`
- `request_cue` for pre-approved visual cues
- `log_note`
- `panic_status`

Approval-gated by default:

- `fog`
- `hazer`
- bounded `strobe`

Blocked or operator-only by default:

- `blackout`
- `freeze`
- `moving_head`
- `laser`
- `mixer_gain`
- `pa_mute`
- `audio_routing`
- input gain, mute groups, patching, channel-strip edits and raw adapter
  commands

Approval is checked twice: once when the request enters the queue, and again
when the operator approves it. Runtime cooldown state is part of that second
check, so two queued fog requests cannot both dispatch if the first approval
puts the effect inside its cooldown window.

`HARDWARE_ENABLED` and `DMX_LIVE_ENABLED` are integration gates for future
adapters. Do not treat them as a venue-ready DMX driver. The current TD POC uses
`sim_dmx_table` and `dmx_out_disabled`, and real fixtures still require a
separate adapter, patch map, emergency-stop path, bench validation and venue
rehearsal.

## Mixer scene arming study

The designed Soundcraft Ui24R extension remains **planned**, not live execution:

- The proposed intent is `arm_mixer_scene`, separate from hazardous
  `mixer_gain`, `pa_mute` and `audio_routing` effects.
- The AI may prepare a specific Ui24R show, snapshot or cue target.
- The MVP policy must always require human approval before any adapter can
  dispatch the action.
- The first implementation slice should be contract + dry-run adapter only.
- Bitfocus Companion is still the recommended first live backend after isolated
  bench validation; a direct Node bridge is deferred until the Ui24R protocol is
  proven against the target firmware.

The durable design spec lives in
[AI Party Ui24R Scene-Arming Design](../superpowers/specs/2026-06-04-ai-party-ui24r-scene-arming-design.md).

The important safety finding is that a Ui24R show/snapshot/cue can hide broad
mixer-state changes. A mixer scene is only AI-armable if a trusted venue catalog
and manifest prove the target scene excludes gain, PA mute, routing, patching,
channel-strip, mute-group and phantom-power changes. Otherwise it remains
operator-only/manual.

## Validation plan

Use the POC as a harness. Each pass should prove one boundary before the next
one is trusted:

| Stage | What to prove | Pass signal |
| --- | --- | --- |
| Offline policy | Text and scripted events become valid `ShowIntent`s. | `npm run ai-party:dry` and `npm run ai-party:test` pass; allowed, queued and blocked paths all appear. |
| Dashboard rehearsal | The operator can see current cue, pending approvals, policy reasons, panic state and audit events. | `npm run ai-party:dev` serves the dashboard, approvals can be approved/rejected, and blocked requests stay blocked. |
| TouchDesigner preview | TD can host the visual POC without depending on device hardware. | `npm run ai-party:td-build` creates `/project1/ai_party_poc`; `/api/td/preview` can read `preview_out` when the bridge is available. |
| Telegram bench | A bot can receive allowed operator messages and send status replies. | Long polling processes only allowlisted chats and maps `/cue`, `/mood`, `/fog`, `/approve`, `/reject` and `/panic` through policy. |
| Venue hardware | Every fixture, output and effect has a safe state before live control. | Still pending: fixture patching, real DMX/fog/strobe/hazer/PA adapters, emergency stop, cooldowns and operator rehearsal must be venue-specific. |

Repeat the offline policy and dashboard stages whenever the policy changes.
Repeat the hardware stages for every venue.

## Not yet live-validated

Real STT, OpenClaw wiring, deployed Telegram webhooks, fixture patching, DMX
output, fog/hazer hardware, strobe hardware, moving heads, lasers, PA control,
Soundcraft Ui24R scene recall, venue emergency stop and show-pressure operator
rehearsal all require a venue-specific validation pass. Do not treat the local
POC, the dry-run planner or the planned mixer-scene contract as a hardware
controller.
