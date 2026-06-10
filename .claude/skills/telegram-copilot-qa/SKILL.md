---
name: telegram-copilot-qa
description: "QA and security verification for the tdmcp Telegram + Ollama copilot. Use whenever validating, testing, reviewing, fixing QA, or checking release readiness for Telegram Bot API intake, local Ollama/tool-call behavior, allowlists, confirmations, secret handling, command routing, and live TouchDesigner control from Telegram."
---

# telegram-copilot-qa

Verify that Telegram control of TouchDesigner is correct, bounded, and safe. This
feature crosses external chat, local LLM, tdmcp tools, and a live TD bridge, so
most bugs live at boundaries.

## Required checks

### Security boundaries

- Bot token is read from config/env and never printed.
- `chat_id` / user allowlist is enforced before LLM invocation.
- Non-allowlisted input cannot trigger LLM calls, tool calls, or bridge calls.
- `safe` mode exposes read-only tools only.
- Mutating tools require confirmation unless the implementation explicitly
  documents a narrower trusted mode.
- Confirmation is bound to the exact pending action and expires/cancels.
- No local server (`9980`, Ollama, chat UI) is exposed publicly by default.

### Telegram boundary

- `getUpdates` offset handling prevents duplicate execution.
- `sendMessage` handles long/failing responses gracefully.
- Unsupported update types do not crash the loop.
- `/cancel`, `/status`, tier commands, `/approve`, and `/panic` are covered.

### LLM/tool boundary

- Mock an OpenAI-compatible/Ollama response that emits a tool call.
- Assert tool-tier selection maps to the expected `resolveTools` output.
- Assert invalid tool-call args produce a safe user-visible failure.
- Assert conversation history is bounded.

### TouchDesigner boundary

- Offline tests must pass without TD.
- If bridge is reachable, run a live smoke:
  1. bridge health;
  2. read-only prompt;
  3. confirmed mutating prompt in a scratch parent;
  4. node errors after cook;
  5. layout coordinates inspected for created nodes.
- If bridge is offline, mark live checks `UNVERIFIED - pending bridge`.

## Gate commands

Run the relevant focused tests first, then the repo gates before final PASS:

```bash
npm run typecheck
npm run build
./node_modules/.bin/biome check .
npm test
npm run test:bridge
```

If docs or recipes changed, also run:

```bash
npm run validate:recipes
npm run docs:build
```

## Report format

Write `_workspace/telegram-copilot/04_qa.md` with:

- `PASS`: checks completed with evidence;
- `FAIL`: file:line, observed behavior, owner, smallest acceptable fix;
- `UNVERIFIED`: service/hardware unavailable or live check intentionally held;
- commands run and exact outcomes;
- residual security risks.

## Trigger validation

Should trigger:

- "QA do bot Telegram do tdmcp"
- "validar segurança do Telegram + Ollama"
- "testar se chat_id não autorizado chega no LLM"
- "checar confirmações antes de mutar TouchDesigner"
- "rodar gates do telegram-copilot"
- "verificar live control pelo Telegram"

Should not trigger:

- generic TD feature QA unrelated to Telegram/Ollama;
- release docs-only updates;
- cookbook examples;
- Connectors Directory QA;
- broad coverage campaign work.
