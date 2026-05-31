import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type {
  ChatMessage,
  CompleteOptions,
  CompleteResult,
  ContentPart,
  ImagePart,
  LlmClientLike,
  MultimodalMessage,
  OpenAITool,
  StreamOptions,
  TextPart,
} from "./client.js";

// Re-export the shared shapes so existing importers of samplingClient keep working.
export type {
  ChatMessage,
  CompleteOptions,
  CompleteResult,
  ContentPart,
  ImagePart,
  LlmClientLike,
  MultimodalMessage,
  OpenAITool,
  StreamOptions,
  TextPart,
};

export const DEFAULT_MAX_TOKENS = 2048;

/** True when the connected MCP client advertised the `sampling` capability. */
export function clientSupportsSampling(server: Pick<Server, "getClientCapabilities">): boolean {
  return server.getClientCapabilities()?.sampling != null;
}

/** Pick a system prompt: explicit override wins, else first `system` message's text. */
export function pickSystem(
  messages: MultimodalMessage[],
  override: string | undefined,
): string | undefined {
  if (override !== undefined) return override;
  for (const m of messages) {
    if (m.role !== "system") continue;
    if (typeof m.content === "string") return m.content;
    const texts = m.content.filter((p): p is TextPart => p.type === "text").map((p) => p.text);
    if (texts.length > 0) return texts.join("\n");
  }
  return undefined;
}

/** Map our `ContentPart` to the SDK's `TextContent`/`ImageContent` shape. */
function mapPart(part: ContentPart): { type: "text"; text: string } | ImagePart {
  if (part.type === "text") return { type: "text", text: part.text };
  return { type: "image", data: part.data, mimeType: part.mimeType };
}

/**
 * Convert our `MultimodalMessage[]` to the SDK `SamplingMessage[]`: drop `system`
 * messages (carried via `systemPrompt`), wrap string content as a single TextContent,
 * and pass through image parts 1:1.
 */
export function toSamplingMessages(
  messages: MultimodalMessage[],
): Array<{ role: "user" | "assistant"; content: unknown }> {
  const out: Array<{ role: "user" | "assistant"; content: unknown }> = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: { type: "text", text: m.content } });
    } else {
      const parts = m.content.map(mapPart);
      // SDK accepts either a single block or an array; we always send an array
      // when caller used the array form so images round-trip in order.
      out.push({ role: m.role, content: parts });
    }
  }
  return out;
}

/** Adapt OpenAI-style `ChatMessage[]` to `MultimodalMessage[]` (ignores `tool` turns). */
export function toMultimodal(messages: ChatMessage[]): MultimodalMessage[] {
  const out: MultimodalMessage[] = [];
  for (const m of messages) {
    if (m.role === "tool") continue;
    out.push({ role: m.role, content: m.content ?? "" });
  }
  return out;
}

/**
 * An {@link LlmClientLike} backed by MCP **sampling** — heavy reasoning runs on the
 * CONNECTED client's model (Claude Desktop, etc.), so the artist needs no local LLM.
 *
 * Construction is eager-safe: nothing touches the server until `complete()` /
 * `chatStream()` is actually called, which is well after the MCP `initialize`
 * handshake (capability gating happens at resolve time).
 */
export class SamplingLlmClient implements LlmClientLike {
  constructor(private readonly server: Pick<Server, "createMessage">) {}

  async complete(
    messages: MultimodalMessage[],
    opts: CompleteOptions = {},
  ): Promise<CompleteResult> {
    const system = pickSystem(messages, opts.system);
    const samplingMessages = toSamplingMessages(messages);
    const params: Record<string, unknown> = {
      messages: samplingMessages,
      maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    };
    if (system !== undefined) params.systemPrompt = system;
    if (opts.temperature != null) params.temperature = opts.temperature;
    if (opts.stopSequences) params.stopSequences = opts.stopSequences;

    const requestOptions: Record<string, unknown> = {};
    if (opts.signal) requestOptions.signal = opts.signal;
    if (opts.timeoutMs != null) requestOptions.timeout = opts.timeoutMs;

    // The no-tools overload returns a single-content-block result. Cast through
    // unknown so a bundled SDK type drift doesn't break the build; runtime shape
    // is asserted defensively below.
    const result = (await (
      this.server.createMessage as (
        p: unknown,
        o?: unknown,
      ) => Promise<{
        role: string;
        content: { type: string; text?: string };
        model?: string;
        stopReason?: string;
      }>
    )(params, requestOptions)) as {
      role: string;
      content: { type: string; text?: string };
      model?: string;
      stopReason?: string;
    };

    const text =
      result.content.type === "text" && typeof result.content.text === "string"
        ? result.content.text
        : "";
    return {
      text,
      ...(result.model ? { model: result.model } : {}),
      ...(typeof result.stopReason === "string" ? { stopReason: result.stopReason } : {}),
    };
  }

  /**
   * Sampling has no token stream in this SDK path; emulate `chatStream` by running
   * `complete` and emitting the whole text once. Tool-calling via sampling is not
   * supported here — the agentic copilot keeps using the local streaming client.
   */
  async chatStream(
    messages: ChatMessage[],
    _tools: OpenAITool[],
    opts: StreamOptions = {},
  ): Promise<ChatMessage> {
    const res = await this.complete(toMultimodal(messages), { signal: opts.signal });
    if (res.text && opts.onToken) opts.onToken(res.text);
    return { role: "assistant", content: res.text || null };
  }
}
