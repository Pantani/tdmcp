import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { capturePreview } from "../../feedback/previewCapture.js";
import { findCachedVideo, videoCacheKey, writeCachedVideo } from "../../services/videoGen/cache.js";
import {
  DEFAULT_VIDEO_GEN_TIMEOUT_MS,
  type VideoGenProvider,
  type VideoGenRequest,
  type VideoGenResult,
} from "../../services/videoGen/types.js";
import { friendlyTdError } from "../../td-client/types.js";
import { errorResult, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

// ---------------------------------------------------------------------------
// Context seam
// ---------------------------------------------------------------------------

/**
 * The video-lane fields the integrator adds to {@link ToolContext} (`videoGen`,
 * `videoCacheDir`). Declared locally so this file compiles before that edit lands;
 * both fields are optional, so a plain `ToolContext` is assignable here.
 */
export interface VideoToolContext extends ToolContext {
  videoGen?: VideoGenProvider;
  videoCacheDir?: string;
}

// ---------------------------------------------------------------------------
// Shared schema fragments (reused by create_ai_video_backdrop)
// ---------------------------------------------------------------------------

export const VIDEO_RESOLUTIONS = ["512x512", "768x512", "1280x720", "1920x1080", "4k"] as const;

/** Generation fields common to both the bare tool and the backdrop tool. */
export const videoGenFields = {
  prompt: z.string().min(1).describe("Clip description (appearance + motion)."),
  negative_prompt: z
    .string()
    .optional()
    .describe("Optional steer-away prompt (fal input; comfyui only if the workflow exposes it)."),
  init_image: z
    .string()
    .optional()
    .describe(
      "Optional ABSOLUTE path to an init/anchor image (e.g. a create_ai_texture cache file) for image-to-video. Omitted = text-to-video where supported.",
    ),
  provider: z
    .enum(["fal", "comfyui"])
    .optional()
    .describe("Explicit provider override; falls back to TDMCP_VIDEO_GEN_PROVIDER."),
  model: z
    .enum(["ltx-video", "ltx-2"])
    .default("ltx-video")
    .describe(
      "ltx-video = cheapest, fixed 5s. ltx-2 = per-second, higher-res + audio (10–50× cost).",
    ),
  duration_seconds: z.coerce
    .number()
    .min(1)
    .max(20)
    .default(5)
    .describe("Clip length. ltx-video base is fixed at 5s (rejected otherwise)."),
  resolution: z
    .enum(VIDEO_RESOLUTIONS)
    .default("768x512")
    .describe("Output resolution. 4k requires model: ltx-2."),
  guidance_scale: z.coerce.number().min(2).max(10).default(3).describe("CFG guidance scale."),
  num_inference_steps: z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .default(30)
    .describe("Denoising / sampling steps."),
  seed: z.coerce
    .number()
    .int()
    .optional()
    .describe("Optional seed for deterministic re-generation; also part of the cache key."),
  parent_path: z.string().default("/project1").describe("COMP the container/TOP is created under."),
};

/**
 * Reject unsupported knob combinations at the schema boundary (house convention,
 * not silent-ignore). Kept its own function to hold CC ≤ 10.
 */
export function refineVideoModel(
  args: { model: string; duration_seconds: number; resolution: string },
  ctx: z.RefinementCtx,
): void {
  if (args.model === "ltx-video" && args.duration_seconds !== 5) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["duration_seconds"],
      message:
        "ltx-video base is fixed at 5s — omit duration_seconds or use model: ltx-2 for variable length.",
    });
  }
  if (args.resolution === "4k" && args.model !== "ltx-2") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["resolution"],
      message: "4k output requires model: ltx-2.",
    });
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

// Plain object (has `.shape` for registerTool); refinements go on the wrapper.
export const createAiVideoInputSchema = z.object({
  ...videoGenFields,
  name: z.string().default("ai_video").describe("Name of the created Movie File In TOP node."),
  play: z
    .boolean()
    .default(true)
    .describe("Whether the resulting Movie File In TOP plays on arrival (maps to its play par)."),
});

export const createAiVideoSchema = createAiVideoInputSchema.superRefine((args, ctx) =>
  refineVideoModel(args, ctx),
);

