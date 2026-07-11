import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { capturePreview } from "../../feedback/previewCapture.js";
import { findCachedImage, imageCacheKey, writeCachedImage } from "../../services/imageGen/cache.js";
import {
  DEFAULT_IMAGE_GEN_TIMEOUT_MS,
  type GeneratedImage,
  type ImageGenRequest,
} from "../../services/imageGen/types.js";
import { friendlyTdError } from "../../td-client/types.js";
import { errorResult, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize } from "./orchestration.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const createAiTextureSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe("Text prompt describing the image to generate (fal.ai text→image)."),
  negative_prompt: z
    .string()
    .optional()
    .describe("Optional negative prompt — content to steer the generation away from."),
  width: z.coerce
    .number()
    .int()
    .min(64)
    .max(4096)
    .default(1024)
    .describe("Output width in px. Independent of height — never square-locked."),
  height: z.coerce
    .number()
    .int()
    .min(64)
    .max(4096)
    .default(1024)
    .describe(
      "Output height in px. Independent of width (arbitrary aspect for LED/projection pixel maps).",
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
  play: z
    .boolean()
    .default(true)
    .describe("Whether the resulting Movie File In TOP plays on arrival (maps to its play par)."),
  name: z.string().default("ai_texture").describe("Name of the created Movie File In TOP node."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Path of the COMP the Movie File In TOP is dropped inside."),
  num_images: z.coerce
    .number()
    .int()
    .min(1)
    .max(16)
    .default(1)
    .describe(
      "How many images to generate. 1 (default) = a single Movie File In TOP (unchanged). " +
        ">1 builds a texture pack: N Movie File In TOPs in a new baseCOMP, tiled into a Layout TOP " +
        "grid → Null output. Each image uses a distinct seed (base seed + i) so they differ and " +
        "cache separately.",
    ),
});

export type CreateAiTextureArgs = z.infer<typeof createAiTextureSchema>;

// ---------------------------------------------------------------------------
// Shared generation code path (imported by create_ai_backdrop too)
// ---------------------------------------------------------------------------

/** The outcome of generating (or cache-reusing) one image, before any TD delivery. */
export interface TextureGeneration {
  /** Absolute path to the cached image on disk. */
  cachePath: string;
  /** Provider metadata (provider, model, seed, mimeType). Bytes are empty on a cache hit. */
  image: GeneratedImage;
  /** Deterministic cache key for the request. */
  cacheKey: string;
  /** True when the image was reused from cache (no API call was made). */
  cacheHit: boolean;
}

const MIME_BY_EXT: ReadonlyArray<[string, string]> = [
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
];

function mimeFromPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  for (const [ext, mime] of MIME_BY_EXT) {
    if (lower.endsWith(ext)) return mime;
  }
  return "image/png";
}

/**
 * Generate one image and cache it to disk BEFORE any TD call. Never throws —
 * returns a discriminated result so both tools can bail to `errorResult` without
 * attempting a build. The single generation code path shared by `create_ai_texture`
 * and `create_ai_backdrop` (zero orphan nodes, one provider seam).
 */
