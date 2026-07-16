import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { TdmcpConfig } from "../utils/config.js";
import type {
  ChatMessage,
  CompleteOptions,
  CompleteResult,
  MultimodalMessage,
  OpenAITool,
  StreamOptions,
} from "./client.js";
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

/**
 * Wrap {@link resolveLlmClient} in a lazy LlmClientLike whose backend is picked
 * on first call. `createTdmcpServer()` runs before `server.connect()` and before
 * the MCP `initialize` handshake, so `getClientCapabilities()` is empty at
 * wiring time. Resolving eagerly would always fall through to `LlmClient` and
 * miss sampling-capable clients (Claude Desktop, etc.). Calling resolution at
 * first tool-invocation guarantees `getClientCapabilities()` is populated.
 */
export function createLazyLlmClient(
  config: TdmcpConfig,
  server: Pick<Server, "getClientCapabilities" | "createMessage"> | undefined,
): LlmClientLike {
  let cached: LlmClientLike | null = null;
  const get = (): LlmClientLike => {
    if (cached === null) cached = resolveLlmClient(config, server);
    return cached;
  };
  return {
    describe() {
      return (
        get().describe?.() ?? {
          transport: "unknown" as const,
          locality: "unknown" as const,
          calibration: "not_checked" as const,
        }
      );
    },
    chatStream(messages: ChatMessage[], tools: OpenAITool[], opts?: StreamOptions) {
      return get().chatStream(messages, tools, opts);
    },
    complete(messages: MultimodalMessage[], opts?: CompleteOptions): Promise<CompleteResult> {
      return get().complete(messages, opts);
    },
  };
}
