---
name: ai-party-mixer-runbook
description: "Write operator-facing and public documentation plans for AI-Controlled Party mixer/Soundcraft Ui24R scene arming. Use for runbooks, rehearsal checklists, show-day checklists, EN/PT docs updates, demo scripts, safety wording, and follow-up documentation revisions."
---

# ai-party-mixer-runbook

Turn the technical design into a practical docs/runbook plan.

## Context to read

- `docs/guide/ai-controlled-party.md`
- `docs/pt/guide/ai-controlled-party.md`
- `_workspace/ai-party-mixer/01_contract.md`
- `_workspace/ai-party-mixer/02_adapter.md`
- `_workspace/ai-party-mixer/03_policy_qa.md` if present

## Writing rules

- Keep public claims honest: AI co-pilots and arms, operator approves.
- Explain dry-run, rehearsal, approval, panic/fallback, and live-validation
  boundaries.
- Keep EN/PT parity in the update plan.
- Separate developer tasks from operator checklists.

## Output

Write `_workspace/ai-party-mixer/04_runbook_docs.md` with docs outline, rehearsal
checklist, show-day checklist, demo moments, safety copy, and build checks.

## Quality bar

An operator should be able to rehearse the flow without touching live mixer
hardware first.
