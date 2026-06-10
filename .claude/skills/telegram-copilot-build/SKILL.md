---
name: telegram-copilot-build
description: "Build or modify the Telegram + Ollama local copilot slices for tdmcp. Use for Telegram Bot API long polling/webhook code, Ollama/OpenAI-compatible local LLM reuse, runAgentTurn integration, tool-tier confirmation gates, Telegram command routing, chat allowlists, and follow-up fixes or updates to this copilot."
---

# telegram-copilot-build

Build the Telegram + Ollama copilot as a thin adapter over the existing tdmcp
local copilot. Telegram receives messages; Ollama decides responses/tool calls;
tdmcp executes through the curated local tool registry and the TouchDesigner
bridge.

## Required context

Read these before changing code:

1. `CLAUDE.md`
2. `src/llm/agent.ts`
3. `src/llm/client.ts`
4. `src/llm/tools.ts`
5. `src/cli/ask.ts` and/or `src/cli/chat.ts`
6. `src/utils/config.ts`
7. `docs/reference/cli.md` and `docs/reference/environment.md` if CLI/env/docs
   are in scope

## Architecture constraints

- Telegram is a transport adapter, not a second tdmcp bridge.
- Reuse `runAgentTurn`, `LlmClient`, `resolveTools`, and existing `TDMCP_LLM_*`
  config wherever possible.
- Default to long polling for local use. Webhooks require an explicit opt-in
  because they imply public HTTPS infrastructure.
- Keep the bridge on loopback and require `TDMCP_BRIDGE_TOKEN` guidance for any
  real venue or untrusted network.
- Never log bot tokens, bridge tokens, LLM API keys, or full Authorization
  headers.

## Security gates

Implement these before enabling mutating tools:

1. Chat/user allowlist. Non-allowlisted messages must not reach the LLM.
2. Tool tier control. `safe` is default; `standard` and `creative` are explicit.
3. Confirmation for mutations. A Telegram approval must be tied to the exact
   pending action and expire or cancel cleanly.
4. Bounded execution. One active turn per chat unless the plan explicitly designs
   a queue.
5. `/cancel` and `/panic` behavior. Cancel should stop pending model/action work;
   panic should route to the existing tdmcp safety path when available or provide
   the precise manual fallback.

## Implementation workflow

### Telegram adapter

1. Create a small Bot API client with injectable `fetch`.
2. Support `getUpdates` with offset tracking and `sendMessage`.
3. Parse message text and commands:
   - `/status`
   - `/safe`
   - `/standard`
   - `/creative`
   - `/approve`
   - `/cancel`
   - `/panic`
   - plain prompt text
4. Keep all network calls bounded by timeout and retry policy.
5. Unit-test with mocked Bot API responses.

### Local LLM adapter

1. Convert each accepted Telegram prompt into the existing `ChatMessage[]` shape.
2. Call `runAgentTurn` with the selected tool tier.
3. Translate `AgentEvent` into Telegram-friendly progress messages.
4. For mutating tool calls, pause before execution unless the configured policy
   allows immediate execution for that chat/tier.
5. Store conversation history with a clear max length.

### TouchDesigner safety

1. Verify the bridge health path before claiming live control works.
2. Confirm node creation/layout behavior before remote creation is allowed.
3. Prefer existing high-level generators for complete looks.
4. Avoid raw Python tools in Telegram flows unless a later explicit design makes
   them safe and audited.

## Output notes

Each builder writes a note under `_workspace/telegram-copilot/`:

- files changed;
- config keys added;
- command behavior;
- tests run;
- live checks run or marked `UNVERIFIED`;
- security assumptions.

## Trigger validation

Should trigger:

- "implementar o bot Telegram do copilot local"
- "conectar Ollama no Telegram para controlar TouchDesigner"
- "adicionar comando tdmcp telegram"
- "fazer long polling do Telegram para o tdmcp"
- "corrigir confirmação do Telegram antes de mutar nodes"
- "atualizar o fluxo Telegram + Ollama"

Should not trigger:

- generic Telegram announcement copy;
- unrelated Gmail/Discord/WhatsApp bot work;
- a normal Layer 1 TouchDesigner tool with no chat transport;
- broad feature discovery or backlog campaign work;
- Connectors Directory submission work.
