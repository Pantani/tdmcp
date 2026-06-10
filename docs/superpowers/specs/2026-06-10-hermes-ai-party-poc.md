# Hermes AI-Controlled Party POC

Date: 2026-06-10
Status: Phase 1 dry-run gateway implemented; four-screen TD scaffold and venue
hardware remain next-phase work
Harness: `ai-party-poc` -> `tdmcp-pipeline`
Scope: Hermes + Telegram triggers, four projection surfaces, PA announcements,
stage lights, fog/hazer, operator approval, and safety validation.

## Goal

Build a POC where Hermes behaves like an AI show director. Telegram messages
trigger Hermes, Hermes proposes show intents, the local policy runtime decides
whether each intent is allowed, queued, blocked, or operator-only, and tdmcp plus
TouchDesigner execute only the approved deterministic show actions.

This is not "Telegram directly controls the venue." The credible version is:

```text
Telegram message
  -> Hermes director adapter
  -> structured ShowIntent
  -> show policy and approval queue
  -> tdmcp / TouchDesigner execution plan
  -> projectors, dashboard, TTS, DMX, fog only when validated
```

The repo already validates the dry-run policy foundation through
`ShowIntentSchema`, `EffectPolicySchema`, `showDirectorRuntime`, and
`tdmcp-agent show-director`. This POC extends that foundation into a complete
event architecture.

## 2026-06-10 Implementation Result

The first executable POC slice is now in-tree:

- `src/automation/aiPartyGateway.ts`: deterministic Hermes fallback parser plus
  raw Hermes candidate validation. It maps Telegram-style messages to
  `ShowIntent`, blocks malformed Hermes output, enforces audience/operator
  boundaries, and submits allowed candidates to `showDirectorRuntime`.
- `src/automation/telegramShowGateway.ts`: one-batch Telegram Bot API long-poll
  gateway using `getUpdates` with `allowed_updates=["message","callback_query"]`,
  allowlisted chats, operator/audience role mapping, and `sendMessage` replies
  with inline approve/deny buttons for queued effects.
- `tdmcp-agent ai-party`: dry-runs one message without TouchDesigner.
- `tdmcp-agent ai-party telegram-once`: processes one Telegram long-poll batch
  and replies, still without creating a TouchDesigner context or driving
  hardware.
- `tests/unit/aiPartyGateway.test.ts`: covers preapproved band cue, fog approval
  queue, audience blocking, malformed Hermes output, audience intensity caps,
  Telegram fetch/reply behavior, and CLI dry-run discovery.

This means the POC can now prove the command/policy/audit boundary locally. It
does not yet build the four-screen TouchDesigner show scaffold or control
projectors, PA, DMX, fog, or lighting hardware.

## POC North Star

The demo should feel like Hermes is actively conducting the room:

- The audience sees four coordinated screens, not one mirrored feed.
- Telegram can request mood, scene, announcement, band intro, and selected
  operator actions in real time.
- The AI can announce bands and safety/status messages through the PA path.
- Music analysis stays local in TouchDesigner for beat-tight visuals.
- Lights and fog respond only through validated policy and operator approval.
- The operator always sees what Hermes asked, what policy decided, and what
  actually happened.

## System Architecture

```text
Operator Telegram group          Optional audience Telegram channel
          |                                   |
          +---------------+-------------------+
                          |
                          v
                 Telegram bot gateway
               long polling for local POC
                          |
                          v
                  Hermes director adapter
          context + message -> ShowIntent candidate
                          |
                          v
             showDirectorRuntime policy engine
      allow / queue approval / block / operator-only
                          |
          +---------------+----------------+
          |                                |
          v                                v
  FOH approval surface              safe execution queue
  Telegram + dashboard              cue/mood/log/TTS plan
          |                                |
          +---------------+----------------+
                          |
                          v
                  tdmcp server / CLI
                          |
                          v
               TouchDesigner bridge/runtime
        +---------+----------+---------+---------+
        |         |          |         |         |
        v         v          v         v         v
   Screen 1   Screen 2   Screen 3   Screen 4   Dashboard
        |         |          |         |
        v         v          v         v
   visuals    band/card  camera/AI   crowd/lyrics
                          |
        +-----------------+----------------+
        |                                  |
        v                                  v
   Audio/TTS route                    DMX/fog route
   simulated first                    simulated first
```

