import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { TdmcpConfig } from "../utils/config.js";
import { LlmClient } from "./client.js";
import { clientSupportsSampling, type LlmClientLike, SamplingLlmClient } from "./samplingClient.js";

/**
 * Hard default for `llmBaseUrl` in `src/utils/config.ts`. Duplicated here so this
 * resolver stays builder-owned (no shared-file edit); the integrator may replace
 * the heuristic with an explicit `config.llmExplicit` boolean later.
 */
export const DEFAULT_LLM_BASE_URL = "http://127.0.0.1:11434/v1";

/**
 * True when the user explicitly opted into a local LLM endpoint — either by
 * pointing `TDMCP_LLM_BASE_URL` somewhere other than the Ollama default, or by
 * setting an API key (paid/cloud endpoints).
 */
export function isLocalEndpointConfigured(
  config: Pick<TdmcpConfig, "llmBaseUrl" | "llmApiKey">,
): boolean {
  return config.llmBaseUrl !== DEFAULT_LLM_BASE_URL || config.llmApiKey != null;
}

/**
 * Pick the LLM backend for a tool call:
 *  1. sampling — when no local endpoint is explicitly configured AND the
 *     connected client advertises sampling. Zero local setup; runs on the
 *     connected client's model (e.g. Claude Desktop).
 *  2. local OpenAI/Ollama `LlmClient` — when a local endpoint is configured,
 *     OR sampling is unavailable (so the existing `tdmcp chat` keeps working).
 *
 * Returns `undefined` only when the caller passes a falsy config; today both
 * branches return a client, so consumers can treat `ctx.llm` as best-effort
 * and always provide a deterministic fallback per the graceful-degradation spec.
 */
export function resolveLlmClient(
  config: TdmcpConfig,
  server: Pick<Server, "getClientCapabilities" | "createMessage"> | undefined,
): LlmClientLike {
  const localConfigured = isLocalEndpointConfigured(config);
  if (!localConfigured && server && clientSupportsSampling(server)) {
    return new SamplingLlmClient(server);
  }
  return new LlmClient(config);
}
