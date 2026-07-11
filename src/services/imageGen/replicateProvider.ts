import {
  DEFAULT_IMAGE_GEN_TIMEOUT_MS,
  type GeneratedImage,
  type ImageGenRequest,
  type ImageProvider,
} from "./types.js";

/**
 * Replicate image provider — sibling of {@link FalProvider}. Copies the same
 * discipline: `fetch` + a private `headers()` + one `AbortController` timeout
 * budget + `throw new Error("… HTTP <status>: <body slice>")` on any non-2xx.
 *
 * Verified Replicate REST contract (official docs, 2026-07-11:
 * https://replicate.com/docs/topics/predictions/create-a-prediction):
 *   - Create (official model `owner/name`): POST /v1/models/{owner}/{name}/predictions,
 *     body { input }.
 *   - Create (version hash / `owner/name:version`): POST /v1/predictions,
 *     body { version, input }.
 *   - Auth header: `Authorization: Bearer <REPLICATE_API_TOKEN>` (current docs;
 *     legacy `Token <key>` is still accepted but no longer the documented default).
 *   - Response: { id, status, output, urls: { get, cancel } };
 *     status ∈ { starting, processing, succeeded, failed, canceled }.
 *   - Poll: GET {urls.get} with the same auth until a terminal status —
 *     `succeeded` → read `output`; `failed`/`canceled` → throw with `error`.
 *   - Output (image models): a URL string OR an array of URL strings; download the
 *     first with a second `fetch` into bytes.
 */

/** Default Replicate model slug (official `owner/name` → model endpoint). */
export const DEFAULT_REPLICATE_MODEL = "black-forest-labs/flux-schnell";

const REPLICATE_API = "https://api.replicate.com/v1";
const POLL_INTERVAL_MS = 1_000;

interface ReplicatePrediction {
  id?: string;
  status?: string;
  output?: string | string[] | null;
  error?: string | null;
  urls?: { get?: string; cancel?: string };
}

export class ReplicateProvider implements ImageProvider {
  readonly id = "replicate";
  readonly defaultModel: string;

  constructor(
    private readonly key: string,
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
      const created = await this.createPrediction(model, req, controller.signal);
      const done = await this.poll(created, controller.signal);
      return await this.download(done, model, req, controller.signal);
    } finally {
      clearTimeout(timeout);
    }
  }

  private headers(): Record<string, string> {
    return { "content-type": "application/json", authorization: `Bearer ${this.key}` };
  }

  /**
   * Map an {@link ImageGenRequest} onto the model's input JSON. Kept as one small
   * easy-to-edit method — the exact input field names are per-model (risk R3).
   */
  private buildInput(req: ImageGenRequest): Record<string, unknown> {
    const input: Record<string, unknown> = {
      prompt: req.prompt,
      num_outputs: 1,
    };
    // UNVERIFIED-live (R3): flux-schnell takes width/height; other models use
    // `aspect_ratio` / `size` — adjust here per the model's live input schema.
    if (req.width !== undefined) input.width = req.width;
    if (req.height !== undefined) input.height = req.height;
    if (req.seed !== undefined) input.seed = req.seed;
    return input;
  }

  /** POST to the model- or version-endpoint per the verified contract. */
  private async createPrediction(
    model: string,
    req: ImageGenRequest,
    signal: AbortSignal,
  ): Promise<ReplicatePrediction> {
    const useModelEndpoint = model.includes("/") && !model.includes(":");
    const url = useModelEndpoint
      ? `${REPLICATE_API}/models/${model}/predictions`
      : `${REPLICATE_API}/predictions`;
    const body = useModelEndpoint
      ? { input: this.buildInput(req) }
      : { version: model.split(":").pop(), input: this.buildInput(req) };
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`replicate create returned HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return (await res.json()) as ReplicatePrediction;
  }

  /** Loop `GET {urls.get}` until a terminal status, bounded by `signal`. */
  private async poll(
    created: ReplicatePrediction,
    signal: AbortSignal,
  ): Promise<ReplicatePrediction> {
    const getUrl = created.urls?.get;
    if (!getUrl) throw new Error("replicate create response missing urls.get");
    let prediction = created;
    for (;;) {
      const status = prediction.status;
      if (status === "succeeded") return prediction;
      if (status === "failed" || status === "canceled") {
        throw new Error(`replicate prediction ${status}: ${prediction.error ?? "unknown error"}`);
      }
      await this.sleep(POLL_INTERVAL_MS, signal);
      const res = await fetch(getUrl, { headers: this.headers(), signal });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`replicate poll returned HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      prediction = (await res.json()) as ReplicatePrediction;
    }
  }

  /** Download the output URL into bytes (Replicate returns a URL or array of URLs). */
  private async download(
    prediction: ReplicatePrediction,
    model: string,
    req: ImageGenRequest,
    signal: AbortSignal,
  ): Promise<GeneratedImage> {
    const output = prediction.output;
    // UNVERIFIED-live (R3): output is a URL string for most image models, an array
    // for multi-image models — take the first either way.
    const url = Array.isArray(output) ? output[0] : output;
    if (!url) throw new Error("replicate prediction produced no output URL");
    const imgRes = await fetch(url, { signal });
    if (!imgRes.ok) {
      throw new Error(`replicate image download returned HTTP ${imgRes.status}`);
    }
    const bytes = new Uint8Array(await imgRes.arrayBuffer());
    const seed = req.seed;
    return {
      bytes,
      mimeType: imgRes.headers.get("content-type") ?? "image/png",
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
