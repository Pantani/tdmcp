import {
  DEFAULT_IMAGE_GEN_TIMEOUT_MS,
  type GeneratedImage,
  type ImageGenRequest,
  type ImageProvider,
} from "./types.js";

/**
 * fal.ai image provider. Copies `LlmClient` discipline: `fetch` + a private
 * `headers()` + an `AbortController` timeout budget + `throw new Error("… HTTP
 * <status>: <body slice>")` on any non-2xx.
 *
 * Verified fal REST contract (fal.ai docs, 2026-07-07):
 *   - Sync endpoint:  POST https://fal.run/{model}         → returns the result JSON directly.
 *   - Queue endpoint: POST https://queue.fal.run/{model}   → { request_id, status_url, response_url, … };
 *                     poll GET {status_url} until status === "COMPLETED"; then GET {response_url}.
 *   - Auth header:    `Authorization: Key <FAL_KEY>`       (NOT Bearer).
 *   - Result JSON:    { images: [{ url, width, height, content_type }], seed?, … }.
 *     fal returns image URLs, NOT raw bytes → a second `fetch(url)` downloads the bytes.
 *
 * Two code paths under one timeout budget:
 *   - Fast path (Flux-schnell): the synchronous `fal.run` endpoint returns the
 *     result in one round-trip — no polling latency.
 *   - Slow path (WAN 2.5 and other queue models): the `queue.fal.run` submit →
 *     poll → fetch flow, so a ~1–2 min render never blocks on a single hung request
 *     and stays bounded by the same AbortController.
 */

/** Default fal model slug (fast/cheap preview). Kept as the single source of truth. */
export const DEFAULT_FAL_MODEL = "fal-ai/flux/schnell";

const FAL_SYNC_BASE = "https://fal.run";
const FAL_QUEUE_BASE = "https://queue.fal.run";
const QUEUE_POLL_INTERVAL_MS = 1_000;

/**
 * Model-slug markers that force the async queue path (a single blocking request
 * would exceed proxy timeouts). WAN 2.5 is a slow queue model.
 * UNVERIFIED-live: the exact WAN 2.5 slug is not yet confirmed against a live key;
 * the marker match ("wan") is a best-effort routing heuristic until it is.
 */
const QUEUE_MODEL_MARKERS = ["wan"];

interface FalImageResult {
  images?: Array<{ url?: string; content_type?: string; width?: number; height?: number }>;
  seed?: number;
}

interface FalQueueSubmit {
  status_url?: string;
  response_url?: string;
  request_id?: string;
}

interface FalQueueStatus {
  status?: string;
}

export class FalProvider implements ImageProvider {
  readonly id = "fal";
  readonly defaultModel: string;

  constructor(
    private readonly falKey: string,
    cfg: { defaultModel: string },
  ) {
    this.defaultModel = cfg.defaultModel;
  }

  async generate(req: ImageGenRequest, signal?: AbortSignal): Promise<GeneratedImage> {
    const model = req.model ?? this.defaultModel;
    const timeoutMs = req.timeoutMs ?? DEFAULT_IMAGE_GEN_TIMEOUT_MS;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    try {
      const result = this.usesQueue(model)
        ? await this.runQueue(model, req, controller.signal)
        : await this.runSync(model, req, controller.signal);
      return await this.download(result, model, req, controller.signal);
    } finally {
      clearTimeout(timeout);
    }
  }

  private usesQueue(model: string): boolean {
    const slug = model.toLowerCase();
    return QUEUE_MODEL_MARKERS.some((marker) => slug.includes(marker));
  }

  private headers(): Record<string, string> {
    return { "content-type": "application/json", authorization: `Key ${this.falKey}` };
  }

  /** Map an {@link ImageGenRequest} onto fal's model input JSON. */
  private buildInput(req: ImageGenRequest): Record<string, unknown> {
    const input: Record<string, unknown> = {
      prompt: req.prompt,
      image_size: { width: req.width ?? 1024, height: req.height ?? 1024 },
      num_images: 1,
    };
    if (req.negativePrompt) input.negative_prompt = req.negativePrompt;
    if (req.seed !== undefined) input.seed = req.seed;
    return input;
  }

  /** Fast path: synchronous `fal.run` — one round-trip returns the result JSON. */
  private async runSync(
    model: string,
    req: ImageGenRequest,
    signal: AbortSignal,
  ): Promise<FalImageResult> {
    const res = await fetch(`${FAL_SYNC_BASE}/${model}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.buildInput(req)),
      signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`fal endpoint returned HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    return (await res.json()) as FalImageResult;
  }

  /** Slow path: `queue.fal.run` submit → poll status → fetch result, bounded by `signal`. */
  private async runQueue(
    model: string,
    req: ImageGenRequest,
    signal: AbortSignal,
  ): Promise<FalImageResult> {
    const submitRes = await fetch(`${FAL_QUEUE_BASE}/${model}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.buildInput(req)),
      signal,
    });
    if (!submitRes.ok) {
      const body = await submitRes.text();
      throw new Error(`fal queue submit returned HTTP ${submitRes.status}: ${body.slice(0, 300)}`);
    }
    const submit = (await submitRes.json()) as FalQueueSubmit;
    const statusUrl = submit.status_url;
    const responseUrl = submit.response_url;
    if (!statusUrl || !responseUrl) {
      throw new Error("fal queue submit response missing status_url/response_url");
    }

    for (;;) {
      const statusRes = await fetch(statusUrl, { headers: this.headers(), signal });
      if (!statusRes.ok) {
        const body = await statusRes.text();
        throw new Error(
          `fal queue status returned HTTP ${statusRes.status}: ${body.slice(0, 300)}`,
        );
      }
      const status = (await statusRes.json()) as FalQueueStatus;
      if (status.status === "COMPLETED") break;
      await this.sleep(QUEUE_POLL_INTERVAL_MS, signal);
    }

    const resultRes = await fetch(responseUrl, { headers: this.headers(), signal });
    if (!resultRes.ok) {
      const body = await resultRes.text();
      throw new Error(`fal queue result returned HTTP ${resultRes.status}: ${body.slice(0, 300)}`);
    }
    return (await resultRes.json()) as FalImageResult;
  }

  /** Download the first result URL into bytes (fal returns URLs, not raw bytes). */
  private async download(
    result: FalImageResult,
    model: string,
    req: ImageGenRequest,
    signal: AbortSignal,
  ): Promise<GeneratedImage> {
    const first = result.images?.[0];
    if (!first?.url) throw new Error("fal response contained no image URL");
    const imgRes = await fetch(first.url, { signal });
    if (!imgRes.ok) {
      throw new Error(`fal image download returned HTTP ${imgRes.status}`);
    }
    const bytes = new Uint8Array(await imgRes.arrayBuffer());
    const seed = result.seed ?? req.seed;
    return {
      bytes,
      mimeType: first.content_type ?? "image/png",
      provider: this.id,
      model,
      ...(seed !== undefined ? { seed } : {}),
    };
  }

  /** Abortable delay — rejects immediately if the shared signal fires while sleeping. */
  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