## Four Projection Surfaces

The four outputs should have distinct roles so the demo reads as a system:

| Surface | Role | Default content | Hermes-controlled changes |
| --- | --- | --- | --- |
| Screen 1 - Main identity | Main stage narrative | show title, band name, AI announcements, countdowns | `announce`, `request_cue band_intro`, text overlays |
| Screen 2 - Reactive world | Music visual engine | audio-reactive generative scene | `change_mood`, palette, density, energy |
| Screen 3 - Camera / AI vision | camera, silhouettes, pose/crowd energy, visual echo | camera or synthetic fallback | scene family, camera layer on/off, safe intensity |
| Screen 4 - Crowd / interaction | Telegram prompts, audience poll, lyrics, sponsor/venue cards | QR/prompt wall and status snippets | audience suggestions, vote result, next-band tease |

The operator dashboard is separate from the four public outputs. It should show
current cue, next cue, bridge health, projector state, Telegram status, Hermes
rationale, approval queue, effect cooldowns, and panic state.

## Telegram Command Surface

Use long polling for the local POC and limit updates to messages plus callback
queries. Move to webhooks only when deployment has TLS, routing, and secret
handling. A Telegram bot cannot use `getUpdates` while a webhook is active, so
the POC should choose one mode per environment.

Operator commands:

| Command | Example | Intent | Policy |
| --- | --- | --- | --- |
| `/status` | `/status` | `panic_status` + health summary | allow |
| `/mood` | `/mood red chaotic 70` | `change_mood` | allow with bounded intensity |
| `/cue` | `/cue band_intro` | `request_cue` | allow only if preapproved, otherwise queue |
| `/band` | `/band start Terno Rei` | `request_cue` + `announce` | visual allow; PA can require approval |
| `/announce` | `/announce 5 minutes to doors` | `announce` | allow/approval by role |
| `/fog` | `/fog 3s light` | `arm_effect fog` | approval-gated |
| `/lights` | `/lights warm amber wash` | mood or lighting scene request | dry-run/approval until fixture policy exists |
| `/approve` | inline button or `/approve approval_0001` | `approve_effect` | FOH/operator only |
| `/deny` | `/deny approval_0001` | `cancel_effect` | FOH/operator only |
| `/panic` | `/panic status` only in Telegram | status only; local panic remains physical/local |

Audience commands are lower authority:

- `/vibe red`, `/vote calm`, `/request chorus energy`, `/message <short text>`.
- They can influence mood suggestions, never fog, lights, PA, panic, or mixer.

## Hermes Adapter Contract

Hermes should receive a context packet and return a structured candidate, not a
device command.

Input packet:

```json
{
  "message_id": "telegram:12345",
  "chat_role": "operator",
  "user_role": "foh",
  "text": "/fog 3s light",
  "show_state": {
    "current_scene": "song_energy",
    "next_scene": "band_b_intro",
    "panic": false,
    "pending_approvals": [],
    "recent_effects": []
  },
  "allowed_intents": [
    "announce",
    "change_mood",
    "request_cue",
    "arm_effect",
    "log_note",
    "panic_status"
  ]
}
```

Output candidate:

```json
{
  "intent": {
    "type": "arm_effect",
    "effect": "fog",
    "duration_seconds": 3,
    "intensity": 0.35
  },
  "confidence": 0.82,
  "rationale": "The operator asked for a short light fog cue.",
  "operator_reply": "Queued fog for FOH approval."
}
```

Malformed Hermes output is blocked before policy evaluation. Low-confidence
output becomes a clarification question, not execution.

## Hardware Matrix

