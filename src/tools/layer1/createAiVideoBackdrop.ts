import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { friendlyTdError } from "../../td-client/types.js";
import {
  checkProvider,
  generateVideoToCache,
  refineVideoModel,
  toVideoRequest,
  type VideoToolContext,
  videoGenFields,
} from "../layer2/createAiVideo.js";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { createSystemContainer, finalize } from "../layer2/orchestration.js";
import { errorResult } from "../result.js";
import type { ToolRegistrar } from "../types.js";

// ---------------------------------------------------------------------------
// Schema — same generation fields, minus name/play, plus backdrop controls
// ---------------------------------------------------------------------------

export const createAiVideoBackdropInputSchema = z.object({
  ...videoGenFields,
  brightness: z.coerce
    .number()
    .min(0)
    .max(4)
    .default(1)
    .describe(
      "Overall brightness / gain of the clip (1 = unchanged). Drives the Level TOP's `brightness1` (the gain control is `brightness1`, NOT `gain`) and the exposed Brightness knob.",
    ),
  scale: z.coerce
    .number()
    .positive()
    .max(8)
    .default(1)
    .describe(
      "Uniform zoom of the clip (1 = fit). Drives the Transform TOP's `sx` and `sy` together and the exposed Scale knob.",
    ),
  blur: z.coerce
    .number()
    .min(0)
    .max(200)
    .default(0)
    .describe(
      "Softening blur radius in px (0 = sharp). Drives the Blur TOP's `size` and the exposed Blur knob.",
    ),
  play: z
    .boolean()
    .default(true)
    .describe(
      "Whether the clip plays on arrival (maps to the Movie File In's play par + Play knob).",
    ),
  speed: z.coerce
    .number()
    .min(-2)
    .max(2)
    .default(1)
    .describe("Playback speed (1 = normal, negative = reverse). Drives the Speed knob."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe(
      "When true (default), expose live Play / Speed / Brightness / Scale / Blur controls bound to the clip's node parameters so it is playable on arrival.",
    ),
});

export const createAiVideoBackdropSchema = createAiVideoBackdropInputSchema.superRefine(
  (args, ctx) => refineVideoModel(args, ctx),
);

export type CreateAiVideoBackdropArgs = z.infer<typeof createAiVideoBackdropSchema>;

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function backdropControls(
  args: CreateAiVideoBackdropArgs,
  clip: string,
  grade: string,
  frame: string,
  soft: string,
): ControlSpec[] {
  if (!args.expose_controls) return [];
  return [
    { name: "Play", type: "toggle", default: args.play, bind_to: [`${clip}.play`] },
    {
      name: "Speed",
      type: "float",
      min: -2,
      max: 2,
      default: args.speed,
      bind_to: [`${clip}.speed`],
    },
    {
      name: "Brightness",
      type: "float",
      min: 0,
      max: 4,
      default: args.brightness,
      bind_to: [`${grade}.brightness1`],
    },
    {
      name: "Scale",
      type: "float",
      min: 0.01,
      max: 8,
      default: args.scale,
      // The Scale knob drives both axes so the zoom stays uniform.
      bind_to: [`${frame}.sx`, `${frame}.sy`],
    },
    {
      name: "Blur",
      type: "float",
      min: 0,
      max: 200,
      default: args.blur,
      bind_to: [`${soft}.size`],
    },
  ];
}

// ---------------------------------------------------------------------------
// Tool impl
// ---------------------------------------------------------------------------

export async function createAiVideoBackdropImpl(
  ctx: VideoToolContext,
  args: CreateAiVideoBackdropArgs,
): Promise<CallToolResult> {
  const mismatch = checkProvider(ctx, args.provider);
  if (mismatch) return mismatch;
  // Same generation code path as create_ai_video — one clip, cached to disk BEFORE
  // any TD call. A missing provider returns here with NO TD call (builds nothing).
  const gen = await generateVideoToCache(ctx, toVideoRequest(args));
  if (!gen.ok) return gen.error;

  const { cachePath, video } = gen.value;
  // Cache-aware try/catch (NOT plain runBuild): a hard bridge failure after the
  // clip is on disk must still cite the cache path so the asset is never lost.
  try {
    const builder = await createSystemContainer(ctx, args.parent_path, "ai_video");
    const clip = await builder.add("moviefileinTOP", "clip", {
      file: cachePath,
      play: args.play ? 1 : 0,
      speed: args.speed,
    });
    const grade = await builder.add("levelTOP", "grade", { brightness1: args.brightness });
    const frame = await builder.add("transformTOP", "frame", { sx: args.scale, sy: args.scale });
    const soft = await builder.add("blurTOP", "soft", { size: args.blur });
    const out = await builder.add("nullTOP", "out1");
    await builder.connect(clip, grade);
    await builder.connect(grade, frame);
    await builder.connect(frame, soft);
    await builder.connect(soft, out);

    return await finalize(ctx, {
      summary: `AI video backdrop from prompt rendered to ${out} — Movie File In → Level → Transform → Blur → Null.`,
      builder,
      outputPath: out,
      controls: backdropControls(args, clip, grade, frame, soft),
      extra: {
        cache_path: cachePath,
        provider: video.provider,
        model: video.model,
        seed: video.seed,
        cost_usd: video.costUsd,
        duration_sec: video.durationSec,
        prompt: args.prompt,
      },
    });
  } catch (err) {
    return errorResult(
      `Video generated and cached at ${cachePath}, but building the backdrop network failed: ${friendlyTdError(err)}.`,
      { cache_path: cachePath },
    );
  }
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

export const registerCreateAiVideoBackdrop: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_ai_video_backdrop",
    {
      title: "Create AI video backdrop",
      description:
        "Turn a text prompt (+ optional init image) into a fully wired, playable video-backdrop system in one shot. Generates a short clip via a provider-agnostic engine (hosted fal OR local ComfyUI) Node-side, caches it to a local dir, and delivers it as an absolute file path (server + TD are colocated) — no key ever reaches the bridge. NOT real time: generate ahead (seconds–minutes), then play live. Builds a new `ai_video` baseCOMP under `parent_path` holding Movie File In TOP → Level (brightness1) → Transform (sx/sy) → Blur (size) → Null, and exposes live Play / Speed / Brightness / Scale / Blur knobs bound to those parameters so the clip is playable on arrival. Default model ltx-video (fixed 5s); ltx-2 for variable length + higher res + audio. Same request reuses the cached file (no API call). Requires TDMCP_VIDEO_GEN_PROVIDER=fal (+TDMCP_FAL_KEY) or =comfyui (+TDMCP_COMFYUI_VIDEO_WORKFLOW); without them the tool returns a friendly error and builds nothing. If generation succeeds but the TD build fails, the on-disk cache path is cited so the asset is never lost. The output Null is create_external_io-ready (NDI/Spout/RTMP out). Use create_ai_video instead for a bare Movie File In TOP you wire by hand.",
      inputSchema: createAiVideoBackdropInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createAiVideoBackdropImpl(ctx, createAiVideoBackdropSchema.parse(args)),
  );
};