export type CreateAiVideoArgs = z.infer<typeof createAiVideoSchema>;

// ---------------------------------------------------------------------------
// Resolution parsing
// ---------------------------------------------------------------------------

const RESOLUTION_DIMS: Record<string, { width: number; height: number }> = {
  "512x512": { width: 512, height: 512 },
  "768x512": { width: 768, height: 512 },
  "1280x720": { width: 1280, height: 720 },
  "1920x1080": { width: 1920, height: 1080 },
  "4k": { width: 3840, height: 2160 },
};

const DEFAULT_DIMS = { width: 768, height: 512 } as const;

export function resolutionDims(resolution: string): { width: number; height: number } {
  return RESOLUTION_DIMS[resolution] ?? DEFAULT_DIMS;
}

// ---------------------------------------------------------------------------
// Shared generation code path (imported by create_ai_video_backdrop too)
// ---------------------------------------------------------------------------

/** The outcome of generating (or cache-reusing) one clip, before any TD delivery. */
export interface VideoGeneration {
  /** Absolute path to the cached clip on disk. */
  cachePath: string;
  /** Provider metadata. Bytes are empty on a cache hit. */
  video: VideoGenResult;
  /** Deterministic cache key for the request. */
  cacheKey: string;
  /** True when the clip was reused from cache (no API call was made). */
  cacheHit: boolean;
}

function mimeFromPath(filePath: string): string {
  return filePath.toLowerCase().endsWith(".webm") ? "video/webm" : "video/mp4";
}

/**
 * Generate one clip and cache it to disk BEFORE any TD call. Never throws —
 * returns a discriminated result so both tools can bail to `errorResult` without
 * attempting a build. The single generation code path shared by `create_ai_video`
 * and `create_ai_video_backdrop`.
 */
