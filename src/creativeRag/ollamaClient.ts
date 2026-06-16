/**
 * Creative RAG — Ollama embeddings client.
 *
 * Thin HTTP client over Ollama's `POST /api/embed`. Mirrors the TouchDesigner
 * client's shape: a `fetchImpl` injection point (so msw can intercept), an
 * `AbortController` timeout, and typed failures via {@link OllamaError}. Accepts
 * both response shapes Ollama has shipped — the current `{ embeddings: [...] }`
 * and the legacy single `{ embedding: [...] }` — and always returns `number[][]`.
 */

import { z } from "zod";
import { OllamaApiError, OllamaConnectionError, OllamaTimeoutError } from "./ollamaErrors.js";
import type { OllamaEmbeddingsClient as OllamaEmbeddingsClientContract } from "./types.js";

export interface OllamaClientOptions {
  baseUrl: string;
  /** Embeddings can be slower than TD calls; default 30000ms. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Current `/api/embed` shape: a batch of vectors. */
const EmbedBatchSchema = z.object({
  embeddings: z.array(z.array(z.number())),
});

/** Legacy single-vector shape. */
const EmbedSingleSchema = z.object({
  embedding: z.array(z.number()),
});

const EmbedResponseSchema = z.union([EmbedBatchSchema, EmbedSingleSchema]);

export class OllamaEmbeddingsClient implements OllamaEmbeddingsClientContract {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OllamaClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** POST /api/embed. Returns one vector per input, in order. */
  async embed(inputs: string[], model: string): Promise<number[][]> {
    const url = `${this.baseUrl}/api/embed`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: inputs }),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new OllamaTimeoutError(
          `Ollama embeddings request timed out after ${this.timeoutMs}ms.`,
          { cause: err },
        );
      }
      throw new OllamaConnectionError(
        `Cannot reach Ollama at ${this.baseUrl}. Make sure Ollama is running and the model "${model}" is pulled.`,
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let json: unknown;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }

    if (!response.ok) {
      throw new OllamaApiError(`Ollama returned HTTP ${response.status} for POST /api/embed.`, {
        status: response.status,
      });
    }

    const parsed = EmbedResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new OllamaApiError(
        `Malformed response from Ollama for POST /api/embed: ${parsed.error.message}`,
        { status: response.status },
      );
    }

    return "embeddings" in parsed.data ? parsed.data.embeddings : [parsed.data.embedding];
  }
}
