---
name: mixer-scene-contract
description: "Design the MixerSceneIntent, approval state, JSON schema, CLI examples, audit entries, and tests for AI-Controlled Party mixer/Soundcraft Ui24R scene arming. Use whenever a task mentions mixer scenes, Ui24R snapshots/cues, operator-approved mixer control, show-director contract updates, schema updates, dry-run CLI shape, or follow-ups that revise this contract."
---

# mixer-scene-contract

Design the structured contract for approved mixer scene changes. This skill is
for design/spec work, not implementation.

## Context to read

- `src/automation/showDirectorSchema.ts`
- `src/automation/showDirectorRuntime.ts`
- `src/cli/agent.ts` around `show-director`
- `tests/unit/showDirector.test.ts`
- `tests/unit/cliAgent.test.ts`

## Design rules

- Keep mixer scene changes separate from generic `arm_effect`.
- The MVP operation is "arm scene/cue for approval", not autonomous execution.
- Require explicit names or IDs: `show_name`, `snapshot_name`, `cue_name`,
  `scene_id`, or `setlist_ref`. Do not design fuzzy live lookup as execution.
- Preserve blocked/operator-only semantics for `mixer_gain`, `pa_mute`, and
  `audio_routing`.
- Every accepted request needs an audit entry with request, intent, decision,
  approval ID, operator, and adapter target.

## Output

Write `_workspace/ai-party-mixer/01_contract.md` with:

1. proposed schema fields and examples;
2. approval and audit model;
3. CLI dry-run examples;
4. mapping to action plans;
5. compatibility notes;
6. unit-test checklist.

## Quality bar

The result should be specific enough that a builder can implement it without
asking what fields exist or how approval flows.
