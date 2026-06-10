# AI-Controlled Party - Producer POC

Date: 2026-06-08
Status: Offline POC runner implemented; live TouchDesigner rehearsal still pending
Scope: closed producer rehearsal, not a public in-venue show
Anchor: `docs/superpowers/specs/2026-06-01-ai-controlled-party-plan.md`

## Summary

Build the recommended AI-Controlled Party proof of concept for a major event
producer: real TouchDesigner visuals, two synchronized outputs, local
audio-reactive behavior, text-or-transcript show requests, an operator-visible
approval flow, and simulated physical effects.

The claim for the POC is:

> An AI show director can co-pilot a party by proposing and selecting approved
> show intents while TouchDesigner keeps visual timing deterministic and a human
> operator keeps final authority over unsafe effects.

This POC must not present an LLM as an unrestricted stage controller. Fog,
hazer, strobe, moving heads, lasers, mixer gain, PA mute, audio routing,
blackout and freeze remain blocked, operator-only, or simulated unless a later
venue-specific validation pass approves them.

## Existing Surfaces

| Surface | Status | Repo anchor |
|---|---|---|
| Show intent schema | Exists | `src/automation/showDirectorSchema.ts` |
| Effect policy defaults | Exists | `src/automation/showDirectorSchema.ts` |
| Dry-run runtime, approvals and audit log | Exists | `src/automation/showDirectorRuntime.ts` |
| CLI dry-run policy proof | Exists | `tdmcp-agent show-director` |
| Cues and morphs | Exists | `src/tools/layer2/manageCue.ts` |
| Beat/cue autopilot | Exists | `src/tools/layer1/createAutopilot.ts` |
| Stage dashboard | Exists, needs POC configuration | `src/tools/layer2/createStageDashboard.ts` |
| Panic/freeze/blackout primitive | Exists | `src/tools/layer2/createPanic.ts` |
| Two-output projection rehearsal | Exists as tool/example pattern | `src/tools/layer1/createMultiOutput.ts` |
| Voice/STT/OpenClaw | Not live-validated | current docs mark as future validation |
| Approval dashboard integrated with show-director | Gap | build after POC spec |
| Physical fixtures/DMX/fog/strobe/PA | Out of scope for first POC | venue pass only |

## Implemented POC Surface

This spec now has a runnable offline rehearsal surface:

- `src/automation/aiPartyFanIn.ts` normalizes operator text, voice transcripts,
  dashboard actions, audio-section markers and scripted intents into
  `ShowIntent`.
- `src/automation/effectSimulator.ts` converts approved dry-run effect plans into
  simulated-only visual/log events.
- `src/automation/aiPartyPoc.ts` runs the producer rehearsal sequence, keeps
  approval/audit state, and reports a dashboard-ready dry-run JSON envelope.
- `tdmcp-agent ai-party-poc` exposes the runner without constructing a
  TouchDesigner context.
- `tests/unit/aiPartyFanIn.test.ts`, `tests/unit/aiPartyPoc.test.ts`,
  `tests/unit/showDirectorFixtures.test.ts`, and focused CLI tests pin the
  offline behavior.

## Demo Shape

Run this as a 15-20 minute closed rehearsal. The producer should see a show, not
a slide deck:

1. **Doors / preflight** - `doors_idle`
   - Two outputs are visible: main wall and lyric/status wall.
   - Dashboard shows bridge health, VU/BPM, cue queue and panic state.
2. **AI welcome** - `ai_intro_text`
   - A host-style announcement explains that physical effects are simulated.
3. **Band intro + approval** - `band_intro`, `fog_sim_short`
   - A pre-approved cue is allowed.
   - A short fog request enters approval and produces no hardware plan.
4. **Audio-reactive core** - `music_reactive_main`
   - TouchDesigner reacts locally to beat, energy, transients or chroma.
   - The AI only changes phrase, cue or mood, never beat-by-beat timing.
5. **Voice/text mood shift** - `mood_shift_safe_red_chaos`
   - A request such as "make it red and chaotic" becomes `change_mood`.
   - Intensity and palette remain bounded by policy/runtime controls.
6. **Safety proof** - `policy_block_demo`, `panic_recovery_test`
   - Excess fog, strobe, mixer, PA, blackout, freeze and laser requests are
     blocked or operator-only.
   - Panic/freeze/recovery is demonstrated locally, independent from the LLM.
7. **Closing / audit** - `credits_log`
   - The AI/operator shows the audit trail: allowed, queued, approved, blocked
     and cancelled decisions.

## Architecture

```text
operator text / voice transcript / scripted demo request
  -> fan-in normalizer
  -> ShowIntentSchema
  -> showDirectorRuntime policy + state
  -> approval queue + audit log
  -> safe action mapper
  -> TouchDesigner cues, dashboard, panic and multi-output visuals
```

For the first POC, the fan-in can be manual or scripted: a typed request, a
transcript pasted from another system, or a JSON intent fixture. Voice is allowed
as theatre only if it still lands as text before `ShowIntentSchema`.

## Technical Runbook

### Before rehearsal

1. Save or load a TouchDesigner project with these cues available:
   `doors_idle`, `ai_intro_text`, `band_intro`, `fog_sim_short`,
   `music_reactive_main`, `mood_shift_safe_red_chaos`, `policy_block_demo`,
   `panic_recovery_test`, `credits_log`.
