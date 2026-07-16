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

export const LLM_SYSTEM_OPTION = "system" as const;
export const COMPLETE_RESPONSE_BYTES_MAX = 64 * 1024 * 1024;
export const LLM_RESPONSE_TOO_LARGE_CODE = "LLM_RESPONSE_TOO_LARGE" as const;
export const LLM_INVALID_COMPLETE_OPTIONS_CODE = "LLM_INVALID_COMPLETE_OPTIONS" as const;

export class LlmResponseTooLargeError extends Error {
  readonly code = LLM_RESPONSE_TOO_LARGE_CODE;

  constructor(readonly maxResponseBytes: number) {
    super(`LLM response exceeded the configured ${maxResponseBytes}-byte limit`);
    this.name = "LlmResponseTooLargeError";
  }
}

export class InvalidCompleteOptionsError extends TypeError {
  readonly code = LLM_INVALID_COMPLETE_OPTIONS_CODE;

  constructor(message: string) {
    super(message);
    this.name = "InvalidCompleteOptionsError";
  }
}

export function validatedMaxResponseBytes(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > COMPLETE_RESPONSE_BYTES_MAX
  ) {
    throw new InvalidCompleteOptionsError(
      `maxResponseBytes must be a safe integer between 1 and ${COMPLETE_RESPONSE_BYTES_MAX}`,
    );
  }
  return value;
}

export function assertCompletionResponseSize(text: string, maxResponseBytes?: number): void {
  const maximum = validatedMaxResponseBytes(maxResponseBytes);
  if (maximum !== undefined && Buffer.byteLength(text, "utf8") > maximum) {
    throw new LlmResponseTooLargeError(maximum);
  }
}

export function isLlmResponseTooLargeError(error: unknown): error is LlmResponseTooLargeError {
  return (
    error instanceof LlmResponseTooLargeError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === LLM_RESPONSE_TOO_LARGE_CODE)
  );
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
  /**
   * Optional hard UTF-8 byte ceiling for one completion response. HTTP clients
   * stop reading as soon as the streamed body crosses it. Omitted preserves the
   * legacy unbounded transport behavior for existing consumers.
   */
  maxResponseBytes?: number;
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

export interface LlmRuntimeDescriptor {
  transport: "openai_compatible" | "mcp_sampling" | "unknown";
  locality: "loopback" | "remote" | "client_managed" | "unknown";
  endpointOrigin?: string;
  configuredModel?: string;
  calibration: "not_checked";
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
  /** Redacted egress metadata. Never includes credentials, paths, prompts or image bytes. */
  describe?(): LlmRuntimeDescriptor;
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

async function rejectOversizedDeclaredResponse(
  response: Response,
  maxResponseBytes: number,
): Promise<void> {
  const declaredLength = response.headers.get("content-length");
  if (!declaredLength || !/^\d+$/u.test(declaredLength)) return;
  const bytes = Number(declaredLength);
  if (!Number.isSafeInteger(bytes) || bytes <= maxResponseBytes) return;
  await response.body?.cancel().catch(() => undefined);
  throw new LlmResponseTooLargeError(maxResponseBytes);
}

async function readBoundedResponseText(
  response: Response,
  maxResponseBytes: number,
): Promise<string> {
  await rejectOversizedDeclaredResponse(response, maxResponseBytes);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytesRead = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxResponseBytes) {
        const error = new LlmResponseTooLargeError(maxResponseBytes);
        await reader.cancel(error).catch(() => undefined);
        throw error;
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    reader.releaseLock();
  }
}

type OpenAiCompletionPayload = {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  model?: string;
};

function toOpenAiMessage(
  message: MultimodalMessage,
  systemOverride?: string,
): Record<string, unknown> {
  if (typeof message.content === "string") {
    const content =
      message.role === "system" && systemOverride !== undefined ? systemOverride : message.content;
    return { role: message.role, content };
  }
  const content = message.content.map((part) =>
    part.type === "text"
      ? { type: "text" as const, text: part.text }
      : {
          type: "image_url" as const,
          image_url: { url: `data:${part.mimeType};base64,${part.data}` },
        },
  );
  return { role: message.role, content };
}

function completionMessages(
  messages: MultimodalMessage[],
  systemOverride?: string,
): Array<Record<string, unknown>> {
  const mapped = messages.map((message) => toOpenAiMessage(message, systemOverride));
  if (systemOverride === undefined || messages.some((message) => message.role === "system")) {
    return mapped;
  }
  return [{ role: "system", content: systemOverride }, ...mapped];
}

function completionRequestBody(
  model: string,
  messages: MultimodalMessage[],
  opts: CompleteOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: completionMessages(messages, opts.system),
    stream: false,
  };
  if (opts.maxTokens != null) body.max_tokens = opts.maxTokens;
  if (opts.temperature != null) body.temperature = opts.temperature;
  if (opts.stopSequences?.length) body.stop = opts.stopSequences;
  return body;
}

interface CompletionAbort {
  signal?: AbortSignal;
  dispose: () => void;
}

function completionAbort(opts: CompleteOptions): CompletionAbort {
  if (opts.timeoutMs == null) return { signal: opts.signal, dispose: () => undefined };
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, opts.timeoutMs);
  if (opts.signal?.aborted) abort();
  else opts.signal?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
    },
  };
}

async function responseText(response: Response, maxResponseBytes?: number): Promise<string> {
  return maxResponseBytes === undefined
    ? response.text()
    : readBoundedResponseText(response, maxResponseBytes);
}

async function completionPayload(
  response: Response,
  maxResponseBytes?: number,
): Promise<OpenAiCompletionPayload> {
  if (!response.ok) {
    const body = await responseText(response, maxResponseBytes);
    throw new Error(`LLM endpoint returned HTTP ${response.status}: ${body.slice(0, 300)}`);
  }
  if (maxResponseBytes === undefined) {
    return (await response.json()) as OpenAiCompletionPayload;
  }
  return JSON.parse(
    await readBoundedResponseText(response, maxResponseBytes),
  ) as OpenAiCompletionPayload;
}

function completionResult(payload: OpenAiCompletionPayload): CompleteResult {
  const choice = payload.choices?.[0];
  return {
    text: choice?.message?.content ?? "",
    ...(payload.model ? { model: payload.model } : {}),
    ...(choice?.finish_reason ? { stopReason: choice.finish_reason } : {}),
  };
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

  describe(): LlmRuntimeDescriptor {
    try {
      const endpoint = new URL(this.cfg.llmBaseUrl);
      const hostname = endpoint.hostname.toLowerCase();
      const loopback = hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
      return {
        transport: "openai_compatible",
        locality: loopback ? "loopback" : "remote",
        endpointOrigin: endpoint.origin,
        configuredModel: this.cfg.llmModel,
        calibration: "not_checked",
      };
    } catch {
      return {
        transport: "openai_compatible",
        locality: "unknown",
        configuredModel: this.cfg.llmModel,
        calibration: "not_checked",
      };
    }
  }

  /**
   * One-shot non-streaming completion against OpenAI-compatible /chat/completions.
   * Multimodal image parts are forwarded in OpenAI's `image_url` form (data URL).
   */
  async complete(
    messages: MultimodalMessage[],
    opts: CompleteOptions = {},
  ): Promise<CompleteResult> {
    const maxResponseBytes = validatedMaxResponseBytes(opts.maxResponseBytes);
    const body = completionRequestBody(this.cfg.llmModel, messages, opts);
    const abort = completionAbort(opts);
    try {
      const res = await fetch(`${this.cfg.llmBaseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      return completionResult(await completionPayload(res, maxResponseBytes));
    } finally {
      abort.dispose();
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
