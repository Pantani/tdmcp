# AI Party Ollama Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the AI Party POC easy to run with a local Ollama ShowIntent model while keeping policy enforcement outside the model.

**Architecture:** Add an isolated ShowIntent Ollama adapter that converts operator text into a Hermes-style candidate, then feed it through the existing `runAiPartyGateway` path. Add a setup helper that checks/starts Ollama, inspects the configured model, and reports the exact commands needed to pull or package it. The existing deterministic fallback remains available and all LLM output is still schema- and policy-checked.

**Tech Stack:** TypeScript, Node fetch/spawn, existing `ShowIntentSchema`, `AiPartyGatewaySchema`, Ollama `/api/chat`, existing Vitest harness.

---

### Task 1: ShowIntent Ollama Adapter

**Files:**
- Create: `src/automation/showIntentOllama.ts`
- Test: `tests/unit/showIntentOllama.test.ts`

- [x] Write a failing test proving valid Ollama JSON becomes a Hermes candidate.
- [x] Write a failing test proving malformed/unsafe LLM JSON fails closed.
- [x] Implement `runShowIntentOllama(input, deps)` with injected fetch for tests.
- [x] Verify with `npm test -- tests/unit/showIntentOllama.test.ts`.

### Task 2: CLI Integration

**Files:**
- Modify: `src/cli/agent.ts`
- Test: `tests/unit/aiPartyGateway.test.ts`

- [x] Write a failing test for `tdmcp-agent ai-party --llm`.
- [x] Write a failing test for `tdmcp-agent ai-party llm-setup`.
- [x] Add `--llm` parsing for the `ai-party` command only.
- [x] Route `--llm` through the Ollama adapter, then through `runAiPartyGateway`.
- [x] Add `llm-setup` as a dry-run setup/status command.
- [x] Verify with focused CLI tests.

### Task 3: Docs And Commands

**Files:**
- Modify: `docs/reference/cli.md`
- Modify: `docs/reference/environment.md`
- Optional: `docs/AI_PARTY_LLM_TRAINING_PLAN.md`

- [x] Document `tdmcp-agent ai-party --llm`.
- [x] Document `tdmcp-agent ai-party llm-setup`.
- [x] Keep clear that `tdmcp chat` stays general-purpose and this model is ShowIntent-only.

### Task 4: Verification

**Commands:**
- [x] `npm run typecheck`
- [x] `npm run lint`
- [x] `npm test -- tests/unit/showIntentOllama.test.ts tests/unit/aiPartyGateway.test.ts tests/unit/showIntentTraining.test.ts`
- [x] `npm test`
- [x] `npm run docs:build`
