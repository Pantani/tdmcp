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
import { embedInBatches } from "./embedBatch.js";
import { OllamaApiError, OllamaConnectionError, OllamaTimeoutError } from "./ollamaErrors.js";
import type { OllamaEmbeddingsClient as OllamaEmbeddingsClientContract } from "./types.js";

export interface OllamaClientOptions {
  baseUrl: string;
  /** Embeddings can be slower than TD calls; default 30000ms. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Inputs sent per POST /api/embed; larger inputs are split into batches. Default 64. */
  batchSize?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_BATCH_SIZE = 64;

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
  private readonly batchSize: number;

  constructor(options: OllamaClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  /**
   * POST /api/embed, batched. Returns one vector per input, in order. Splits
   * `inputs` into `batchSize` chunks; the per-input cardinality guard fires per
   * chunk. Empty input ⇒ `[]` with zero requests.
   */
  async embed(inputs: string[], model: string): Promise<number[][]> {
    return embedInBatches(inputs, this.batchSize, (part) => this.embedChunk(part, model));
  }

  /** Single POST /api/embed for one chunk; enforces one vector per input. */
  private async embedChunk(inputs: string[], model: string): Promise<number[][]> {
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

    const vectors = "embeddings" in parsed.data ? parsed.data.embeddings : [parsed.data.embedding];

    // Enforce the embed() contract: one vector per input, in order. A short response
    // would otherwise cause silent partial indexing downstream (undefined vectors get
    // skipped), so fail fast instead.
    if (vectors.length !== inputs.length) {
      throw new OllamaApiError(
        `Ollama returned ${vectors.length} embeddings for ${inputs.length} inputs.`,
        { status: response.status },
      );
    }

    return vectors;
  }
}
