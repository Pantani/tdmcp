# AI-Controlled Party - Harness Plan

Date: 2026-06-01
Status: Phase 2/3 dry-run policy slice implemented and offline-validated;
public guide updated; live hardware validation still venue-specific
Harness: `tdmcp-feature-discovery` -> `tdmcp-pipeline`
Working title: AI-Controlled Party

## Summary

Build a credible "AI-controlled party" path around TDMCP and TouchDesigner: the AI acts as
a show director that listens to the room, selects approved scenes, announces transitions,
reacts to music, and proposes physical effects; TouchDesigner remains the deterministic
runtime for visuals, timing, DMX, projection, dashboards, and emergency controls.

The public claim should be strong but honest:

> The first AI co-piloted party: language, music, light, projection, and TouchDesigner
> controlled through TDMCP, with a human operator holding final safety authority.

Do not position this as "the LLM directly controls every device with no operator." For a
real venue, that is the wrong safety model. The professional version is an AI show
director with guardrails, not an unrestricted autonomous stage operator.

## 2026-06-02 Validation Result

The concept now has a validated dry-run policy slice plus a first visual output baseline:

- Visual rehearsal: two example projections were used as the baseline proof that the
  party concept can fan visuals across show surfaces before adding physical effects.
- Policy/runtime: `ShowIntentSchema`, `EffectPolicySchema`, `showDirectorRuntime`, and
  `tdmcp-agent show-director` are implemented as a dry-run-only safety surface.
- Focused tests: `tests/unit/showDirector.test.ts` and `tests/unit/cliAgent.test.ts`
  passed together (121 tests), covering safe visual cues, approval-gated fog,
  blocked hazardous effects, malformed LLM output, approval/cancel state, and CLI
  non-connection to TouchDesigner.
- Recipe validation: `npm run validate:recipes` passed for all 15 built-in recipes,
  including `projection_mapping.json`.
- Public docs: `docs/guide/ai-controlled-party.md` and
  `docs/pt/guide/ai-controlled-party.md` now describe the validation matrix and
  current limits in EN/PT parity.
- Not live-validated yet: STT/OpenClaw wiring, dashboard approval UI, fixture
  patches, DMX/fog/strobe/moving-head/laser/PA output, and venue latency/safe-state
  checks.

## Current Repo Fit

TDMCP already has enough core pieces to support a staged demo:

- Show automation: shared setlist/scene schema, setlist runner, scheduler, scene timeline,
  cue composition, and vault round-tripping.
- VJ direction: `auto_vj_director`, `audio_to_show`, `vj_set_builder`, setlist planner,
  and music-reactive prompts.
- Audio-reactive systems: audio feature extraction, tempo sync, onset detection, chroma
  and transient/energy analysis, spectra, waveform, and audio fingerprint dispatch.
- Stage output: multi-output projector splitting, projection mapping, dome/mesh warp,
  output setup, and recording/rendering paths.
- Physical control: `create_dmx_fixture_pipeline`, external I/O for OSC/MIDI/DMX/Art-Net
  style workflows, MIDI reactive controls, and control surfaces.
- Safety and operations: stage dashboard, panic/freeze/blackout controls,
  `tdmcp-agent panic`, bridge health, and safe tool profiles.
- LLM surface: local copilot, OpenAI-compatible `TDMCP_LLM_BASE_URL`, server-side sampling
  fallbacks, and CLI automation commands.

Main gaps for a full party product:

- Real STT/voice request bridge. `tdmcp voice` is currently a wrapper/stub, not robust
  microphone transcription.
- AI Show Director service that joins setlist, live audio events, operator commands,
  policy checks, LLM decisions, and TDMCP execution.
- Effect permission model for fog, strobe, blackout, lasers, moving heads, and audio.
- Fixture patch model for real venue DMX devices rather than generic profiles only.
- Unified show dashboard for bridge, FPS/cook health, outputs, DMX universes, fog cooldown,
  cue queue, last AI decision, operator approvals, and panic state.
- TTS/announcement audio routing and optional ducking against the house mix.
- Venue runbook covering cabling, soundcheck, latency, network isolation, rehearsal, and
  fallback operation.

## Safety Position

The AI may decide intent. It must not be the final authority for hazardous action.

Allowed autonomy in MVP:

