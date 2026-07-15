/**
 * Hosted/local video-generation provider seam. Mirrors `src/services/imageGen/`
 * 1:1: a tiny provider interface + concrete providers (`FalVideoProvider`,
 * `ComfyuiVideoProvider`) + a `resolveVideoProvider` factory. The AI-video lane
 * (`create_ai_video` / `create_ai_video_backdrop`) compiles against these shapes;
 * both tools share ONE generation code path via `generateVideoToCache`.
 *
 * Bytes-in-memory discipline: a provider ALWAYS downloads the hosted/local result
 * into `bytes` (never a bare URL), throws on any non-2xx, and honours the shared
 * AbortSignal budget — identical to the image lane.
 */

/** Default per-call abort budget for a video generation (ms). Video is slow (queue / local GPU). */
export const DEFAULT_VIDEO_GEN_TIMEOUT_MS = 600_000; // 10 min

/** A single text→video (or image→video) request. */
export interface VideoGenRequest {
  /** Clip description (appearance + motion). */
  prompt: string;
  /** Optional negative prompt (steer away from). */
  negativePrompt?: string;
  /** Absolute path to an init/anchor image; provider uploads (fal) or injects (comfyui). */
  initImagePath?: string;
  /** Friendly model key ("ltx-video" | "ltx-2"); undefined resolves to `provider.defaultModel`. */
  model?: string;
  /** Clip length in seconds. */
  durationSeconds?: number;
  /** Output width in px (parsed from the resolution enum by the tool). */
  width?: number;
  /** Output height in px (parsed from the resolution enum by the tool). */
  height?: number;
  /** Classifier-free guidance scale. */
  guidanceScale?: number;
  /** Denoising / sampling steps. */
  numInferenceSteps?: number;
  /** Deterministic re-gen + cache-key input. */
  seed?: number;
  /** Per-call abort budget in ms; default {@link DEFAULT_VIDEO_GEN_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** A generated clip, fully downloaded into memory (never a bare URL). */
export interface VideoGenResult {
  /** Decoded clip bytes — the provider downloads the result into bytes. */
  bytes: Uint8Array;
  /** "video/mp4" | "video/webm". */
  mimeType: string;
  /** Provider id, e.g. "fal" | "comfyui". */
  provider: string;
  /** Resolved model slug actually used. */
  model?: string;
  /** Clip length echoed for reproducibility. */
  durationSec?: number;
  /** Echoed back for reproducibility. */
  seed?: number;
  /** fal only (best-effort); undefined for comfyui (local, free). */
  costUsd?: number;
}

/** Structural capability every video provider must satisfy. */
export interface VideoGenProvider {
  /** Provider id. */
  readonly id: "fal" | "comfyui";
  /** Default model key used when a request omits `model`. */
  readonly defaultModel: string;
  /** Generate one clip; downloads the result into `bytes`. Throws on non-2xx. */
  generate(req: VideoGenRequest, signal?: AbortSignal): Promise<VideoGenResult>;
}
