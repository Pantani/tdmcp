---
name: ai-party-poc
description: "Design, update, or QA any Hermes/Telegram AI-controlled-party POC for tdmcp: AI show director, four projections/teloes, Telegram triggers, Hermes intent planning, announcements over PA, fog/hazer, stage lights/DMX, operator approvals, panic paths, venue manifests, rehearsal runbooks, and follow-ups like refine, rerun, implement, validate, or split into tdmcp-pipeline tasks. Use for all AI party / show director / Hermes / Telegram / live-event automation planning before code or hardware control."
---

# ai-party-poc - Hermes AI party POC orchestrator

Use this skill when the user wants an AI-controlled party, Hermes-controlled
show, Telegram-triggered stage control, or a producer-facing POC around
TouchDesigner, tdmcp, projections, lights, fog, and announcements.

The goal is a credible show-control design with guardrails. Hermes may plan the
show intent, but deterministic local systems execute it only after policy,
approval, cooldown, and safe-state checks.

## Current repo anchors

Read these first:

- `docs/superpowers/specs/2026-06-01-ai-controlled-party-plan.md`
- `docs/guide/ai-controlled-party.md`
- `docs/pt/guide/ai-controlled-party.md`
- `src/automation/showDirectorSchema.ts`
- `src/automation/showDirectorRuntime.ts`
- `CLAUDE.md`

Existing validated surface: dry-run show intent policy, approval queue state,
audit log, and `tdmcp-agent show-director`. Do not claim live hardware control
unless a venue validation artifact proves it.

## Execution mode

Use a specialist team when the runtime supports team tools. In this Codex
environment, use sub-agent fallback with the same roster:

| Agent | Scope | Output |
| --- | --- | --- |
| `ai-party-poc-lead` | coordination and synthesis | `_workspace/ai-party/00_lead_plan.md` |
| `ai-party-systems-architect` | topology and services | `_workspace/ai-party/01_system_architecture.md` |
| `ai-party-show-designer` | four-screen show and cue design | `_workspace/ai-party/02_show_design.md` |
| `ai-party-chatops-integrator` | Telegram/Hermes command contract | `_workspace/ai-party/03_chatops_contract.md` |
| `ai-party-venue-safety-qa` | safety, validation, venue manifest | `_workspace/ai-party/04_safety_qa.md` |

All agent calls use `model: "opus"`.

## Phase 0 - context check

1. Inspect `_workspace/ai-party/`.
2. If it exists and the user asks to update one part, run only that specialist.
3. If it exists and the user gives a materially new POC, archive the old working
   directory with a timestamp before a fresh run.
4. Confirm whether the request is design-only, docs update, implementation
   planning, or code implementation.

## Phase 1 - POC boundary

Capture:

- venue type and audience size if known;
- four screen physical layout and output hardware;
- Telegram operator group and audience participation boundary;
- Hermes provider assumptions;
- PA/TTS route;
- lighting protocol and fixture patch status;
- fog/hazer device and safe-state status;
- required demo moments;
- what must remain simulated.

If data is missing, choose dry-run/simulator defaults and mark the missing venue
facts as open decisions.

## Phase 2 - parallel specialist design

Run the specialists in parallel where possible:

- systems architect designs topology, services, secrets, and deployment modes;
- show designer designs four screen roles, cues, setlist, and immersion loops;
- ChatOps integrator designs Telegram commands, Hermes adapter, roles, and
  approval messages;
- venue safety QA designs policy, threat model, test matrix, and venue manifest.

Each specialist writes its artifact under `_workspace/ai-party/`.

## Phase 3 - synthesis

The lead combines specialist output into the requested durable artifact, usually:

- `docs/superpowers/specs/YYYY-MM-DD-hermes-ai-party-poc.md`
- optional EN/PT guide updates if the user wants public docs;
- optional backlog items for `tdmcp-pipeline`.

The synthesis must include:

- architecture diagram;
- Telegram/Hermes command flow;
- four-screen show map;
- hardware and simulator matrix;
- policy table for allowed, approval-gated, blocked, and operator-only actions;
- phased implementation roadmap;
- acceptance criteria and validation gates.

## Phase 4 - implementation handoff

Do not implement runtime code unless the user explicitly asks for it after the
POC boundary is accepted. When implementation is approved:

1. Split features into small tdmcp specs.
2. Hand each runtime feature to `tdmcp-pipeline`.
3. Keep shared-file edits with one integrator.
4. Run typecheck, build, Biome, unit tests, recipe validation, and bridge tests
   as applicable.
5. Live-validate only with the venue/hardware present; otherwise mark
   `UNVERIFIED`.

## Safety rules

- Telegram and Hermes never directly command physical outputs.
- Announcements, mood, preapproved visual cues, logs, and status are low risk.
- Fog/hazer/strobe require bounded duration, intensity, cooldown, and operator
  approval.
- Blackout, freeze, moving heads, lasers, mixer gain, PA mute, and audio routing
  are operator-only until venue-specific validation changes that policy.
- Panic/safe-state must work without Telegram, Hermes, internet, or LLM.
- Secrets are never written into docs, commands, logs, screenshots, or specs.

## Telegram notes

Use the official Telegram Bot API behavior as the integration baseline:

- `getUpdates` is long polling and is appropriate for the first local POC.
- A bot cannot use `getUpdates` while a webhook is set.
- Webhooks are the deployment path once TLS, routing, and secret handling exist.
- `sendMessage` is enough for status, approval requests, and operator feedback.
- Limit `allowed_updates` to only the update types needed by the POC.

## Test scenarios

**Normal flow:** authorized Telegram operator sends `/band start band_a` ->
Hermes proposes `request_cue band_intro` -> policy allows because cue is
preapproved -> tdmcp executes or dry-runs the cue -> four screens transition ->
Telegram receives an audit id and status.

**Approval flow:** authorized operator sends `/fog 3s light` -> Hermes proposes
`arm_effect fog` -> policy queues approval -> Telegram inline approval goes to
FOH -> approved plan remains dry-run or bench-only until fog hardware is
validated.

**Blocked flow:** any user asks for "full strobe for 30 seconds" -> Hermes output
is parsed -> policy blocks duration/intensity -> no hardware plan is produced ->
operator sees the reason and audit id.

**Emergency flow:** local panic is triggered while Telegram/Hermes are offline
-> TouchDesigner switches to safe visual/black/freeze, fog off, DMX safe scene,
queue paused, and recovery checklist visible.
