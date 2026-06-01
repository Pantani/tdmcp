import {
  DEFAULT_LLM_TEMPERATURE,
  type LlmRuntimeConfig,
  type TdmcpConfig,
} from "../utils/config.js";

// ---------- Multimodal / completion shapes (shared between LlmClient + SamplingLlmClient) ----------

/** Image part for a multimodal user turn (base64 payload + mime type). */
export interface ImagePart {
  type: "image";
  /** Base64-encoded image bytes (no `data:` URI prefix). */
  data: string;
  /** e.g. "image/png", "image/jpeg". */
  mimeType: string;
}

/** Text part for a multimodal user turn. */
export interface TextPart {
  type: "text";
  text: string;
}

export type ContentPart = TextPart | ImagePart;

/** A multimodal message: string content stays valid; arrays carry images. */
export interface MultimodalMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

/** Options for {@link LlmClientLike.complete}. */
export interface CompleteOptions {
  /** System instruction. Overrides any leading `system` message in `messages`. */
  system?: string;
  /** Upper bound on sampled tokens. */
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  /** Cancel an in-flight completion. */
  signal?: AbortSignal;
  /** Per-call timeout in ms. */
  timeoutMs?: number;
}

/** Result of {@link LlmClientLike.complete}. */
export interface CompleteResult {
  /** Assembled assistant text. Empty string when the model returned non-text content. */
  text: string;
  /** Model id the backend reports, when known. */
  model?: string;
  /** `"endTurn" | "stopSequence" | "maxTokens" | string`, when known. */
  stopReason?: string;
}

/**
 * Structural capability set every LLM backend must satisfy: streaming chat for
 * the agentic copilot, plus a one-shot `complete()` for vision/captioning tools.
 */
export interface LlmClientLike {
  chatStream(
    messages: ChatMessage[],
    tools: OpenAITool[],
    opts?: StreamOptions,
  ): Promise<ChatMessage>;
  complete(messages: MultimodalMessage[], opts?: CompleteOptions): Promise<CompleteResult>;
}

/** A single chat message in the OpenAI chat-completions shape. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** Present on assistant turns that request tool execution. */
  tool_calls?: ToolCall[];
  /** Present on `tool` messages — links the result back to its request. */
  tool_call_id?: string;
  /** Tool name (echoed on `tool` messages for readability). */
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** OpenAI-style function tool advertised to the model. */
export interface OpenAITool {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

export type LlmConfig = Pick<TdmcpConfig, "llmBaseUrl" | "llmModel" | "llmApiKey"> &
  Partial<Pick<LlmRuntimeConfig, "llmTemperature">>;

/** A partial settings update from the UI (only provided fields change). */
export interface SettingsPatch {
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

/**
 * Merge a UI settings patch onto the current config. `model`/`baseUrl` change only
 * when non-empty; `apiKey` clears on empty string, sets on non-empty, and is left
 * untouched when omitted. Pure, so it is unit-tested directly.
 */
export function applySettings(current: LlmConfig, patch: SettingsPatch): LlmConfig {
  const next: LlmConfig = { ...current };
  if (patch.model?.trim()) next.llmModel = patch.model.trim();
  if (patch.baseUrl?.trim()) next.llmBaseUrl = patch.baseUrl.trim();
  if (patch.apiKey !== undefined) {
    const key = patch.apiKey.trim();
    next.llmApiKey = key.length > 0 ? key : undefined;
  }
  return next;
}

/** One line of Ollama's native `/api/pull` progress stream. */
export interface PullProgress {
  status: string;
  total?: number;
  completed?: number;
}

/** A streamed completion chunk in OpenAI's delta shape. */
interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
}

/**
 * Merges streamed deltas into one assistant message. Text tokens are forwarded to
 * `onToken` as they arrive; tool-call fragments are accumulated by index until the
 * stream ends. Kept pure and standalone so the merge logic is unit-testable without
 * a live endpoint (streaming tool-call reassembly is the easiest thing to get wrong).
 */
export class ChatAccumulator {
  content = "";
  private readonly calls: Array<{ id: string; name: string; args: string }> = [];

  constructor(private readonly onToken?: (token: string) => void) {}

  push(chunk: StreamChunk): void {
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return;
    if (typeof delta.content === "string" && delta.content.length > 0) {
      this.content += delta.content;
      this.onToken?.(delta.content);
    }
    for (const part of delta.tool_calls ?? []) {
      const idx = part.index ?? 0;
      let slot = this.calls[idx];
      if (!slot) {
        slot = { id: "", name: "", args: "" };
        this.calls[idx] = slot;
      }
      if (part.id) slot.id = part.id;
      if (part.function?.name) slot.name = part.function.name;
      if (part.function?.arguments) slot.args += part.function.arguments;
    }
  }

  finish(): ChatMessage {
    const toolCalls = this.calls
      .filter((c) => c.name.length > 0)
      .map((c) => ({
        id: c.id || `call_${c.name}`,
        type: "function" as const,
        function: { name: c.name, arguments: c.args },
      }));
    return {
      role: "assistant",
      content: this.content || null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
  }
}

export interface StreamOptions {
  signal?: AbortSignal;
  onToken?: (token: string) => void;
}

/** Read a byte stream line by line, trimming and skipping blanks. */
async function readLines(
  body: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onLine(line);
      nl = buf.indexOf("\n");
    }
  }
  const tail = buf.trim();
  if (tail) onLine(tail);
}

/**
 * Thin client for any OpenAI-compatible `/chat/completions` endpoint. The default
 * target is a local Ollama server, but the same code talks to LM Studio, a cloud
 * GPU, or a paid API — the only knobs are base URL, model and an optional token.
 */
