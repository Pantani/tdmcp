/**
 * Hosted image-generation provider seam. Mirrors `src/llm/` 1:1: a tiny provider
 * interface + concrete providers + a `resolveImageProvider` factory. The AI-texture
 * lane (`create_ai_texture` / `create_ai_backdrop`) compiles against these shapes;
 * both tools share ONE generation code path via `generateTextureToCache`.
 */

/** Default per-call abort budget for a hosted image generation (ms). */
export const DEFAULT_IMAGE_GEN_TIMEOUT_MS = 180_000;

/** A single text→image request. Width/height are independent (arbitrary aspect). */
export interface ImageGenRequest {
  /** Text prompt. */
  prompt: string;
  /** Optional negative prompt (steer away from). */
  negativePrompt?: string;
  /** Output width in px; independent of height (never derive one from the other). */
  width?: number;
  /** Output height in px; independent of width (no square lock — LED/projection maps). */
  height?: number;
  /** Deterministic re-gen + cache-key input. */
  seed?: number;
  /** Provider model slug; undefined resolves to `provider.defaultModel`. */
  model?: string;
  /** img2img / control reference (accepted now, unused by the P0 fal path). */
  image?: { data: string; mimeType: string };
  /** Per-call abort budget in ms; default {@link DEFAULT_IMAGE_GEN_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** A generated image, fully downloaded into memory (never a bare URL). */
export interface GeneratedImage {
  /** Decoded image bytes — the provider downloads the hosted result URL into bytes. */
  bytes: Uint8Array;
  /** e.g. "image/png" | "image/jpeg". */
  mimeType: string;
  /** Provider id, e.g. "fal". */
  provider: string;
  /** Resolved model slug actually used. */
  model?: string;
  /** Echoed back for reproducibility. */
  seed?: number;
}

/** Structural capability every hosted image provider must satisfy. */
export interface ImageProvider {
  /** Provider id, e.g. "fal" | "replicate". */
  readonly id: string;
  /** Default model slug used when a request omits `model`. */
  readonly defaultModel: string;
  /** Generate one image; downloads the hosted result URL into `bytes`. Throws on non-2xx. */
  generate(req: ImageGenRequest, signal?: AbortSignal): Promise<GeneratedImage>;
}