export async function generateVideoToCache(
  ctx: VideoToolContext,
  req: VideoGenRequest,
): Promise<{ ok: true; value: VideoGeneration } | { ok: false; error: CallToolResult }> {
  if (!ctx.videoGen) {
    return {
      ok: false,
      error: errorResult(
        "Video generation needs a provider. Set TDMCP_VIDEO_GEN_PROVIDER=fal (+ TDMCP_FAL_KEY) or =comfyui (+ TDMCP_COMFYUI_VIDEO_WORKFLOW), then retry — the network was not built.",
      ),
    };
  }

  const model = req.model ?? ctx.videoGen.defaultModel;
  const cacheDir = ctx.videoCacheDir ?? ".tdmcp/video-gen";
  const cacheKey = videoCacheKey(req, ctx.videoGen.id, model);

  const hit = await findCachedVideo(cacheDir, cacheKey);
  if (hit) {
    return {
      ok: true,
      value: {
        cachePath: hit,
        video: {
          bytes: new Uint8Array(0),
          mimeType: mimeFromPath(hit),
          provider: ctx.videoGen.id,
          model,
          durationSec: req.durationSeconds,
          seed: req.seed,
        },
        cacheKey,
        cacheHit: true,
      },
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? DEFAULT_VIDEO_GEN_TIMEOUT_MS);
  let video: VideoGenResult;
  try {
    video = await ctx.videoGen.generate({ ...req, model }, controller.signal);
  } catch (err) {
    return {
      ok: false,
      error: errorResult(`Video generation failed: ${(err as Error).message}`, {
        provider: ctx.videoGen.id,
        model,
      }),
    };
  } finally {
    clearTimeout(timer);
  }

  const cachePath = await writeCachedVideo(cacheDir, cacheKey, video);
  return { ok: true, value: { cachePath, video, cacheKey, cacheHit: false } };
}

/** Map tool args onto a {@link VideoGenRequest} (shared by both tools). */
export function toVideoRequest(args: {
  prompt: string;
  negative_prompt?: string;
  init_image?: string;
  model: string;
  duration_seconds: number;
  resolution: string;
  guidance_scale: number;
  num_inference_steps: number;
  seed?: number;
}): VideoGenRequest {
  const { width, height } = resolutionDims(args.resolution);
  return {
    prompt: args.prompt,
    negativePrompt: args.negative_prompt,
    initImagePath: args.init_image,
    model: args.model,
    durationSeconds: args.duration_seconds,
    width,
    height,
    guidanceScale: args.guidance_scale,
    numInferenceSteps: args.num_inference_steps,
    seed: args.seed,
  };
}

/**
 * Honor an explicit `provider` arg over the config-resolved one: reject a mismatch
 * with a friendly error (builds nothing) rather than silently using the wrong
 * provider. Returns undefined when the request is compatible.
 */
export function checkProvider(
  ctx: VideoToolContext,
  requested?: "fal" | "comfyui",
): CallToolResult | undefined {
  if (requested && ctx.videoGen && ctx.videoGen.id !== requested) {
    return errorResult(
      `Requested provider '${requested}' but TDMCP_VIDEO_GEN_PROVIDER resolved '${ctx.videoGen.id}'. Set TDMCP_VIDEO_GEN_PROVIDER=${requested} (+ its prerequisites) and retry — the network was not built.`,
    );
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Tool impl
// ---------------------------------------------------------------------------

export async function createAiVideoImpl(
  ctx: VideoToolContext,
  args: CreateAiVideoArgs,
): Promise<CallToolResult> {
  const mismatch = checkProvider(ctx, args.provider);
  if (mismatch) return mismatch;
  const gen = await generateVideoToCache(ctx, toVideoRequest(args));
  if (!gen.ok) return gen.error;

  const { cachePath, video, cacheHit } = gen.value;
  try {
    const ref = await ctx.client.createNode({
      parent_path: args.parent_path,
      type: "moviefileinTOP",
      name: args.name,
      parameters: { file: cachePath, play: args.play ? 1 : 0 },
    });

    let previewBase64: string | undefined;
    let previewMime: string | undefined;
    try {
      const preview = await capturePreview(ctx.client, ref.path);
      previewBase64 = preview.base64;
      previewMime = preview.mimeType;
    } catch {
      // Preview is best-effort — a failed capture is non-fatal (the node is built).
    }

    const summary = {
      node: ref.path,
      cache_path: cachePath,
      provider: video.provider,
      model: video.model,
      seed: video.seed,
      cost_usd: video.costUsd,
      cache_hit: cacheHit,
      duration_sec: video.durationSec,
    };
    const headline = `AI video ${cacheHit ? "reused from cache" : "generated"} → ${ref.path} (Movie File In TOP). Clip on disk at ${cachePath}.`;
    const result = jsonResult(headline, summary);
    if (previewBase64) {
      result.content.push({
        type: "image",
        data: previewBase64,
        mimeType: previewMime ?? "image/png",
      });
    }
    return result;
  } catch (err) {
    return errorResult(
      `Video generated and cached, but delivery to TouchDesigner failed: ${friendlyTdError(err)}. ` +
        `The clip is on disk at ${cachePath} — point a Movie File In TOP at it, or retry when TD is reachable.`,
      { cache_path: cachePath, provider: video.provider, model: video.model },
    );
  }
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

export const registerCreateAiVideo: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_ai_video",
    {
      title: "Create AI video",
      description:
        "Turn a text prompt (+ optional init image) into a short clip via a provider-agnostic engine — hosted fal OR local ComfyUI — and drop it into TouchDesigner as a Movie File In TOP the artist can wire by hand. NOT real time: generate ahead (seconds–minutes), then play live. The clip is generated Node-side, cached to a local dir, and delivered as an absolute file path (server + TD are colocated) — no key ever reaches the bridge. Default model ltx-video (cheapest, fixed 5s); ltx-2 for variable length + higher res + audio. Same request reuses the cached file (no API call). Requires TDMCP_VIDEO_GEN_PROVIDER=fal (+TDMCP_FAL_KEY) or =comfyui (+TDMCP_COMFYUI_VIDEO_WORKFLOW); without them the tool returns a friendly error and builds nothing. Use create_ai_video_backdrop for a fully wired, control-exposed playback system instead of a bare TOP.",
      inputSchema: createAiVideoInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createAiVideoImpl(ctx, createAiVideoSchema.parse(args)),
  );
};
