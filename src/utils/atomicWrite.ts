import { chmodSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Writes `data` to `target` atomically: first to a sibling tmp file, then renames
 * over the target. POSIX rename is atomic on the same filesystem, so a crashed or
 * cancelled process never leaves a half-written or zero-byte file at `target`.
 *
 * If `target` already exists, its file mode (e.g. `0600` for a credentials note)
 * is preserved on the replacement — the tmp file is created with the process
 * umask and then `chmod`-ed to match the original before the rename, so a
 * restrictive mode set by the user is not silently widened by every write.
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
  // Stat the target BEFORE we write so we can preserve its existing mode.
  // First-write targets have no prior mode — let the umask decide.
  let existingMode: number | undefined;
  try {
    existingMode = statSync(target).mode & 0o777;
  } catch {
    // Target absent — no prior mode to preserve.
  }
  // Include pid so concurrent writers in the same dir don't collide on the tmp name.
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    if (typeof data === "string") {
      writeFileSync(tmp, data, encoding ?? "utf8");
    } else {
      writeFileSync(tmp, data);
    }
    if (existingMode !== undefined) {
      // Best-effort; on Windows chmod is largely a no-op and that's fine.
      try {
        chmodSync(tmp, existingMode);
      } catch {
        // Ignore — losing a mode bit on an exotic FS is preferable to failing the write.
      }
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
