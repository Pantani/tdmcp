import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { GeneratedImage, ImageGenRequest } from "./types.js";

/**
 * Filesystem cache for generated images. The generation helper writes each image
 * here BEFORE any TD call, then points a `moviefileinTOP` at the returned path.
 *
 * Hard requirement: {@link writeCachedImage} returns an ABSOLUTE path via
 * `path.resolve` — a relative path does NOT open in a Movie File In TOP.
 * No eviction in v1: the dir is user-clearable (mirrors `ragDataDir`).
 */

/** Known image mime types → file extension. */
const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

function extFromMime(mime: string): string {
  return MIME_EXT[mime] ?? "png";
}

/**
 * Deterministic cache key: sha256 hex of the generation-defining fields. Excludes
 * mime type (a hit reuses whatever extension is on disk) so the same prompt+seed+dims
 * always maps to one key regardless of output format.
 */
export function imageCacheKey(req: ImageGenRequest, providerId: string, model: string): string {
  const payload = JSON.stringify({
    providerId,
    model,
    prompt: req.prompt,
    negativePrompt: req.negativePrompt,
    width: req.width,
    height: req.height,
    seed: req.seed,
  });
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Returns the absolute path of a previously cached image for `key`, or `undefined`
 * on a miss. Probes the known extensions since the key omits mime type.
 */
export async function findCachedImage(cacheDir: string, key: string): Promise<string | undefined> {
  for (const ext of Object.values(MIME_EXT)) {
    const candidate = resolve(cacheDir, `${key}.${ext}`);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // not this extension — try the next
    }
  }
  return undefined;
}

/**
 * Writes `image.bytes` to `<cacheDir>/<key>.<ext>` (mkdir -p first) and returns the
 * ABSOLUTE path so a Movie File In TOP can open it.
 */
export async function writeCachedImage(
  cacheDir: string,
  key: string,
  image: GeneratedImage,
): Promise<string> {
  await mkdir(cacheDir, { recursive: true });
  const absPath = resolve(cacheDir, `${key}.${extFromMime(image.mimeType)}`);
  await writeFile(absPath, image.bytes);
  return absPath;
}
