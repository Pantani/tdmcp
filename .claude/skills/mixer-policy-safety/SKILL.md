---
name: mixer-policy-safety
description: "Review, harden, and test the safety policy for AI-Controlled Party mixer/Soundcraft Ui24R scene arming. Use for approval gates, blocked mixer operations, hazardous request handling, venue validation, bypass attempts, QA, risk review, or follow-up safety changes."
---

# mixer-policy-safety

Review the design from the viewpoint of a live-show safety gate.

## Context to read

- `_workspace/ai-party-mixer/01_contract.md`
- `_workspace/ai-party-mixer/02_adapter.md`
- current `show-director` schema/runtime
- AI-Controlled Party docs/spec

## Review rules

- AI can arm; human operator approves.
- Scene/cue execution must be predeclared and auditable.
- `mixer_gain`, `pa_mute`, `audio_routing`, channel edits, and routing changes
  stay blocked/operator-only.
- Live execution requires dry-run tests, adapter health, rollback/fallback notes,
  and a venue rehearsal.
- Low-confidence voice/STT input cannot execute or approve anything.

## Output

Write `_workspace/ai-party-mixer/03_policy_qa.md` with pass/fail findings,
bypass attempts, required tests, validation gates, and residual risks.

## Quality bar

Prefer a clear block over a clever risky shortcut. If a claim depends on venue
hardware, mark it venue-validated-only.
