import { readFile } from "node:fs/promises";
import {
  DEFAULT_VIDEO_GEN_TIMEOUT_MS,
  type VideoGenProvider,
  type VideoGenRequest,
  type VideoGenResult,
} from "./types.js";

/**
 * fal.ai video provider. Forks the imageGen `FalProvider` queue path: `fetch` +
 * a private `headers()` + an `AbortController` timeout budget + `throw new
 * Error("… HTTP <status>: <body slice>")` on any non-2xx.
 *
 * Video is ALWAYS a queue model, so `generate()` always takes the queue path
 * (submit → poll `status_url` until COMPLETED → GET `response_url`) — no sync
 * branch. Auth header is `Authorization: Key <FAL_KEY>` (NOT Bearer).
 *
 * UNVERIFIED — probe live: the exact model slugs (image-to-video vs
 * text-to-video), the storage-upload endpoint + response shape, the input keys
 * (`num_frames` vs `duration`, resolution format) and the result shape
 * (`video.url` vs `videos[0].url`) are provider-doc-driven. The code below
 * handles both result shapes defensively and marks each assumption.
 */

/** Default friendly model key. */
export const DEFAULT_FAL_VIDEO_MODEL = "ltx-video";

const FAL_QUEUE_BASE = "https://queue.fal.run";
/** UNVERIFIED — probe live: fal storage upload endpoint for the init image. */
const FAL_STORAGE_URL = "https://rest.alpha.fal.ai/storage/upload";
const QUEUE_POLL_INTERVAL_MS = 1_000;

/** Friendly model key → fal slug, resolved by init-image presence. UNVERIFIED — probe live. */
const MODEL_SLUGS: Record<string, { i2v: string; t2v: string }> = {
  "ltx-video": {
    i2v: "fal-ai/ltx-video/image-to-video",
    t2v: "fal-ai/ltx-video/text-to-video",
  },
  "ltx-2": {
    i2v: "fal-ai/ltx-2/image-to-video",
    t2v: "fal-ai/ltx-2/text-to-video",
  },
};

/** Best-effort flat cost per generation by model (USD). ltx-2 is per-second downstream. */
const MODEL_FLAT_COST: Record<string, number> = { "ltx-video": 0.02 };

interface FalVideoResult {
  video?: { url?: string; content_type?: string };
  videos?: Array<{ url?: string; content_type?: string }>;
  seed?: number;
  metrics?: { cost?: number };
}

interface FalQueueSubmit {
  status_url?: string;
  response_url?: string;
  request_id?: string;
}

interface FalQueueStatus {
  status?: string;
}

interface FalUpload {
  url?: string;
  access_url?: string;
  file_url?: string;
}

export class FalVideoProvider implements VideoGenProvider {
  readonly id = "fal";
  readonly defaultModel: string;

  constructor(
    private readonly falKey: string,
    cfg: { defaultModel: string },
  ) {
    this.defaultModel = cfg.defaultModel;
  }

