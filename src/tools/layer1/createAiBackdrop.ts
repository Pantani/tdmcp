import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { friendlyTdError } from "../../td-client/types.js";
import { generateTextureToCache } from "../layer2/createAiTexture.js";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { createSystemContainer, finalize } from "../layer2/orchestration.js";
import { errorResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const createAiBackdropSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe("Text prompt describing the backdrop image to generate (fal.ai text→image)."),
  negative_prompt: z
    .string()
    .optional()
    .describe("Optional negative prompt — content to steer the generation away from."),
  width: z.coerce
    .number()
    .int()
    .min(64)
    .max(4096)
    .default(1920)
    .describe(
      "Backdrop width in px (default 1920 = 1080p landscape). Independent of height — never square-locked.",
    ),
  height: z.coerce
    .number()
    .int()
    .min(64)
    .max(4096)
    .default(1080)
    .describe(
      "Backdrop height in px (default 1080). Independent of width (arbitrary aspect for LED/projection maps).",
    ),
  seed: z.coerce
    .number()
    .int()
    .optional()
    .describe("Optional seed for deterministic re-generation; also part of the cache key."),
  model: z
    .string()
    .optional()
    .describe(
      "Optional provider model slug overriding the provider default (e.g. a WAN 2.5 slug).",
    ),
  brightness: z.coerce
    .number()
    .min(0)
    .max(4)
    .default(1)
    .describe(
      "Overall brightness / gain of the backdrop (1 = unchanged). Drives the Level TOP's `brightness1` (the gain control is `brightness1`, NOT `gain`) and the exposed Brightness knob.",
    ),
  blur: z.coerce
    .number()
    .min(0)
    .max(200)
    .default(0)
    .describe(
      "Softening blur radius in px (0 = sharp). Drives the Blur TOP's `size` and the exposed Blur knob.",
    ),
  scale: z.coerce
    .number()
    .positive()
    .max(8)
    .default(1)
    .describe(
      "Uniform zoom of the backdrop (1 = fit). Drives the Transform TOP's `sx` and `sy` together and the exposed Scale knob.",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe(
      "When true (default), expose live Brightness / Blur / Scale knobs bound to the backdrop's node parameters so it is playable on arrival.",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent network where the `ai_backdrop` container is created (default '/project1')."),
});

export type CreateAiBackdropArgs = z.infer<typeof createAiBackdropSchema>;

// ---------------------------------------------------------------------------
// Tool impl
// ---------------------------------------------------------------------------

export async function createAiBackdropImpl(
  ctx: ToolContext,
  args: CreateAiBackdropArgs,
): Promise<CallToolResult> {
  // Same generation code path as create_ai_texture — one image, cached to disk
  // BEFORE any TD call. A missing key returns here with NO TD call (builds nothing).
  const gen = await generateTextureToCache(ctx, {
    prompt: args.prompt,
    negativePrompt: args.negative_prompt,
    width: args.width,
    height: args.height,
    seed: args.seed,
    model: args.model,
  });
  if (!gen.ok) return gen.error;

  const { cachePath, image } = gen.value;
  // Cache-aware try/catch (NOT plain runBuild): a hard bridge failure after the
  // image is on disk must still cite the cache path so the asset is never lost.
  try {
    const builder = await createSystemContainer(ctx, args.parent_path, "ai_backdrop");
    const src = await builder.add("moviefileinTOP", "backdrop", { file: cachePath, play: 1 });
    const level = await builder.add("levelTOP", "grade", { brightness1: args.brightness });
    const xform = await builder.add("transformTOP", "frame", { sx: args.scale, sy: args.scale });
    const blur = await builder.add("blurTOP", "soft", { size: args.blur });
    const out = await builder.add("nullTOP", "out1");
    await builder.connect(src, level);
    await builder.connect(level, xform);
    await builder.connect(xform, blur);
    await builder.connect(blur, out);

    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "Brightness",
            type: "float",
            min: 0,
            max: 4,
            default: args.brightness,
            bind_to: [`${level}.brightness1`],
          },
          {
            name: "Blur",
            type: "float",
            min: 0,
            max: 200,
            default: args.blur,
            bind_to: [`${blur}.size`],
          },
          {
            name: "Scale",
            type: "float",
            min: 0.01,
            max: 8,
            default: args.scale,
            // The Scale knob drives both axes so the zoom stays uniform.
            bind_to: [`${xform}.sx`, `${xform}.sy`],
          },
        ]
      : [];

    return await finalize(ctx, {
      summary: `AI backdrop from prompt rendered to ${out} — Movie File In → Level → Transform → Blur → Null.`,
      builder,
      outputPath: out,
      controls,
      extra: {
        cache_path: cachePath,
        provider: image.provider,
        model: image.model,
        seed: image.seed,
        prompt: args.prompt,
      },
    });
  } catch (err) {
    return errorResult(
      `Image generated and cached at ${cachePath}, but building the backdrop network failed: ${friendlyTdError(err)}.`,
      { cache_path: cachePath },
    );
  }
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

export const registerCreateAiBackdrop: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_ai_backdrop",
    {
      title: "Create AI backdrop",
      description:
        "Turn a text prompt into a fully wired, playable backdrop system in one shot. Generates a still image via a hosted provider (fal.ai, default Flux-schnell) Node-side, caches it to a local dir, and delivers it as an absolute file path (server + TD are colocated) — no key ever reaches the bridge. Builds a new `ai_backdrop` baseCOMP under `parent_path` holding Movie File In TOP → Level (brightness1) → Transform (sx/sy) → Blur (size) → Null, and exposes live Brightness / Blur / Scale knobs bound to those parameters so the backdrop is playable on arrival. Same prompt+seed+dims reuses the cached file (no API call). Requires TDMCP_IMAGE_GEN_PROVIDER=fal + TDMCP_FAL_KEY; without them the tool returns a friendly error and builds nothing. If generation succeeds but the TD build fails, the on-disk cache path is cited so the asset is never lost. Width and height are independent (arbitrary aspect for LED/projection maps). Use create_ai_texture instead for a bare Movie File In TOP you wire by hand.",
      inputSchema: createAiBackdropSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createAiBackdropImpl(ctx, args),
  );
};
