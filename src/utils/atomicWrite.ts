import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Writes `data` to `target` atomically: first to a sibling tmp file, then renames
 * over the target. POSIX rename is atomic on the same filesystem, so a crashed or
 * cancelled process never leaves a half-written or zero-byte file at `target`.
 *
 * Used for artist-owned writes (vault notes, recipe bundles, manifest JSON) and
 * for state files (`packages/state.ts`) where a partial write would wedge the
 * next read.
 */
export function atomicWriteFileSync(
  target: string,
  data: string | NodeJS.ArrayBufferView,
  encoding?: BufferEncoding,
): void {
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  // Include pid so concurrent writers in the same dir don't collide on the tmp name.
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    if (typeof data === "string") {
      writeFileSync(tmp, data, encoding ?? "utf8");
    } else {
      writeFileSync(tmp, data);
    }
    renameSync(tmp, target);
  } catch (err) {
    // Best-effort cleanup; ignore if the tmp file never landed.
    try {
      rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
    throw err;
  }
}