export class LlmClient implements LlmClientLike {
  constructor(private readonly cfg: LlmConfig) {}

  /**
   * One-shot non-streaming completion against OpenAI-compatible /chat/completions.
   * Multimodal image parts are forwarded in OpenAI's `image_url` form (data URL).
   */
  async complete(
    messages: MultimodalMessage[],
    opts: CompleteOptions = {},
  ): Promise<CompleteResult> {
    const oaiMessages = messages.map((m) => {
      if (typeof m.content === "string") {
        if (m.role === "system" && opts.system !== undefined) {
          return { role: m.role, content: opts.system };
        }
        return { role: m.role, content: m.content };
      }
      const parts = m.content.map((p) =>
        p.type === "text"
          ? { type: "text" as const, text: p.text }
          : {
              type: "image_url" as const,
              image_url: { url: `data:${p.mimeType};base64,${p.data}` },
            },
      );
      return { role: m.role, content: parts };
    });
    // Honor an explicit system override even when no system message was given.
    const finalMessages =
      opts.system !== undefined && !messages.some((m) => m.role === "system")
        ? [{ role: "system" as const, content: opts.system }, ...oaiMessages]
        : oaiMessages;

    const body: Record<string, unknown> = {
      model: this.cfg.llmModel,
      messages: finalMessages,
      stream: false,
    };
    if (opts.maxTokens != null) body.max_tokens = opts.maxTokens;
    if (opts.temperature != null) body.temperature = opts.temperature;
    if (opts.stopSequences?.length) body.stop = opts.stopSequences;

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let signal = opts.signal;
    if (opts.timeoutMs != null) {
      const ctrl = new AbortController();
      timeoutHandle = setTimeout(() => ctrl.abort(), opts.timeoutMs);
      if (opts.signal) {
        if (opts.signal.aborted) ctrl.abort();
        else opts.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
      }
      signal = ctrl.signal;
    }
    try {
      const res = await fetch(`${this.cfg.llmBaseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`LLM endpoint returned HTTP ${res.status}: ${errBody.slice(0, 300)}`);
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        model?: string;
      };
      const choice = data.choices?.[0];
      return {
        text: choice?.message?.content ?? "",
        ...(data.model ? { model: data.model } : {}),
        ...(choice?.finish_reason ? { stopReason: choice.finish_reason } : {}),
      };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.llmApiKey) h.authorization = `Bearer ${this.cfg.llmApiKey}`;
    return h;
  }

  /** Ollama's native API lives at the root; derive it from the OpenAI base URL. */
  private nativeRoot(): string {
    return this.cfg.llmBaseUrl.replace(/\/v1\/?$/, "");
  }

  /** Reachability + model-availability probe used to show a friendly banner. */
  async health(): Promise<{ ok: boolean; modelReady: boolean; detail: string }> {
    try {
      const res = await fetch(`${this.cfg.llmBaseUrl}/models`, { headers: this.headers() });
      if (!res.ok)
        return { ok: false, modelReady: false, detail: `endpoint returned HTTP ${res.status}` };
      const data = (await res.json()) as { data?: Array<{ id: string }> };
      const models = (data.data ?? []).map((m) => m.id);
      const modelReady = models.includes(this.cfg.llmModel);
      const detail = modelReady
        ? `model '${this.cfg.llmModel}' is ready`
        : `model '${this.cfg.llmModel}' is not pulled (available: ${models.join(", ") || "none"})`;
      return { ok: true, modelReady, detail };
    } catch (err) {
      return { ok: false, modelReady: false, detail: (err as Error).message };
    }
  }

  /** List the model ids the endpoint currently has available (empty on any failure). */
  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.cfg.llmBaseUrl}/models`, { headers: this.headers() });
      if (!res.ok) return [];
      const data = (await res.json()) as { data?: Array<{ id: string }> };
      return (data.data ?? []).map((m) => m.id);
    } catch {
      return [];
    }
  }

  /** One streaming completion. Forwards text tokens via `onToken`; returns the assembled message. */
  async chatStream(
    messages: ChatMessage[],
    tools: OpenAITool[],
    opts: StreamOptions = {},
  ): Promise<ChatMessage> {
    const res = await fetch(`${this.cfg.llmBaseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: this.cfg.llmModel,
        messages,
        tools,
        tool_choice: "auto",
        temperature: this.cfg.llmTemperature ?? DEFAULT_LLM_TEMPERATURE,
        stream: true,
      }),
      signal: opts.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`LLM endpoint returned HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    if (!res.body) throw new Error("LLM endpoint returned no response body");

    const acc = new ChatAccumulator(opts.onToken);
    await readLines(res.body, (line) => {
      if (!line.startsWith("data:")) return;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        acc.push(JSON.parse(data) as StreamChunk);
      } catch {
        // ignore keep-alives / non-JSON lines
      }
    });
    return acc.finish();
  }

  /** Pull the configured model via Ollama's native API, forwarding progress lines. */
  async pull(onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<void> {
    const res = await fetch(`${this.nativeRoot()}/api/pull`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ name: this.cfg.llmModel, stream: true }),
      signal,
    });
    if (!res.ok)
      throw new Error(`pull failed (HTTP ${res.status}) — auto-pull needs a local Ollama server`);
    if (!res.body) return;
    await readLines(res.body, (line) => {
      try {
        onProgress(JSON.parse(line) as PullProgress);
      } catch {
        // ignore non-JSON lines
      }
    });
  }
}
