---
name: soundcraft-ui24r-adapter
description: "Design the Soundcraft Ui24R adapter boundary for AI-Controlled Party: dry-run, Bitfocus Companion, direct Node bridge, connection health, config, failure handling, and live-validation gates. Use whenever a task mentions Soundcraft, Ui24R, snapshots, cues, Companion, soundcraft-ui-connection, mixer bridge, or revising the adapter design."
---

# soundcraft-ui24r-adapter

Design the adapter boundary between an approved mixer scene plan and Soundcraft
Ui24R control.

## Context to read

- AI-Controlled Party docs/spec
- current `show-director` runtime and CLI files
- any user-provided venue, mixer, or network notes

Use live web research only when making precise current claims about third-party
APIs. If not verified, mark the detail as a bench-test requirement.

## Backend order

1. **Dry-run/simulated**: always first; no hardware dependency.
2. **Bitfocus Companion**: preferred first live bridge for stage reliability and
   operator familiarity.
3. **Direct Node bridge**: later path using a Soundcraft connection library, only
   after the contract and policy are stable.

## Adapter scope

MVP allows only show/snapshot/cue loading after operator approval. Exclude gain,
PA mute, routing, phantom power, and channel edits.

## Output

Write `_workspace/ai-party-mixer/02_adapter.md` with interface shape, backend
options, required config, health checks, failure modes, and validation gates.

## Quality bar

The design must make it impossible to confuse "approval returned a plan" with
"hardware definitely changed state".