| Area | POC mode | Bench mode | Venue/live mode |
| --- | --- | --- | --- |
| Four projectors | simulated or TD windows | real outputs with test pattern | mapped, labeled, fallback black/freeze tested |
| Telegram | long polling, local process | same, allowlisted chat | webhook or long polling on isolated machine |
| Hermes | adapter stub or configured HTTP call | real provider with structured JSON | provider with timeout and deterministic fallback |
| PA/TTS | local speaker/file render | routed to audio interface spare channel | FOH-approved route with ducking and mute fallback |
| Audio analysis | synthetic/file audio | mixer/interface input | measured latency, local beat/energy analysis |
| DMX lights | simulated plan only | Art-Net/sACN test fixture or visualizer | fixture patch, safe scene, universe isolation |
| Fog/hazer | approval dry-run only | relay/DMX bench cue with no audience | operator-approved, max 3s, cooldown, fire/sensor checks |
| Strobe | blocked/approval dry-run | visual simulator only unless approved | venue policy required; conservative limits |
| Moving heads/lasers | blocked | blocked or offline preview | operator-only until separate safety pass |

## Policy Defaults

| Category | Examples | Default |
| --- | --- | --- |
| Allowed | mood, palette, preapproved visual cue, log note, status | auto-execute or dry-run |
| Approval-gated | fog/hazer 3s, short low-intensity strobe, PA announcement | FOH approval required |
| Blocked | long strobe, excessive fog, malformed Hermes output, unknown cue | no plan generated |
| Operator-only | blackout, freeze, moving heads, lasers, mixer gain, PA mute/routing, local panic | local operator path only |

## Immersion Ideas

- QR code on Screen 4 lets the audience vote for "calm / chaos / bright /
  dark"; Hermes summarizes the vote into a bounded mood change.
- Hermes acts as MC: announces band intros, delay notices, raffle or bar calls,
  and post-show thank-you messages.
- Screen 3 uses camera silhouettes or pose tracking for a "crowd aura" visual.
- Screen 2 reacts to bass/energy locally while Hermes changes only phrase-level
  scene direction.
- A "safety proof" moment shows blocked excessive fog/strobe requests on the
  dashboard, building trust with producers.
- Post-show recap: Hermes writes a show log with top crowd prompts, cue history,
  blocked actions, and final media/render links.

## Demo Run

```yaml
title: Hermes AI Party POC
bpm: 124
surfaces:
  main_identity: screen_1
  reactive_world: screen_2
  ai_vision: screen_3
  crowd_interaction: screen_4
scenes:
  - id: doors
    cue: doors_idle
    notes: Four screens boot; Screen 4 shows Telegram QR; no physical effects.
  - id: hermes_intro
    cue: ai_intro_text
    notes: Hermes introduces the system; PA/TTS simulated or approved.
  - id: band_a_intro
    cue: band_intro
    notes: Band card on Screen 1, reactive warm-up on Screen 2, optional fog queued.
  - id: song_energy
    cue: music_reactive_main
    notes: TouchDesigner handles local beat/energy; Hermes can change mood.
  - id: telegram_request
    cue: audience_mood_shift
    notes: Telegram command changes palette/intensity within policy.
  - id: safety_proof
    cue: policy_demo
    notes: Excess fog/strobe request is blocked; panic status is visible.
  - id: closing
    cue: recap_log
    notes: Hermes thanks audience and writes audit recap.
```

## Implementation Roadmap

### Phase 0 - proof inventory

- Verify current `showDirectorRuntime` behavior and docs.
- Decide Hermes adapter mode: stub, local LLM, or provider HTTP.
- Decide Telegram receiving mode: local long polling for first POC.
- Draft the venue manifest with unknowns marked `OPEN`.

Exit: no live hardware claim is unproven.

### Phase 1 - Telegram/Hermes dry-run

- Add a local Telegram gateway that maps allowlisted messages to Hermes calls.
- Add a Hermes adapter interface and deterministic fallback parser.
- Feed candidates into `showDirectorRuntime`.
- Send Telegram replies for allowed, queued, blocked, and invalid decisions.