- select or suggest a visual scene;
- change color palette, density, tempo feel, text overlays, or non-hazardous parameters;
- announce or draft an announcement;
- propose fog/strobe/light cues;
- trigger pre-approved, low-risk cues inside strict limits;
- log and narrate what it is doing for the operator.

Requires deterministic local control or human approval:

- fog/hazer output;
- strobes and flash effects;
- blackout, freeze, PA mute, or major show stop;
- moving-head pan/tilt positions in public space;
- laser output;
- mixer/PA gain or routing;
- anything that affects visibility, hearing safety, fire alarms, crowd safety, or venue
  compliance.

Always present:

- physical or local keyboard kill switch;
- `create_panic` / `tdmcp-agent panic` path;
- known-good fallback visual;
- DMX safe scene;
- fog off state;
- bridge/network isolation;
- audit log of requested, approved, blocked, and executed actions.

## Target Architecture

```text
Microphone / host request
        |
        v
STT / OpenClaw / external voice bridge
        |
        v
AI Show Director service
        |                     Mixer / audio interface
        |                              |
        v                              v
LLM intent planner              TouchDesigner audio analysis
        |                              |
        +-------------+----------------+
                      |
                      v
Policy engine / permission model
                      |
        +-------------+-------------+
        |                           |
        v                           v
Operator approval UI          Safe auto-execute queue
        |                           |
        +-------------+-------------+
                      |
                      v
TDMCP MCP server / tdmcp-agent commands
                      |
                      v
TouchDesigner bridge/runtime
        |             |              |
        v             v              v
Projectors       DMX/fixtures     Dashboard/logs/panic
```

## Execution Modes

### Rehearsal Mode

Use the full TDMCP tool surface to create scenes, generate visuals, tune DMX fixtures,
compose setlists, save presets, create dashboards, and inspect the TD network.

Rehearsal mode can use more creative and mutating tools because the operator has time to
inspect, undo, rebuild, and test.

### Show Mode

Use a reduced command surface. The AI should mostly select, parameterize, and sequence
approved artifacts. New network generation during a live set is allowed only in sandboxed
preview lanes, never directly on the audience master output.

Recommended defaults:

- `TDMCP_TOOL_PROFILE=safe` for autonomous agents when possible.
- `TDMCP_RAW_PYTHON=off` on AI-facing sessions where raw Python is not required.
- `TDMCP_BRIDGE_TOKEN` on any shared network.
- `TDMCP_BRIDGE_ALLOW_EXEC=0` only if the show-mode feature set has been moved to
  structured bridge endpoints and no templated Python build paths are needed.

### Emergency Mode

Emergency mode bypasses the LLM. It must be local, deterministic, and fast:

- black output or freeze output;
- fog off;
- strobe off;
- DMX safe scene;
- LLM/control queue paused;
- operator-visible recovery checklist.

## MVP Demo

The first demo should be theatrical but constrained. It needs five visible moments:

1. **Doors / boot ritual**
   - The AI introduces the night on the main screen.
   - Dashboard shows "listening to mixer", bridge health, cue queue, and panic state.
   - A generative idle look runs on the projectors.

2. **Band intro**
   - Operator says or clicks "arm intro for Band A".
   - AI selects a pre-approved `band_intro` cue.
   - TouchDesigner fades the visual, shows the band name, and arms a short fog cue for
     operator approval.

3. **Music-reactive core**
   - Mixer audio enters TD.
   - Bass, transients, chroma, or energy channels drive density, scale, flash accents, and
     scene intensity.
   - The LLM operates at phrase/section level, not beat-by-beat.

4. **Microphone request**
   - Someone asks for a mood change, e.g. "make it red and chaotic".
   - STT/OpenClaw produces text.
   - AI Show Director maps it to `change_mood(red, chaotic)` and the policy engine limits
     the actual parameters.

5. **Safety proof**
   - Demonstrate panic/freeze/blackout and recovery on a non-destructive test cue.
   - Show a blocked request: e.g. "more fog for 30 seconds" becomes "blocked: max fog is 3s
     and requires operator approval".

## Demo Setlist Shape

Use the shared setlist/scene vocabulary so this can flow into existing tools.

