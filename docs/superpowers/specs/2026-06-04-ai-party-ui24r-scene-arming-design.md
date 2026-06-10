# AI Party Ui24R Scene-Arming Design

Date: 2026-06-04
Status: design complete for dry-run MVP; live Ui24R execution blocked pending
bench and venue validation
Harness: `tdmcp-ai-party-mixer-design`

## Summary

Expand AI-Controlled Party with Soundcraft Ui24R mixer awareness through
operator-approved scene arming. The AI may prepare a specific Ui24R show,
snapshot, or cue change, but a human operator must approve one exact action
before any adapter can dispatch it.

The first implementation should ship contract + dry-run adapter only. Bitfocus
Companion is the recommended first live backend after isolated bench validation.
A direct Node bridge is a later backend after protocol validation on the target
Ui24R firmware.

## Source Baseline

- Soundcraft's official Ui24R product page documents browser-based control,
  firmware support for cue recall, and downloadable owner manuals:
  <https://www.soundcraft.com/en-US/products/ui24R>
- The Ui24R owner manual documents show/snapshot recall and the relationship
  between shows and snapshots:
  <https://www.soundcraft.com/en/product_documents/ui24r_manual_v1-0_web-pdf>
- Bitfocus lists a Soundcraft Ui connection for Ui12, Ui16, and Ui24R with
  show, snapshot, and cue loading actions, making Companion the lowest-risk
  first live backend to bench:
  <https://bitfocus.io/connections/soundcraft-ui>
- Companion v4.3 documents HTTP button triggering and connection status
  endpoints, which fits a preconfigured one-button scene dispatch instead of
  exposing raw mixer commands:
  <https://companion.free/user-guide/v4.3/remote-control/http-remote-control/>

## MVP Flow

```text
voice / ChatGPT / setlist / TD audio analysis
  -> AI Show Director
  -> arm_mixer_scene
  -> MixerScenePolicy + venue scene catalog
  -> approval queue
  -> authenticated operator approval
  -> dry-run adapter first
  -> Companion live backend after bench validation
  -> audit log + dashboard
```

## Non-Goals

- No autonomous mixer execution.
- No mixer gain, PA mute, routing, patching, mute groups, phantom power, or
  channel-strip control.
- No raw Ui24R, Companion, WebSocket, HTTP, or arbitrary adapter command path.
- No claim that approval means hardware changed.
- No inferred rollback of mixer state.

## Contract

Add a new `ShowIntent` variant, separate from `arm_effect`:

```ts
type MixerSceneIntent = {
  type: "arm_mixer_scene";
  adapter_target: {
    kind: "soundcraft_ui24r";
    mixer_id: string;
  };
  target:
    | { kind: "show"; show_name?: string; scene_id?: string; setlist_ref?: string }
    | {
        kind: "snapshot";
        show_name?: string;
        snapshot_name?: string;
        scene_id?: string;
        setlist_ref?: string;
      }
    | { kind: "cue"; show_name?: string; cue_name?: string; scene_id?: string; setlist_ref?: string };
  request?: {
    source?: "voice" | "chatgpt" | "setlist" | "td_audio_analysis" | "operator" | "scheduler";
    raw_text?: string;
    reason?: string;
    requested_for?: string;
  };
};
```

Policy result:

- valid catalog-backed mixer scene requests return `require_approval`;
- the MVP never returns `allow` for mixer scenes;
- missing config, unknown target, unresolved `setlist_ref`, unsupported target,
  changed catalog hash, or unsafe scene diff returns `block`;
- `mixer_gain`, `pa_mute`, and `audio_routing` remain blocked `arm_effect`
  operations.

Approval model:

- add a generic `ShowApprovalTarget`;
- preserve old effect approvals for backwards compatibility;
- support `target.kind = "mixer_scene"` with exact adapter and scene target;
- keep CLI verbs as `tdmcp-agent show-director approve <id>` and
  `tdmcp-agent show-director cancel <id>`.

Approved dry-run plan:

```json
{
  "kind": "mixer_scene",
  "action": "arm",
  "adapter_target": { "kind": "soundcraft_ui24r", "mixer_id": "foh-ui24r" },
  "mixer_scene": {
    "kind": "snapshot",
    "show_name": "AI Party Demo",
    "snapshot_name": "Band A Intro"
  },
  "approval_id": "approval_0001",
  "operator": "front-of-house",
  "dry_run_only": true
}
```

## Scene Catalog And Safety Manifest

Every AI-armable mixer scene must be in a trusted venue catalog. The LLM may not
invent or live-match scene names.

Minimum catalog fields:

- stable scene ID;
- operator display label;
- adapter target and operation: `recall_show`, `recall_snapshot`, or
  `recall_cue`;
- Ui24R show/snapshot/cue reference;
- policy hash or catalog version;
- exported checksum/hash or equivalent evidence;
- allowed setlist sections;
- last rehearsal/bench validation time;
- rollback/manual recovery target;
- safety notes;
- forbidden-delta result.

Hard gate: if the system cannot prove that a scene excludes gain, PA mute,
routing, patch, channel-strip, mute-group, phantom-power, or other forbidden
changes, that scene is not AI-armable in the MVP. It may still be manually
recalled by the audio operator outside the AI path.

## Adapter Strategy

### Dry-Run