Exit: dry-run works with no TouchDesigner or hardware connection.

Status: implemented for the local deterministic/Hermes-candidate path. Live
Hermes provider binding remains adapter-shaped until the provider API is known.

### Phase 2 - four-screen visual rehearsal

- Build a TD show scaffold with four output roles.
- Create the demo setlist and preapproved cues.
- Add safe fallback visual, black/freeze path, and preview captures.
- Keep node layouts deterministic and non-overlapping.

Exit: four surfaces show distinct roles with fallback states.

### Phase 3 - dashboard and approvals

- Show latest Telegram message, Hermes rationale, decision, plan, approvals,
  cooldowns, bridge health, and panic state.
- Approvals can be resolved from Telegram and from a local operator surface.

Exit: operator can reconstruct every action from the audit log.

### Phase 4 - audio and announcements

- Route audio input into TouchDesigner analysis.
- Add TTS/announcement dry-run first; bench route to spare audio channel second.
- Keep PA mute/routing operator-only.

Exit: Hermes can announce in simulation or approved bench mode without affecting
FOH unexpectedly.

### Phase 5 - lights and fog bench

- Model DMX/Art-Net fixture patch and fog/hazer device as venue manifest entries.
- Validate in visualizer or isolated fixture bench.
- Enforce max duration, intensity, cooldown, and operator approval.

Exit: one bounded fog or lighting scene can be rehearsed with safe-state proof.

### Phase 6 - venue rehearsal

- Test all projectors, audio input, PA/TTS route, network isolation, bridge,
  Telegram connectivity, emergency paths, and hardware safe states.
- Measure latency from Telegram -> Hermes -> policy -> TD.
- Decide which actions are allowed live and which remain simulated.

Exit: signed venue rehearsal matrix with PASS/FAIL/UNVERIFIED rows.

## Candidate Implementation Backlog

| Priority | Item | Type | Notes |
| --- | --- | --- | --- |
| P0 | `telegram_show_gateway` | CLI/service | Long-poll Telegram updates, ACL, audit ids, replies. |
| P0 | `HermesShowDirectorAdapter` | TS module | Structured intent candidate with timeout and fallback parser. |
| P0 | `ShowIntent` extensions | schema | Add screen targeting and announcement approval metadata if needed. |
| P0 | demo policy + venue manifest fixtures | fixture/docs | Repeatable dry-run examples. |
| P1 | four-screen show scaffold | tdmcp feature/recipe | Distinct output roles and fallback paths. |
| P1 | FOH dashboard approval panel | tdmcp feature | Queue, cooldowns, rationale, panic state. |
| P1 | Telegram inline approvals | integration | Callback query -> approve/cancel. |
| P2 | TTS announcement route | integration | File/local speaker first, FOH route later. |
| P2 | DMX/fog bench adapter | integration | Requires venue manifest and safety QA. |
| P2 | post-show recap generator | docs/AI | Audit log -> human recap. |

## Validation Gates

- Unit: Telegram parser, Hermes adapter fallback, `ShowIntent` parsing, policy
  decisions, approval transitions, duplicate update handling.
- Integration dry-run: Telegram message -> Hermes candidate -> policy result ->
  Telegram reply, no TD context created.
- TD rehearsal: four screen outputs build, preview, and expose fallbacks.
- Bridge: health, panic/freeze/blackout path, no node overlap in generated
  networks.
- Venue bench: DMX/fog/TTS only after real safe-state and operator approval tests.
- Docs: EN/PT public docs mention only validated capabilities.

## Open Decisions

- Hermes API shape and authentication method.
- Exact Telegram roles and chat ids.
- Projector output hardware and screen geometry.
- PA/TTS route and whether announcements need FOH approval.
- Lighting protocol and fixture patch.
- Fog/hazer control method and venue safety requirements.
- Whether the first demo should be two screens for portability or all four
  screens from day one. The requested target is four screens; a two-screen
  fallback remains useful for travel demos.