2. Check bridge health:

   ```bash
   curl http://127.0.0.1:9980/api/info
   ```

3. Use a safe profile for any AI-facing session:
   `TDMCP_TOOL_PROFILE=safe`, `TDMCP_RAW_PYTHON=off` when possible, and
   `TDMCP_BRIDGE_TOKEN` on shared networks.
4. Configure two outputs with a known test pattern and fallback black/freeze
   path. Confirm there is no accidental overlap, clipping or unreadable text.
5. Validate audio first with synthetic/file input. Switch to mixer/device only
   after the synthetic path drives a stable feature CHOP.
6. Build or open the stage dashboard with cue buttons, VU/BPM, FPS/cook readout
   and a visible panic surface.
7. Confirm `create_panic` or `tdmcp-agent panic` works without using the LLM.
8. Disconnect or simulate all physical hazards: fog, hazer, strobe, moving
   heads, lasers, DMX, PA mute/gain and routing.

### During rehearsal

1. Open with `doors_idle` and show the dashboard plus both outputs.
2. Submit a pre-approved cue request:

   ```bash
   tdmcp-agent show-director --params '{"intent":{"type":"request_cue","cue":"band_intro","scene_id":"band_a_intro","preapproved":true}}'
   ```

3. Queue a short fog request and show that it requires approval:

   ```bash
   tdmcp-agent show-director --params '{"intent":{"type":"arm_effect","effect":"fog","duration_seconds":3,"intensity":0.35}}'
   ```

4. Run the audio-reactive scene from TouchDesigner. Do not ask the LLM to hit
   beats or drops directly.
5. Submit a bounded mood change:

   ```bash
   tdmcp-agent show-director --params '{"intent":{"type":"change_mood","mood":"red_chaotic_bounded","palette":["red","deep_blue","white"],"intensity":0.65}}'
   ```

6. Demonstrate blocked requests:

   ```bash
   tdmcp-agent show-director --params '{"intent":{"type":"arm_effect","effect":"fog","duration_seconds":30,"intensity":0.8}}'
   tdmcp-agent show-director --params '{"intent":{"type":"arm_effect","effect":"mixer_gain","intensity":0.7}}'
   ```

7. Trigger panic/freeze/recovery locally, then show the audit trail.

## Fixtures

The rehearsal fixtures live under `tests/fixtures/show-director/`:

- `producer-demo-setlist.json` - seven-moment scene list.
- `producer-demo-policy.json` - POC safety policy.
- `producer-demo-intents.jsonl` - allowed, approval-gated and blocked requests.

These are intentionally lightweight so the next implementation wave can use
them as test fixtures, CLI examples and operator rehearsal material.

## Acceptance Criteria

The POC passes when:

- the demo runs end-to-end without restarting TouchDesigner;
- two outputs remain framed and legible without accidental overlap;
- audio moves visuals locally in real time;
- `show-director` demonstrates `allow`, `require_approval` and `block`;
- no hazardous hardware receives an executable plan;
- panic/freeze/clear works without the LLM;
- the audit log reconstructs what happened.

The POC fails when:

- the bridge is offline or stale during rehearsal;
- projection output clips, covers or visually competes with dashboard/status UI;
- audio features do not update;
- dashboard/panic is inaccessible;
- a hazardous request produces a live hardware plan;
- any physical fog, strobe, DMX, laser, mixer or PA action is triggered without
  venue-specific validation.

## Parallel Implementation Lanes

Use a fan-out/fan-in workflow. Builders can work in parallel on isolated files;
one lead integrates shared registries/docs after review.

| Lane | Owner type | Write scope | Goal |
|---|---|---|---|
| Fan-in runtime | builder | new `src/automation/aiPartyFanIn.ts` + test | Normalize operator text/transcripts/scripted events into `ShowIntent`. |
| Approval dashboard | builder | new dashboard module or isolated extension spec | Display last AI decision, approval queue, audit log and approve/cancel controls. |
| Effect simulator | builder | new simulator module + test | Convert approved dry-run effects into visible/logged simulation states, never DMX. |
| Rehearsal recipe/runbook | docs/runtime builder | fixtures + docs | Turn this POC into repeatable CLI/TD steps. |
| Integration | single writer | shared registries/CLI/docs only after builders finish | Wire any shipped runtime surfaces without conflicts. |
| QA | independent verifier | no production edits | Run offline gates, bridge checks, layout checks and live TD validation when reachable. |

## Next Agent Prompt

```text
Use parallel agents to prepare the AI-Controlled Party producer POC from
docs/superpowers/specs/2026-06-08-ai-controlled-party-producer-poc.md.

Do not connect physical DMX/fog/strobe/mixer/PA hardware. Keep all hazardous
effects dry-run or simulated.

Fan out:
- Agent A: design/implement an isolated fan-in runtime that maps operator text
  or transcript events to ShowIntent, with unit tests.
- Agent B: design an approval/audit dashboard surface without editing shared
  stage-dashboard files unless the lead approves the integration path.
- Agent C: design/implement an effect simulator that represents fog/hazer/strobe
  as safe visual/log states only.
- Agent D: turn the fixtures and runbook into rehearsal commands and docs.

Fan in:
- A single integrator reviews the outputs, edits shared files if needed, and
  runs focused tests plus docs build.
- QA verifies allow/approval/block decisions, panic independence, bridge health,
  and visual layout integrity for desktop/mobile dashboard states.
```