export async function generateTextureToCache(
  ctx: ToolContext,
  req: ImageGenRequest,
): Promise<{ ok: true; value: TextureGeneration } | { ok: false; error: CallToolResult }> {
  if (!ctx.imageGen) {
    return {
      ok: false,
      error: errorResult(
        "Image generation needs TDMCP_FAL_KEY. Set TDMCP_IMAGE_GEN_PROVIDER=fal and TDMCP_FAL_KEY, then retry — the network was not built.",
      ),
    };
  }

  const model = req.model ?? ctx.imageGen.defaultModel;
  const cacheDir = ctx.imageCacheDir ?? ".tdmcp/image-gen";
  const cacheKey = imageCacheKey(req, ctx.imageGen.id, model);

  const hit = await findCachedImage(cacheDir, cacheKey);
  if (hit) {
    return {
      ok: true,
      value: {
        cachePath: hit,
        image: {
          bytes: new Uint8Array(0),
          mimeType: mimeFromPath(hit),
          provider: ctx.imageGen.id,
          model,
          seed: req.seed,
        },
        cacheKey,
        cacheHit: true,
      },
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? DEFAULT_IMAGE_GEN_TIMEOUT_MS);
  let image: GeneratedImage;
  try {
    image = await ctx.imageGen.generate({ ...req, model }, controller.signal);
  } catch (err) {
    return {
      ok: false,
      error: errorResult(`Image generation failed: ${(err as Error).message}`, {
        provider: ctx.imageGen.id,
        model,
      }),
    };
  } finally {
    clearTimeout(timer);
  }

  const cachePath = await writeCachedImage(cacheDir, cacheKey, image);
  return { ok: true, value: { cachePath, image, cacheKey, cacheHit: false } };
}

// ---------------------------------------------------------------------------
// Tool impl
// ---------------------------------------------------------------------------

export async function createAiTextureImpl(
  ctx: ToolContext,
  args: CreateAiTextureArgs,
): Promise<CallToolResult> {
  if (args.num_images > 1) return createTexturePackImpl(ctx, args);
  const gen = await generateTextureToCache(ctx, {
    prompt: args.prompt,
    negativePrompt: args.negative_prompt,
    width: args.width,
    height: args.height,
    seed: args.seed,
    model: args.model,
  });
  if (!gen.ok) return gen.error;

  const { cachePath, image, cacheHit } = gen.value;
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
      provider: image.provider,
      model: image.model,
      seed: image.seed,
      cache_hit: cacheHit,
    };
    const headline = `AI texture ${cacheHit ? "reused from cache" : "generated"} → ${ref.path} (Movie File In TOP). Image on disk at ${cachePath}.`;
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
      `Image generated and cached, but delivery to TouchDesigner failed: ${friendlyTdError(err)}. ` +
        `The image is on disk at ${cachePath} — point a Movie File In TOP at it, or retry when TD is reachable.`,
      { cache_path: cachePath, provider: image.provider, model: image.model },
    );
  }
}

// ---------------------------------------------------------------------------
// Texture-pack mode (num_images > 1) — N sources tiled into one Layout grid
// ---------------------------------------------------------------------------

/**
 * A concrete 32-bit base seed for a pack when the caller omits `seed`. Each image
 * then uses `baseSeed + i`, giving N distinct cache keys (so the pack does NOT
 * collapse to N identical cached textures) while staying reproducible when a seed
 * is passed.
 */
function randomBaseSeed(): number {
  return (Math.random() * 2 ** 31) | 0;
}

/**
 * The human-readable message of a CallToolResult, minus any appended JSON code
 * fence — so citing it as a "Cause" does not embed a nested ```json block that
 * would shadow this result's own structured fence.
 */
function messageOf(result: CallToolResult): string {
  const text = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  const fence = text.indexOf("\n\n```json");
  return fence === -1 ? text : text.slice(0, fence);
}

/**
 * Generates + caches the N pack images sequentially via the shared, unforked
 * `generateTextureToCache`. The first failure aborts with NO TD build attempted,
 * citing the images already on disk so nothing generated is lost.
 */
async function generatePackImages(
  ctx: ToolContext,
  args: CreateAiTextureArgs,
  packSeed: number,
): Promise<{ ok: true; value: TextureGeneration[] } | { ok: false; error: CallToolResult }> {
  const generated: TextureGeneration[] = [];
  for (let i = 0; i < args.num_images; i++) {
    const gen = await generateTextureToCache(ctx, {
      prompt: args.prompt,
      negativePrompt: args.negative_prompt,
      width: args.width,
      height: args.height,
      seed: packSeed + i,
      model: args.model,
    });
    if (!gen.ok) {
      const cached = generated.map((g) => g.cachePath);
      return {
        ok: false,
        error: errorResult(
          `Texture pack aborted at image ${i + 1}/${args.num_images}. ` +
            `${cached.length} image(s) already cached: ${cached.join(", ")}. ` +
            `Cause: ${messageOf(gen.error)}`,
          { cached_so_far: cached },
        ),
      };
    }
    generated.push(gen.value);
  }
  return { ok: true, value: generated };
}

