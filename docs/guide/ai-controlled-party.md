---
title: AI-Controlled Party
description: "Run a safe AI co-piloted party with tdmcp and TouchDesigner: show intents, approvals, cues, logs, panic controls and hardware boundaries."
---

# AI-Controlled Party

AI-Controlled Party is a show mode pattern for using tdmcp and TouchDesigner as
an AI co-pilot for live visuals. The AI can suggest and select approved cues,
change visual mood, draft announcements and react to show context. TouchDesigner
remains the deterministic stage runtime, and the human operator keeps final
authority over hazardous effects.

This is not a mode where a language model directly drives fog, strobes, moving
heads, lasers or the PA. The safe architecture is:

```text
microphone / OpenClaw / ChatGPT text
  -> ShowIntent
  -> policy decision
  -> approval queue or dry-run plan
  -> tdmcp / TouchDesigner only after operator-safe mapping
```

## Current status

The first implementation slice is intentionally dry-run only, and the current
validation result is split between visual rehearsal and policy proof:

- `ShowIntentSchema` validates AI show-control requests.
- `EffectPolicySchema` defines allow, approval and block rules.
- `tdmcp-agent show-director` explains the policy decision without connecting
  to TouchDesigner or hardware.
- Approval queue state and audit logs are returned as JSON so a future dashboard
  can persist or display them.
- The first visual rehearsal used two example projections as the output baseline
  for the concept: visuals can be split/mapped as a show surface, while the AI
  policy layer stays separate from projector timing.
- Offline regression tests cover the dry-run policy path: allowed visual cues,
  approval-gated fog, blocked strobe/blackout/mixer-style requests, malformed
  LLM output, approval/cancel state transitions and the CLI guarantee that
  `show-director` does not build a TouchDesigner context.
- The built-in recipe set still validates, including the projection mapping
  recipe used as one of the rehearsal primitives.

## Validation plan

Use the concept as a harness, not a single demo file. Each pass should prove one
boundary before the next one is trusted:

| Stage | What to prove | Pass signal |
| --- | --- | --- |
| Projection baseline | Two or more outputs can show a mapped visual and a known test pattern. | Each projector/surface is framed, previewed and has a fallback black/freeze path. |
| AI policy dry-run | Text requests become structured `ShowIntent`s before anything reaches TD. | Pre-approved cues are allowed, fog/strobe are approval-gated or blocked, hazardous effects never produce a hardware plan. |
| Audio-reactive rehearsal | TD handles beat, energy, transient or chroma timing locally. | The AI changes phrase/section/cue intent only; beat-tight motion keeps running without LLM round trips. |
| Operator control | The human can see the latest AI decision and override it. | Dashboard/logs show current cue, pending approvals, policy reasons and panic state. |
| Venue hardware | Every fixture and effect has a safe state before live control. | DMX/fog/strobe/PA actions remain simulated until the venue-specific policy, cooldowns and kill path are rehearsed. |

Repeat the first two stages in CI/offline rehearsal whenever the policy changes.
Repeat all five stages for each venue.

## Rehearsal mode

Use rehearsal mode while building the show:

1. Build visuals, setlists, cues, projection mapping and dashboards with normal
   tdmcp tools.
2. Save cues with clear names like `doors_idle`, `band_intro`,
   `music_reactive_main` and `panic_recovery_test`.
3. Test audio analysis from a synthetic or file source before using a live mixer.
4. Keep `create_panic` or `tdmcp-agent panic` available before rehearsing any
   output path.

## Show mode

Show mode should use a narrower command surface. The AI should work at the level
of phrases, sections and cues, not beat-by-beat timing.

Allowed dry-run intents:

- `announce`
- `change_mood`
- `request_cue` for pre-approved visual cues
- `log_note`
- `panic_status`

Approval-gated by default:

- `fog`
- `hazer`
- `strobe`

Blocked/operator-only by default:

- `blackout`
- `freeze`
- `moving_head`
- `laser`
- `mixer_gain`
- `pa_mute`
- `audio_routing`

## Dry-run CLI

Check a visual cue:

```bash
tdmcp-agent show-director --params '{
  "intent": {
    "type": "request_cue",
    "cue": "band_intro",
    "preapproved": true
  }
}'
```

Queue a fog request for approval:

```bash
tdmcp-agent show-director --params '{
  "intent": {
    "type": "arm_effect",
    "effect": "fog",
    "duration_seconds": 3,
    "intensity": 0.4
  }
}'
```

Approve a queued request by passing the exact returned `state` back in:

```bash
tdmcp-agent show-director --params '{
  "intent": {
    "type": "arm_effect",
    "effect": "fog",
    "duration_seconds": 3,
    "intensity": 0.4
  }
}' > queued.json

node -e 'const fs=require("fs"); const queued=JSON.parse(fs.readFileSync("queued.json","utf8")); fs.writeFileSync("approve-state.json", JSON.stringify({ operator: "front-of-house", state: queued.state }, null, 2));'

tdmcp-agent show-director approve approval_0001 --params-file approve-state.json
```

The returned `plan` is still abstract and dry-run only. Hardware adapters must
be added separately and must continue to enforce the same policy.

## Demo checklist

- Bridge health checked.
- Panic/blackout/freeze path tested locally.
- Fallback visual cue prepared.
- Demo setlist imported or available.
- Audio source tested from synthetic/file source first.
- Projector output/mapping verified.
- Hazardous effects disconnected or simulated unless the venue operator approves
  a controlled rehearsal.
- Operator can see the latest AI decision, pending approvals and audit log.

## Five-moment demo

1. Doors: generative idle visual, dashboard/panic visible.
2. Band intro: AI selects a pre-approved cue and queues any fog request.
3. Audio-reactive core: TouchDesigner drives beat/energy/chroma timing locally.
4. Microphone request: voice text becomes `change_mood`, bounded by policy.
5. Safety proof: excessive fog/strobe/mixer request is blocked, panic path works
   without the LLM.

## Not yet live-validated

Real STT, OpenClaw wiring, dashboard approvals, fixture patching, DMX output,
fog/hazer hardware, strobe hardware, moving heads, lasers and PA control all
require a venue-specific validation pass. Do not treat the dry-run planner as a
hardware controller.
