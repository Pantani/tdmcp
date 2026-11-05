import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { VideoGenRequest, VideoGenResult } from "./types.js";

/**
 * Filesystem cache for generated clips. The generation helper writes each clip
 * here BEFORE any TD call, then points a `moviefileinTOP` at the returned path.
 *
 * Hard requirement: {@link writeCachedVideo} returns an ABSOLUTE path via
 * `path.resolve` — a relative path does NOT open in a Movie File In TOP.
 * No eviction in v1: the dir is user-clearable (mirrors the image lane).
 */

/** Known clip mime types → file extension. */
const MIME_EXT: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
};

function extFromMime(mime: string): string {
  return MIME_EXT[mime] ?? "mp4";
}

/**
 * Deterministic cache key: sha256 hex of the generation-defining fields. Excludes
 * mime type (a hit reuses whatever extension is on disk) so the same request always
 * maps to one key regardless of output container.
 */
export function videoCacheKey(req: VideoGenRequest, providerId: string, model: string): string {
  const payload = JSON.stringify({
    providerId,
    model,
    prompt: req.prompt,
    negativePrompt: req.negativePrompt,
    initImagePath: req.initImagePath,
    durationSeconds: req.durationSeconds,
    width: req.width,
    height: req.height,
    guidanceScale: req.guidanceScale,
    numInferenceSteps: req.numInferenceSteps,
    seed: req.seed,
  });
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Returns the absolute path of a previously cached clip for `key`, or `undefined`
 * on a miss. Probes the known extensions since the key omits mime type.
 */
export async function findCachedVideo(cacheDir: string, key: string): Promise<string | undefined> {
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
 * Writes `video.bytes` to `<cacheDir>/<key>.<ext>` (mkdir -p first) and returns the
 * ABSOLUTE path so a Movie File In TOP can open it.
 */
export async function writeCachedVideo(
  cacheDir: string,
  key: string,
  video: VideoGenResult,
): Promise<string> {
  await mkdir(cacheDir, { recursive: true });
  const absPath = resolve(cacheDir, `${key}.${extFromMime(video.mimeType)}`);
  await writeFile(absPath, video.bytes);
  return absPath;
}
