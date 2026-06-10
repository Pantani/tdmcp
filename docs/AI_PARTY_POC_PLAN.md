# Live Nervous System / AI Party Control POC Plan

## Goal

Build a local, demo-ready POC that lets an operator control an event experience through a safe AI show-director layer:

- Dashboard and backend run from one local command.
- Ollama interprets operator or Telegram text into structured `ShowIntent` JSON.
- A local policy engine is the final safety gate.
- Approval-gated effects are queued for a human operator.
- TouchDesigner dispatch is optional; dry-run simulation is the default.
- Real hardware remains disabled unless explicit environment gates are enabled.

## Existing Repo Surface To Reuse

- `src/automation/showDirectorSchema.ts`: existing `ShowIntentSchema`, `EffectPolicySchema`, and dry-run policy primitives.
- `src/automation/showDirectorRuntime.ts`: existing dry-run approvals and audit state.
- `src/automation/aiPartyPoc.ts`: existing producer rehearsal runner.
- `src/automation/aiPartyGateway.ts` and `src/automation/telegramShowGateway.ts`: existing Telegram/Hermes dry-run gateway.
- `src/llm/client.ts` and `src/llm/server.ts`: existing local LLM conventions and loopback UI guard style.
- `src/td-client/touchDesignerClient.ts`: existing bridge client for `/api/info`, `/api/exec`, `/api/preview`, and parameter updates.
- `tests/helpers/tdMock.ts`: existing MSW bridge mock for offline/online bridge tests.

## Implementation Shape

### Core Modules

- Add an `src/automation/aiPartyLive/` feature folder for the live POC orchestration.
- Keep the existing dry-run show-director modules intact and extend schemas only where compatibility is safe.
- Add a typed cue catalog with safe/preapproved and approval-gated cues.
- Add a POC policy adapter whose public decision names are `allow`, `approval_required`, and `block`.
- Add an in-memory approval queue with JSONL event persistence.
- Add a central `ShowState` store that publishes state, event, and approval updates.

### LLM Flow

- Use Ollama's local HTTP API at `OLLAMA_BASE_URL`.
- Send a low-temperature `/api/chat` request with `stream: false` and JSON/structured `format`.
- Validate only the parsed JSON envelope with Zod.
- Attempt exactly one repair pass if JSON parsing or schema validation fails.
- If Ollama is unavailable, model is missing, or repair fails, emit a safe `blocked_request` or deterministic fallback for demo examples and expose a dashboard warning.
- Never dispatch raw model text.

### Dispatch Flow

- Convert allowed policy outputs into abstract dispatch actions.
- Dispatch physical effects as simulation by default.
- Only allow live hardware dispatch when `HARDWARE_ENABLED=true`, `DMX_LIVE_ENABLED=true`, policy allows, and a human approved the item.
- Use structured TouchDesigner bridge calls for show-time updates when available.
- Use raw bridge Python only in the TD demo-network builder.

### Backend And Dashboard

- Serve a loopback-only HTTP backend plus a single-page dashboard.
- Add endpoints for health, state, events, cues, approvals, operator text, intent evaluation, approval approve/reject, cue trigger, panic, TD info/preview/build, Telegram test, and LLM test.
- Add a small WebSocket broadcaster using Node's native `upgrade` support so the dashboard updates without refresh.
- Keep the UI dependency-free to avoid adding a React/Vite app shell to this package.

### Telegram

- Reuse the existing Telegram command ideas, but route live POC messages through the same live service as dashboard commands.
- Default Telegram polling to off.
- Require `TELEGRAM_ALLOWED_CHAT_IDS` when polling is enabled.
- Support `/start`, `/help`, `/status`, `/cues`, `/cue`, `/mood`, `/fog`, `/approve`, `/reject`, `/panic`, and `/demo`.

### TouchDesigner Builder

- Add `ai-party:td-build` script and matching service method.
- Create or update `/project1/ai_party_poc`.
- Every created operator gets deterministic `nodeX`/`nodeY` coordinates immediately.
- Include control panel parameters, a visual TOP chain, simulated DMX DAT/CHOP, disabled DMX placeholder, and `preview_out`.

## Tests

Add focused tests for:

- POC schema accepts the requested intent envelope and rejects unknown/raw shapes.
- Safe cue is allowed and unknown cue is blocked.
- Fog queues approval; over-limit fog and strobe are blocked.
- Blackout, raw DMX, raw Python, prompt injection, laser, moving head, PA/mixer actions are blocked.
- Approval approve/reject/expire behavior and JSONL event persistence.
- Ollama invalid JSON repair and unavailable-model graceful fallback.
- Telegram command parsing and allowlist behavior.
- Backend health/state/operator endpoints.
- TD bridge offline does not crash.
- TD builder script uses deterministic non-stacked coordinates.
- Hardware dispatch remains simulated unless all live gates are true and an operator approved.

## CLI And Scripts

Add package scripts:

- `npm run ai-party:dev`: start backend and dashboard.
- `npm run ai-party:dry`: run deterministic seven-moment dry-run.
- `npm run ai-party:td-build`: build/update the TD demo network.
- `npm run ai-party:test`: run focused POC tests.
- `npm run ai-party:telegram`: start backend with Telegram polling enabled.

## Done Criteria

- The backend/dashboard starts locally from one command.
- The dashboard shows status, command input, cue deck, approvals, state, TD preview area, safety panel, and event log.
- Premium tropical text produces an allowed intent and simulated/TD cue update.
- Short fog text produces an approval card.
- Approving the fog card simulates by default.
- Blackout/max-strobe text is blocked clearly.
- Telegram status/free text work when configured.
- TD bridge offline remains a visible warning, not a crash.
- If TD bridge is available, the builder creates `/project1/ai_party_poc`.
- Event JSONL records important steps.
- Focused tests and build/typecheck pass or any remaining blocker is reported explicitly.