/**
 * Builds the cache-aware pack network: N Movie File In TOPs in a fresh baseCOMP,
 * tiled into a Layout TOP grid → Null output, then finalized (auto-layout, error
 * check, preview). A hard bridge failure after generation still cites every cache
 * path so the on-disk assets are never lost.
 */
async function buildTexturePack(
  ctx: ToolContext,
  args: CreateAiTextureArgs,
  generated: TextureGeneration[],
  packSeed: number,
): Promise<CallToolResult> {
  const cachePaths = generated.map((g) => g.cachePath);
  const first = generated[0];
  try {
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);
    const cols = Math.ceil(Math.sqrt(args.num_images));
    const srcPaths: string[] = [];
    for (const [i, gen] of generated.entries()) {
      srcPaths.push(
        await builder.add("moviefileinTOP", `${args.name}_${i + 1}`, {
          file: gen.cachePath,
          play: args.play ? 1 : 0,
        }),
      );
    }
    // `layoutTOP` `maxcols` token is PROBE-FIRST / UNVERIFIED-live (spec risk L): if the
    // token is wrong, the bridge folds it into a NetworkBuilder warning and the pack still
    // delivers with the default layout — it never aborts the build.
    const grid = await builder.add("layoutTOP", "grid", { maxcols: cols });
    for (const [i, src] of srcPaths.entries()) {
      await builder.connect(src, grid, 0, i);
    }
    const out = await builder.add("nullTOP", "out1");
    await builder.connect(grid, out);

    return await finalize(ctx, {
      summary: `AI texture pack of ${args.num_images} images → ${out} (${cols}-wide Layout grid).`,
      builder,
      outputPath: out,
      extra: {
        pack: srcPaths,
        cache_paths: cachePaths,
        provider: first?.image.provider,
        model: first?.image.model,
        count: args.num_images,
        base_seed: packSeed,
        prompt: args.prompt,
      },
    });
  } catch (err) {
    return errorResult(
      `All ${args.num_images} images generated and cached, but building the pack network failed: ` +
        `${friendlyTdError(err)}. Images on disk: ${cachePaths.join(", ")}.`,
      { cache_paths: cachePaths },
    );
  }
}

/** Batch/texture-pack branch of `create_ai_texture` (num_images > 1). */
async function createTexturePackImpl(
  ctx: ToolContext,
  args: CreateAiTextureArgs,
): Promise<CallToolResult> {
  const packSeed = args.seed ?? randomBaseSeed();
  const images = await generatePackImages(ctx, args, packSeed);
  if (!images.ok) return images.error;
  return buildTexturePack(ctx, args, images.value, packSeed);
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

export const registerCreateAiTexture: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_ai_texture",
    {
      title: "Create AI texture",
      description:
        "Turn a text prompt into a still image via a hosted provider (fal.ai, default Flux-schnell) and drop it into TouchDesigner as a Movie File In TOP the artist can wire by hand. The image is generated Node-side, cached to a local dir, and delivered as an absolute file path (server + TD are colocated) — no key ever reaches the bridge. Same prompt+seed+dims reuses the cached file (no API call). Requires TDMCP_IMAGE_GEN_PROVIDER=fal + TDMCP_FAL_KEY; without them the tool returns a friendly error and builds nothing. Returns the node path, the on-disk cache path, provider/model/seed, and an inline preview when TD is reachable. Width and height are independent (arbitrary aspect for LED/projection maps). Use create_ai_backdrop for a fully wired, control-exposed backdrop system instead of a bare TOP.",
      inputSchema: createAiTextureSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createAiTextureImpl(ctx, args),
  );
};
