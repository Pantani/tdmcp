---
name: tdmcp-telegram-ollama-copilot
description: "Orchestrates the dedicated Telegram + Ollama local-copilot implementation team for tdmcp. Use whenever the user asks to build, implement, execute, continue, fix, QA, document, or ship Telegram/Telegram Bot API control of TouchDesigner through local Ollama, tdmcp ask/chat, runAgentTurn, local LLM tool calls, chat allowlists, confirmation gates, or real-time Telegram ChatOps for tdmcp. Use for follow-ups: re-run, resume, update, improve, or execute only one slice."
---

# tdmcp-telegram-ollama-copilot - implementation orchestrator

Coordinate the dedicated team that turns Telegram messages into safe local
Ollama-powered tdmcp copilot turns against TouchDesigner. This specializes the
generic tdmcp pipeline for a chat-facing control surface with stricter security
and confirmation requirements.

## Execution mode

This repo currently runs teams as coordinated sub-agents rather than
`TeamCreate`. Use a hybrid sub-agent workflow:

| Phase | Mode | Reason |
|---|---|---|
| Plan | local lead or `telegram-copilot-lead` | keep the scope tied to the local-first architecture and security gates. |
| Bot + LLM build | parallel sub-agents | Telegram intake and LLM/tool-call reuse have mostly disjoint write scopes. |
| Bridge/layout hardening | sequential sub-agent | bridge/client/node-layout slices share files and must not run in parallel. |
| Integrate/docs | single-writer sub-agent | CLI, config docs, and generated docs surfaces are shared files. |
| QA/fix loop | sub-agent fan-in | QA routes precise security or boundary defects to the owner. |

All spawned agents use `model: "opus"` unless the user explicitly requests a
different model.

## Agent roster

| Agent | Role | Skills | Output |
|---|---|---|---|
| `telegram-copilot-lead` | scope owner and wave captain | this skill | `_workspace/telegram-copilot/00_plan.md` |
| `telegram-bot-engineer` | Telegram Bot API client, long polling, command parser, allowlists | `telegram-copilot-build` | `_workspace/telegram-copilot/01_telegram_bot.md` |
| `ollama-copilot-engineer` | `runAgentTurn`/`LlmClient` reuse, tiers, confirmation state | `telegram-copilot-build` | `_workspace/telegram-copilot/02_ollama_agent.md` |
| `tdmcp-bridge-engineer` | bridge/client/node-layout hardening if needed | `tdmcp-bridge-endpoint` | `_workspace/telegram-copilot/02_bridge_layout.md` |
| `td-integrator` | single-writer CLI/config/docs/registry integration | `td-feature-integrate` | `_workspace/telegram-copilot/03_integrate.md` |
| `telegram-copilot-qa` | Telegram/Ollama/security/live-control QA | `telegram-copilot-qa` | `_workspace/telegram-copilot/04_qa.md` |

## Source of truth

Read these before changing code:

1. `CLAUDE.md`
2. `.claude/agents/telegram-copilot-lead.md`
3. `.claude/skills/telegram-copilot-build/SKILL.md`
4. `.claude/skills/telegram-copilot-qa/SKILL.md`
5. `src/llm/agent.ts`
6. `src/llm/client.ts`
7. `src/llm/tools.ts`
8. `src/cli/ask.ts`
9. `src/cli/chat.ts`
10. `src/utils/config.ts`
11. `docs/reference/cli.md`
12. `docs/reference/environment.md`

## Workflow

### Phase 0 - context check

1. Read `git status --short`.
2. Check `_workspace/telegram-copilot/`.
3. Decide run mode:
   - no workspace -> fresh run;
   - workspace exists + user says continue/fix/update -> resume only the
     affected phase;
   - workspace exists + new architecture direction -> archive the old folder
     with a timestamp before starting a new one.
4. Check whether TouchDesigner bridge and Ollama are reachable before making any
   live-control claim.

### Phase 1 - plan the wave

Create `_workspace/telegram-copilot/00_plan.md` with:

- target slice: design only, bot, LLM loop, bridge/layout hardening,
  integration/docs, QA, or all;
- owner per slice;
- exact write scopes;
- config/env keys expected;
- security gates;
- commands/gates expected;
- live service assumptions.

Default execution order:

1. design the local-first contract and threat model;
2. build Telegram adapter and LLM/tool adapter in parallel when write scopes are
   disjoint;
3. run bridge/layout hardening sequentially if remote mutation can create nodes;
4. integrate CLI/config/docs as the single writer;
5. QA mocked boundaries;
6. live Telegram/Ollama/TD validation only when credentials and services are
   available.