```yaml
title: AI-Controlled Party Demo
bpm: 124
scenes:
  - id: doors
    cue: doors_idle
    notes: Generative idle, status overlay, no physical effects.
  - id: ai_intro
    cue: ai_intro_text
    notes: AI introduces the night and system state.
  - id: band_a_intro
    cue: band_intro
    hold_seconds: 20
    notes: Name card, low light look, fog request requires approval.
  - id: song_energy
    cue: music_reactive_main
    hold_beats: 64
    notes: Audio analysis drives approved visual parameters.
  - id: audience_request
    cue: mood_shift_safe
    notes: STT request maps to palette and intensity only.
  - id: emergency_demo
    cue: panic_recovery_test
    notes: Demonstrate safe blackout/freeze and restore.
  - id: closing
    cue: credits_log
    notes: AI summarizes the night and saves a show log.
```

## Implementation Roadmap

### Phase 0 - Spec and Proof Inventory

Goal: align the product claim with existing capabilities and decide what must be built.

Deliverables:

- this plan;
- feature list mapped to existing tools vs missing work;
- demo acceptance criteria;
- safety assumptions and venue checklist draft.

Exit criteria:

- all claims are traceable to existing repo tools or clearly marked as new work;
- no safety-critical action is assigned to unrestricted LLM control.

### Phase 1 - Demo Runbook and Party Mode Documentation

Goal: make the idea runnable by a human operator before adding new runtime code.

Deliverables:

- `docs/guide/ai-controlled-party.md`;
- `docs/pt/guide/ai-controlled-party.md`;
- checklist for projector mapping, audio input, DMX/fog, network, bridge, safe profile,
  panic, setlist import, rehearsal, and show-day operation;
- example prompts for ChatGPT/OpenClaw/TDMCP.

Candidate harness: documentation/cookbook skills, then `tdmcp-pipeline` if new guide wiring
or generated media is added.

### Phase 2 - AI Show Director Schema

Goal: define the structured contract between LLM intent and allowed TDMCP actions.

Deliverables:

- `ShowIntentSchema`: `announce`, `change_mood`, `request_cue`, `arm_effect`,
  `approve_effect`, `cancel_effect`, `panic_status`, `log_note`;
- `EffectPolicySchema`: per-effect max duration, cooldown, max intensity, approval
  requirement, allowed scenes, and operator-only flags;
- dry-run validator that explains `allow`, `require_approval`, or `block`.

Possible files:

- `src/automation/showDirectorSchema.ts`;
- `tests/unit/showDirectorSchema.test.ts`.

Exit criteria:

- malformed LLM output cannot execute;
- hazardous intents are blocked or require approval by default;
- policy decisions produce human-readable reasons.

### Phase 3 - Show Director CLI Prototype

Goal: create a non-live, dry-run-first command path that can receive text requests and
turn them into approved/blocked show actions.

Candidate command:

```bash
tdmcp-agent show-director --setlist demo.yaml --policy policy.yaml --request "make it red and chaotic" --dry-run
```

Deliverables:

- text request -> structured intent;
- deterministic fallback parser when no LLM is configured;
- policy validation;
- JSON/log output;
- optional execution of safe actions only.

Exit criteria:

- dry-run works with no TouchDesigner connection;
- execution mode refuses hazardous requests unless approval flags are present;
- every decision logs request, intent, policy result, and planned TDMCP action.

### Phase 4 - Voice/OpenClaw Bridge

Goal: integrate microphone or ChatOps requests without making voice a safety bypass.

Deliverables:

- adapter doc for OpenClaw/ChatGPT/Whisper/browser mic;
- optional CLI input mode reading newline-delimited transcription events;
- confidence threshold and confirmation flow;
- "unknown request" handling that asks the operator rather than guessing.

Exit criteria:

- voice can request mood/cue/announcement changes;
- fog/strobe/blackout/mixer requests are blocked or approval-gated;
- low-confidence transcription cannot execute.

### Phase 5 - Dashboard and Telemetry

Goal: give FOH/operator one readable control surface.

Deliverables:

- dashboard extension or recipe combining cue queue, current scene, next scene, audio
  energy, bridge health, FPS/cook warning, effect cooldowns, approval queue, panic state,
  and last AI rationale;
- log sink for show decisions;
- replayable post-show summary.

Exit criteria:

- operator can see what the AI asked for and what actually executed;
- panic/blackout/freeze remains visible and local;
- logs can reconstruct the show.

