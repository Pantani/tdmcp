import type { TouchDesignerClient } from "../td-client/touchDesignerClient.js";
import { decodePngStats } from "./frameStats.js";
import { capturePreview } from "./previewCapture.js";

// ---------------------------------------------------------------------------
// `top_motion` fitness helper: capture a TOP twice, `frameGap` frames apart, and
// return the mean-luma delta between the two frames as a coarse motion magnitude.
//
// PROBE-FIRST (UNVERIFIED-live): on a paused timeline both captures are identical
// (delta ≈ 0), and pure spatial motion at constant mean luma is under-counted —
// this measures mean-luma change, not per-pixel optical flow. It must be proven to
// discriminate a moving output from a static one before being advertised.
// ---------------------------------------------------------------------------

export interface MotionResult {
  /** Mean-luma delta between the two captures, 0..1. */
  delta: number;
  warnings: string[];
}

const q = (value: string): string => JSON.stringify(value);

/** Advances the global timeline by `frameGap` frames and force-cooks the target. */
async function advanceFrames(
  client: TouchDesignerClient,
  path: string,
  frameGap: number,
  warnings: string[],
): Promise<void> {
  const step = Math.max(1, Math.floor(frameGap));
  try {
    await client.executePythonScript(
      `_t = op('/').time\n_t.frame = _t.frame + ${step}\nop(${q(path)}).cook(force=True)`,
      false,
    );
  } catch (err) {
    warnings.push(`Frame advance skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Capture `path` twice `frameGap` frames apart and return the mean-abs luma delta.
 * Fail-forward: an undecodable frame folds into a warning, never a throw.
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
  await advanceFrames(client, path, frameGap, warnings);
  const second = await capturePreview(client, path, width, height);
  const a = decodePngStats(Buffer.from(first.base64, "base64"));
  const b = decodePngStats(Buffer.from(second.base64, "base64"));
  if (!a.decoded || !b.decoded) {
    warnings.push("Motion capture could not decode one or both frames; delta may be approximate.");
  }
  return { delta: Math.abs(b.meanLuma - a.meanLuma), warnings };
}