The dry-run adapter is the first shipped backend. It consumes only approved
mixer-scene plans, validates the catalog, and returns
`hardware_changed: false`.

It should simulate missing targets, stale approvals, policy hash mismatch,
backend health failures, timeouts, readback mismatch, and duplicate idempotency
keys.

### Companion

Companion is the first live backend after bench validation. tdmcp maps an
approved scene ID to a preconfigured Companion button; Companion owns the
Soundcraft Ui connection.

Live states must stay precise:

- HTTP button press accepted -> `sent` or `acknowledged`;
- Soundcraft readback or operator confirmation -> `confirmed`;
- timeout after send -> `unknown`;
- no readback -> never claim confirmed.

### Direct Node

Direct Node bridge is later. It should use a typed allowlist around the
Soundcraft Ui protocol and must not expose raw commands. It requires bench proof
against the target Ui24R firmware before any live backend is enabled.

## Policy Invariants

- Caller-provided policy can make rules stricter, never softer.
- Hard denies override all user/LLM policy input.
- `preapproved`, `operator`, `approval_id`, `state`, and target metadata from
  LLM/voice/ChatGPT are untrusted for live authority.
- Approval must be explicit, fresh, one-shot, operator-authenticated, and tied
  to the exact scene hash/version shown to the operator.
- Approval re-runs policy immediately before adapter dispatch.
- One idempotency key may produce at most one live send.
- Unknown adapter state stops further AI mixer actions until operator review.
- Panic/fallback bypasses the LLM and approval queue.

## Dashboard And Runbook

The operator surface must show current/next cue context, mixer adapter backend
and health, pending approvals, exact scene label, adapter target, policy reason,
safety summary, approval state, audit log, and panic/fallback state.

Runbook language should use "arms", "prepares", "queues", and "requires
approval" for AI behavior. Use "executes" only for operator-approved adapter
actions. Use "confirmed" only with readback or explicit operator confirmation.

## Implementation Slices

### Slice 1: Contract + Dry-Run

- Add `arm_mixer_scene` schema.
- Add `MixerScenePolicy`/catalog validation.
- Add generic approval target while preserving effect approvals.
- Add `mixer_scene` dry-run action plan.
- Add dry-run adapter interface/stub.
- Add CLI schema/help examples.
- Add unit tests and CLI tests.

### Slice 2: Docs + Runbook

- Update EN/PT AI-Controlled Party docs.
- Add dry-run CLI example once implemented.
- Add rehearsal/show-day checklist.
- Keep live Soundcraft execution marked not live-validated.

### Slice 3: Companion Bench Spike

- Add Companion backend behind live-enable flag.
- Map one bench-validated scene to one button.
- Health-check Companion and Soundcraft connection.
- Record `sent`, `acknowledged`, `confirmed`, `failed`, `unknown`.
- Do not proceed without isolated Ui24R bench validation.

### Slice 4: Direct Node Research

- Prove exact Ui24R show/snapshot/cue APIs against target firmware.
- Build fixture tests before live code.
- Keep raw commands and non-MVP mixer operations unavailable.

## Verification Gates

Run for Slice 1:

```bash
npm run typecheck
npm run build
npm run lint
npm test -- tests/unit/showDirector.test.ts tests/unit/cliAgent.test.ts
```

Add tests for valid show/snapshot/cue mixer targets, blocked unknown
adapter/mixer IDs, unresolved `setlist_ref`, approval revalidation, dry-run-only
plans, hard-deny custom-policy bypass attempts, and the CLI guarantee that no
TD/Soundcraft/Companion/Node client is built during dry-run.

Live gates:

1. Contract gate.
2. Dry-run CI gate.
3. Companion bench gate.
4. Direct Node bench gate.
5. Venue rehearsal gate.
6. Show-day gate.
7. Post-show audit gate.

## Handoff Prompt

```text
Use the tdmcp-pipeline harness to implement Slice 1 of
docs/superpowers/specs/2026-06-04-ai-party-ui24r-scene-arming-design.md.

Scope:
- Add an operator-approved Soundcraft Ui24R mixer scene-arming contract to the
  existing dry-run AI Show Director.
- Add `arm_mixer_scene` as a new ShowIntent variant.
- Add a MixerScenePolicy/catalog validator for predeclared Soundcraft Ui24R
  show/snapshot/cue targets.
- Add generic approval targets while preserving existing effect approvals.
- Emit a dry-run-only `mixer_scene` action plan after authenticated approval.
- Add a dry-run adapter interface/stub that never contacts hardware.
- Keep `mixer_gain`, `pa_mute`, `audio_routing`, routing, patching,
  channel-strip edits, phantom power and raw adapter commands blocked.
- Include unit and CLI tests proving custom policy cannot soften hard denies and
  no TD/Soundcraft/Companion/Node client is built during dry-run.

Do not implement live Companion or direct Ui24R execution in this slice. Add only
typed stubs or not-configured results for future live backends.
```

## Open Decisions

- Panic handling for pending mixer approvals: recommended default is mark them
  stale/cancelled after panic, requiring a new arm cycle.
- Public term: use "show/snapshot/cue" in technical docs and "mixer scene
  arming" as the umbrella term.
- Live backend priority: dry-run first, Companion bench second, direct Node
  later.
- Confirmation wording: use `confirmed` only with readback or explicit operator
  confirmation.
