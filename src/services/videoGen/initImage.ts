import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";

/**
 * Trust boundary for `init_image`. The path comes from the MCP caller (ultimately an
 * LLM that may be reading untrusted content) and the file is uploaded to the selected
 * provider, so an unchecked path would let a prompt injection exfiltrate any local
 * file. Only a real image file may cross: symlinks are resolved first, then the
 * extension, size and magic bytes must all agree.
 */

export const MAX_INIT_IMAGE_BYTES = 32 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export type InitImageResult =
  | {
      ok: true;
      /** Symlink-free absolute path to hand to the provider. */
      path: string;
      /** sha256 of the file contents; part of the clip cache key. */
      digest: string;
    }
  | { ok: false; reason: string };

function hasImageSignature(bytes: Buffer): boolean {
  const isPng = bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
  const isJpeg = bytes.subarray(0, 3).toString("hex") === "ffd8ff";
  const isWebp =
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP";
  return isPng || isJpeg || isWebp;
}

async function inspect(path: string): Promise<InitImageResult> {
  const real = await realpath(path);
  if (!IMAGE_EXTENSIONS.has(extname(real).toLowerCase())) {
    return { ok: false, reason: "init_image must be a .png, .jpg, .jpeg or .webp file" };
  }
  const info = await stat(real);
  if (!info.isFile()) return { ok: false, reason: "init_image is not a regular file" };
  if (info.size > MAX_INIT_IMAGE_BYTES) {
    return { ok: false, reason: "init_image is larger than the 32 MiB limit" };
  }
  const bytes = await readFile(real);
  if (!hasImageSignature(bytes)) {
    return { ok: false, reason: "init_image contents are not a PNG, JPEG or WebP image" };
  }
  return { ok: true, path: real, digest: createHash("sha256").update(bytes).digest("hex") };
}

/** Validate `init_image` before anything is uploaded. Never throws. */
export async function loadInitImage(path: string): Promise<InitImageResult> {
  if (!isAbsolute(path)) return { ok: false, reason: "init_image must be an absolute path" };
  try {
    return await inspect(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown error";
    return { ok: false, reason: `init_image could not be read (${code})` };
  }
}
