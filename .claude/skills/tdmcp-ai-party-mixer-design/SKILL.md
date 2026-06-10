---
name: tdmcp-ai-party-mixer-design
description: "Orchestrates the AI-Controlled Party mixer/Soundcraft Ui24R design team. Use whenever the user wants to design, update, refine, re-run, or implement-plan the Soundcraft Ui24R scene-arming expansion, mixer-aware AI party, operator-approved mixer cues, snapshots/cues/show control, Companion bridge, or any follow-up based on prior mixer design results. Produces a spec for tdmcp-pipeline; does not implement runtime code."
---

# tdmcp-ai-party-mixer-design

Coordinate the mixer-aware AI-Controlled Party design team. This harness produces
an implementation-ready spec for the operator-approved Soundcraft Ui24R
scene-arming MVP. It does not build runtime code directly.

## Execution mode: sub-agent fan-out -> lead synthesis

This repo's existing harnesses run as sub-agents in this environment. Use
parallel sub-agents for the specialist lanes, then synthesize in one lead pass.
All agent calls use `model: "opus"`.

## Agent roster

| Agent | Skill | Output |
| --- | --- | --- |
| `mixer-scene-contract-architect` | `mixer-scene-contract` | `_workspace/ai-party-mixer/01_contract.md` |
| `soundcraft-ui24r-adapter-architect` | `soundcraft-ui24r-adapter` | `_workspace/ai-party-mixer/02_adapter.md` |
| `mixer-policy-safety-qa` | `mixer-policy-safety` | `_workspace/ai-party-mixer/03_policy_qa.md` |
| `ai-party-mixer-runbook-writer` | `ai-party-mixer-runbook` | `_workspace/ai-party-mixer/04_runbook_docs.md` |
| `ai-party-mixer-lead` | this orchestrator context | `_workspace/ai-party-mixer/05_synthesis_design.md` and optional durable spec |

## Phase 0 - context check

1. Check whether `_workspace/ai-party-mixer/` exists.
2. Decide run mode:
   - no directory -> fresh run;
   - directory exists + user asks to revise one part -> partial re-run of only
     affected specialists, then lead synthesis;
   - directory exists + materially new objective -> move it to
     `_workspace/ai-party-mixer_<YYYYMMDD_HHMMSS>/`, then fresh run.
3. Read the current AI-Controlled Party docs/spec and `show-director` schema
   before spawning specialists.

## Phase 1 - prepare

Create `_workspace/ai-party-mixer/00_input.md` with:

- user objective;
- selected MVP mode: operator-approved scene arming;
- known mixer: Soundcraft Ui24R;
- explicit non-goals: gain, PA mute, routing, channel edits, autonomous hardware
  execution;
- questions or assumptions that still need bench validation.

## Phase 2 - specialist fan-out

Spawn the four specialist agents in one message when possible. Each prompt must:

- tell the agent to read its named skill first;
- name the exact output file it owns;
- remind it to preserve AI-Controlled Party safety constraints;
- ask for concise return summary, with the real substance in its file.

## Phase 3 - synthesis

The lead reads `00_input.md` plus all specialist artifacts and writes
`05_synthesis_design.md`. The synthesis must include:

- MVP scope and non-goals;
- architecture diagram/data flow;
- `MixerSceneIntent` and approval contract;
- Soundcraft adapter plan with backend recommendation;
- policy rules and bypass tests;
- docs/runbook tasks;
- implementation plan handoff prompt for `tdmcp-pipeline`.

If the user asks for a durable spec, also write
`docs/superpowers/specs/YYYY-MM-DD-ai-party-ui24r-scene-arming-design.md`.

## Phase 4 - handoff

Report the design and ask whether to pass it to `tdmcp-pipeline` for
implementation. Do not implement runtime code inside this harness.

## Data flow

```text
00_input
  -> 01_contract
  -> 02_adapter
  -> 03_policy_qa
  -> 04_runbook_docs
  -> 05_synthesis_design
  -> optional docs/superpowers/specs/... design
  -> tdmcp-pipeline handoff
```

## Error handling

- One missing specialist artifact: synthesize from available evidence and record
  the gap.
- Unverified Soundcraft protocol detail: keep as bench-validation requirement.
- Safety conflict: choose the stricter policy and list the disputed area.
- User wants implementation now: finish the design artifact first, then hand off
  to `tdmcp-pipeline`.

## Test scenarios

**Normal:** user asks to design the Soundcraft Ui24R expansion -> fresh
`_workspace/ai-party-mixer/` -> four specialist artifacts -> lead synthesis ->
implementation-ready spec/handoff.

**Partial follow-up:** user says "troca Companion por Node bridge" -> re-run only
`soundcraft-ui24r-adapter-architect`, then `mixer-policy-safety-qa` if the
backend risk changed, then lead synthesis.