  async generate(req: VideoGenRequest, signal?: AbortSignal): Promise<VideoGenResult> {
    const modelKey = req.model ?? this.defaultModel;
    const slug = this.resolveSlug(modelKey, req);
    const timeoutMs = req.timeoutMs ?? DEFAULT_VIDEO_GEN_TIMEOUT_MS;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    try {
      const imageUrl = req.initImagePath
        ? await this.uploadInitImage(req.initImagePath, controller.signal)
        : undefined;
      const result = await this.runQueue(slug, req, imageUrl, controller.signal);
      return await this.download(result, modelKey, req, controller.signal);
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Map a friendly model key onto the fal slug for the requested mode. */
  private resolveSlug(modelKey: string, req: VideoGenRequest): string {
    const entry = MODEL_SLUGS[modelKey] ?? MODEL_SLUGS[DEFAULT_FAL_VIDEO_MODEL];
    if (!entry) return modelKey; // caller passed a raw slug
    return req.initImagePath ? entry.i2v : entry.t2v;
  }

  private headers(): Record<string, string> {
    return { "content-type": "application/json", authorization: `Key ${this.falKey}` };
  }

  /** Upload the local init image to fal storage and return its URL. UNVERIFIED — probe live. */
  private async uploadInitImage(path: string, signal: AbortSignal): Promise<string> {
    const bytes = await readFile(path);
    const res = await fetch(FAL_STORAGE_URL, {
      method: "POST",
      headers: { authorization: `Key ${this.falKey}`, "content-type": "application/octet-stream" },
      body: bytes,
      signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`fal storage upload returned HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const uploaded = (await res.json()) as FalUpload;
    const url = uploaded.url ?? uploaded.access_url ?? uploaded.file_url;
    if (!url) throw new Error("fal storage upload response missing a file URL");
    return url;
  }

  /** Map a {@link VideoGenRequest} onto fal's model input JSON. UNVERIFIED — probe live. */
  private buildInput(req: VideoGenRequest, imageUrl?: string): Record<string, unknown> {
    const input: Record<string, unknown> = { prompt: req.prompt };
    if (imageUrl) input.image_url = imageUrl;
    if (req.durationSeconds !== undefined) input.duration = req.durationSeconds;
    if (req.width && req.height) input.resolution = `${req.width}x${req.height}`;
    if (req.guidanceScale !== undefined) input.guidance_scale = req.guidanceScale;
    if (req.numInferenceSteps !== undefined) input.num_inference_steps = req.numInferenceSteps;
    if (req.negativePrompt) input.negative_prompt = req.negativePrompt;
    if (req.seed !== undefined) input.seed = req.seed;
    return input;
  }

  /** Queue path: submit → poll status → fetch result, bounded by `signal`. */
  private async runQueue(
    slug: string,
    req: VideoGenRequest,
    imageUrl: string | undefined,
    signal: AbortSignal,
  ): Promise<FalVideoResult> {
    const submitRes = await fetch(`${FAL_QUEUE_BASE}/${slug}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.buildInput(req, imageUrl)),
      signal,
    });
    if (!submitRes.ok) {
      const body = await submitRes.text();
      throw new Error(`fal queue submit returned HTTP ${submitRes.status}: ${body.slice(0, 300)}`);
    }
    const submit = (await submitRes.json()) as FalQueueSubmit;
    const { status_url: statusUrl, response_url: responseUrl } = submit;
    if (!statusUrl || !responseUrl) {
      throw new Error("fal queue submit response missing status_url/response_url");
    }
    await this.pollUntilComplete(statusUrl, signal);
    return await this.fetchResult(responseUrl, signal);
  }

  private async pollUntilComplete(statusUrl: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      const statusRes = await fetch(statusUrl, { headers: this.headers(), signal });
      if (!statusRes.ok) {
        const body = await statusRes.text();
        throw new Error(
          `fal queue status returned HTTP ${statusRes.status}: ${body.slice(0, 300)}`,
        );
      }
      const status = (await statusRes.json()) as FalQueueStatus;
      if (status.status === "COMPLETED") return;
      await this.sleep(QUEUE_POLL_INTERVAL_MS, signal);
    }
  }

  private async fetchResult(responseUrl: string, signal: AbortSignal): Promise<FalVideoResult> {
    const res = await fetch(responseUrl, { headers: this.headers(), signal });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`fal queue result returned HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    return (await res.json()) as FalVideoResult;
  }

  /** Download the clip URL into bytes. Handles both `video.url` and `videos[0].url`. */
  private async download(
    result: FalVideoResult,
    modelKey: string,
    req: VideoGenRequest,
    signal: AbortSignal,
  ): Promise<VideoGenResult> {
    const clip = result.video ?? result.videos?.[0];
    if (!clip?.url) throw new Error("fal response contained no video URL");
    const clipRes = await fetch(clip.url, { signal });
    if (!clipRes.ok) throw new Error(`fal video download returned HTTP ${clipRes.status}`);
    const bytes = new Uint8Array(await clipRes.arrayBuffer());
    const seed = result.seed ?? req.seed;
    const costUsd = result.metrics?.cost ?? MODEL_FLAT_COST[modelKey];
    return {
      bytes,
      mimeType: clip.content_type ?? "video/mp4",
      provider: this.id,
      model: modelKey,
      ...(req.durationSeconds !== undefined ? { durationSec: req.durationSeconds } : {}),
      ...(seed !== undefined ? { seed } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
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
