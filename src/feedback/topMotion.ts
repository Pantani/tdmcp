import type { TouchDesignerClient } from "../td-client/touchDesignerClient.js";
import { decodePngPixels, type PngDecodeResult } from "./pngDecode.js";
import { capturePreview } from "./previewCapture.js";

// ---------------------------------------------------------------------------
// `top_motion` fitness helper: capture a TOP twice, `frameGap` frames apart, and
// return the mean per-pixel luma difference between the two frames as a coarse motion
// magnitude, so spatial motion at constant mean luma still scores.
//
// PROBE-FIRST (UNVERIFIED-live): this is frame differencing, not optical flow. It must
// be proven to discriminate a moving output from a static one before being advertised.
// ---------------------------------------------------------------------------

export interface MotionResult {
  /** Mean per-pixel luma difference, 0..1; null when motion could not be measured. */
  delta: number | null;
  warnings: string[];
}

const q = (value: string): string => JSON.stringify(value);

/** Advances the global timeline by `frameGap` frames and force-cooks the target. */
async function advanceFrames(
  client: TouchDesignerClient,
  path: string,
  frameGap: number,
  warnings: string[],
): Promise<boolean> {
  const step = Math.max(1, Math.floor(frameGap));
  try {
    await client.executePythonScript(
      `_t = op('/').time\n_t.frame = _t.frame + ${step}\nop(${q(path)}).cook(force=True)`,
      false,
    );
    return true;
  } catch (err) {
    warnings.push(`Frame advance failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function lumaAt(frame: Buffer, pixel: number, channels: number): number {
  const base = pixel * channels;
  const first = frame[base] ?? 0;
  if (channels < 3) return first;
  return 0.2126 * first + 0.7152 * (frame[base + 1] ?? 0) + 0.0722 * (frame[base + 2] ?? 0);
}

/** Mean per-pixel luma difference, 0..1; null if either frame is unusable or sizes differ. */
export function frameDifference(a: PngDecodeResult, b: PngDecodeResult): number | null {
  if (!a.ok || !b.ok || a.width !== b.width || a.height !== b.height) return null;
  const total = a.width * a.height;
  let sum = 0;
  for (let i = 0; i < total; i++) {
    sum += Math.abs(lumaAt(a.pixels, i, a.channels) - lumaAt(b.pixels, i, b.channels));
  }
  return sum / total / 255;
}

/**
 * Capture `path` twice `frameGap` frames apart and return the mean per-pixel difference.
 * Fail-forward: a failed frame advance or undecodable frame yields `delta: null` plus a
 * warning, so a caller never scores compressed bytes or an un-advanced timeline.
 */
export async function topMotion(
  client: TouchDesignerClient,
  path: string,
  frameGap: number,
  width = 320,
  height = 180,
): Promise<MotionResult> {
  const warnings: string[] = [];
  const first = await capturePreview(client, path, width, height);
  const advanced = await advanceFrames(client, path, frameGap, warnings);
  if (!advanced) return { delta: null, warnings };
  const second = await capturePreview(client, path, width, height);
  const delta = frameDifference(
    decodePngPixels(Buffer.from(first.base64, "base64")),
    decodePngPixels(Buffer.from(second.base64, "base64")),
  );
  if (delta === null) warnings.push("Motion capture could not decode or compare both frames.");
  return { delta, warnings };
}