### Phase 6 - Venue Hardware Pass

Goal: move from generic demo to a specific room.

Deliverables:

- projector map and output layout;
- DMX universe and fixture patch;
- fog/hazer fixture profile and policy;
- audio input path from mixer/interface;
- optional TTS output path;
- rehearsal report with latency measurements.

Exit criteria:

- every physical fixture has a safe state;
- every hazardous action has max duration/cooldown and an approval rule;
- LLM round-trip latency is measured and determines whether AI operates per phrase, bar,
  or cue only.

## Initial Backlog

| Priority | Item | Type | Notes |
|---|---|---|---|
| P0 | Party mode docs/runbook | docs | Fastest path to credible demo. |
| P0 | Show intent + effect policy schema | code | Safety foundation before execution. |
| P0 | Dry-run show director CLI | code | Lets the team test requests without TD/hardware. |
| P0 | Demo setlist + policy examples | docs/test fixture | Makes the demo repeatable. |
| P1 | Voice/OpenClaw request bridge | integration | STT is outside current core; keep adapter-shaped. |
| P1 | Dashboard approval queue | code/TD | Needed for operator trust. |
| P1 | Show telemetry/logging | code | Required for post-show replay and debugging. |
| P1 | Fixture patch/policy examples | docs/code | Start with PAR, moving head, fog/hazer. |
| P2 | TTS announcer/ducking path | integration | Nice for public demo, not a safety blocker. |
| P2 | Post-show recap generator | AI/docs | Good narrative artifact. |
| P2 | Venue-specific camera/crowd energy input | integration | Useful later; avoid scope creep for MVP. |

## Harness Team Shape

Use the existing harnesses rather than creating a parallel one:

- `tdmcp-feature-discovery`: refine the backlog by surface (`controls`, `ai`, `cli`,
  `td-depth`, `library`) if the plan needs reprioritization.
- `tdmcp-pipeline`: implement each selected P0 feature through design -> build -> QA.
- `tdmcp-cookbook-examples`: create public examples once a demo artifact exists.

Recommended specialist lanes for implementation:

- **Show Director Architect**: owns schemas, CLI contract, and execution states.
- **Safety/Policy QA**: tries to bypass limits and verifies blocked/approval behavior.
- **TD Runtime Builder**: connects approved actions to setlists, cues, dashboard, panic,
  and DMX tools.
- **Docs/Runbook Author**: writes the bilingual venue/demo guide.
- **Live Validation Operator**: runs bridge, TD, audio, projector, and fixture tests.

## Acceptance Criteria

For a credible public MVP:

- A clean runbook exists and can be followed by someone other than the author.
- The demo can run with synthetic audio and no physical hardware for rehearsal.
- With hardware attached, each projector/fixture/fog path has a tested safe state.
- The AI can trigger or suggest at least one visible scene change from text.
- The AI can react to mixer audio through TD analysis, but timing-critical effects are
  executed by TD, not by LLM round-trips.
- A hazardous request is demonstrably blocked or approval-gated.
- Panic/freeze/blackout works without asking the LLM.
- Every AI decision is logged with request, interpreted intent, policy outcome, and
  executed action.

## Open Questions

- Which venue or room is the first target?
- How many projectors, and are they mirrored, edge-blended, or mapped to separate
  surfaces?
- Which mixer model/protocol is available, and is audio only observed or also controlled?
- Which DMX interface and fixtures are available?
- Is fog/hazer controlled over DMX, relay, or a manual remote?
- Should ChatGPT, OpenClaw, or local Ollama be the first operator-facing brain?
- Is the first public claim "controlled by AI" or "co-piloted by AI"?

## Next Execution Prompt

When ready to build the first slice, hand this to `tdmcp-pipeline`:

```text
Use the tdmcp-pipeline harness to implement Phase 2 and Phase 3 of
docs/superpowers/specs/2026-06-01-ai-controlled-party-plan.md.

Scope:
- Add a dry-run-first AI Show Director schema and policy validator.
- Add a CLI prototype that accepts a text request, parses/maps it to a safe show intent,
  evaluates effect policy, and prints/logs allow/require_approval/block.
- Do not connect hazardous actions to live DMX/fog yet.
- Include unit tests proving fog/strobe/blackout/mixer requests are blocked or approval
  gated by default.
```