### Phase 2 - parallel bot and LLM build

Run in parallel when both are in scope:

- `telegram-bot-engineer`: Bot API client, long polling, command parser,
  allowlist, message sending, CLI/config hooks assigned by the plan.
- `ollama-copilot-engineer`: local copilot reuse, conversation state, tool tiers,
  confirmation gates, Telegram event translation assigned by the plan.

Each agent writes its `_workspace/telegram-copilot/0*_*.md` note.

### Phase 3 - bridge/layout hardening

Invoke `tdmcp-bridge-engineer` sequentially only if the plan needs bridge/client
changes, such as making `create_td_node` apply deterministic `nodeX`/`nodeY` or
promoting a proven `/api/exec` path to a first-class endpoint.

Do not run another bridge/client editor in parallel with this phase.

### Phase 4 - single-writer integration

Invoke `td-integrator` for shared files after builders report exports and desired
CLI/config/docs entries. The integrator owns shared surfaces such as:

- `src/index.ts` / CLI command dispatch;
- `src/cli/*` shared command tables;
- `src/utils/config.ts`;
- `docs/reference/cli.md`;
- `docs/reference/environment.md`;
- generated docs scripts if needed.

The integrator must run `npm run typecheck` and `npm run build`. If docs changed,
also run the docs gate that matches the touched files.

### Phase 5 - QA and fix loop

Invoke `telegram-copilot-qa` incrementally:

1. Bot API mocks and offset handling;
2. allowlist and secret handling;
3. local LLM/tool tier boundaries;
4. confirmation/cancel/panic behavior;
5. bridge/client/layout behavior;
6. full gates;
7. live Telegram/Ollama/TouchDesigner checks when available.

QA sends precise defects to the owner and re-validates after fixes. Cap repeated
fix loops at 2-3 rounds, then report the blocker.

### Phase 6 - report and next wave

Report:

- files changed;
- commands run and outcomes;
- PASS / FAIL / UNVERIFIED buckets;
- whether live Telegram, Ollama, and TouchDesigner were actually exercised;
- what remains before this is safe for a venue network.

Do not tag, release, or push unless the user explicitly asks.

## Data flow

```text
user request
  -> lead plan
  -> Telegram bot engineer -------+
  -> Ollama copilot engineer -----+-> integrator -> QA -> fixes -> final report
  -> bridge engineer when needed -+
```

## Error handling

| Situation | Strategy |
|---|---|
| Telegram token missing | Build and test with mocks; mark live Telegram check UNVERIFIED. |
| Ollama unavailable | Test fake LLM boundary; mark live model check UNVERIFIED. |
| TouchDesigner bridge offline | Run offline gates; mark live TD control UNVERIFIED. |
| Non-allowlisted chat reaches LLM | QA FAIL; block shipment until fixed. |
| Mutating tool executes without confirmation | QA FAIL; block shipment until fixed. |
| Bridge/client shared-file conflict | Stop parallel edits and have the lead reassign single ownership. |
| QA fail after 3 rounds | Hold failing slice; report evidence and next fix. |

## Test scenarios

### Normal flow

User says "executa o time Telegram + Ollama para controlar TouchDesigner." The
orchestrator creates `_workspace/telegram-copilot/00_plan.md`, runs Telegram and
LLM slices in parallel, hardens bridge/layout if remote creation is in scope,
integrates CLI/config/docs, runs mocked Bot API and LLM tests, runs repo gates,
and live-validates only when Telegram credentials, Ollama, and TouchDesigner are
available.

### Error flow

Telegram credentials are not present and TouchDesigner is offline. The team still
builds the mocked Bot API path, fake LLM tool-call path, and config/docs surfaces;
QA marks live Telegram and bridge checks UNVERIFIED, and the final report names
the exact env vars/services required for the live pass.

## Trigger validation

Should trigger:

- "executa o time Telegram + Ollama"
- "implementar bot Telegram para controlar TouchDesigner"
- "conectar Ollama local no Telegram com tdmcp"
- "criar comando tdmcp telegram"
- "fazer ChatOps Telegram para o tdmcp"
- "continuar a feature Telegram copilot"
- "QA do Telegram + Ollama copilot"
- "corrigir confirmação do Telegram antes de mutar TD"
- "documentar variáveis do bot Telegram"

Should not trigger:

- generic tdmcp feature with no Telegram/Ollama/chat control;
- Telegram marketing/community copy;
- Gmail or Discord bot work;
- broad backlog campaign;
- Connectors Directory submission;
- cookbook-only example expansion.
