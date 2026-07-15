import { decodePngPixels } from "./pngDecode.js";

// ---------------------------------------------------------------------------
// PNG → luma/saturation stats for the evolve_parameters fitness read-back.
//
// The low-level 8-bit PNG decode lives in `pngDecode.ts` (shared with captionTop);
// this module only accumulates luma/saturation over the decoded pixels, and falls
// back to a byte-histogram (`decoded: false`) whenever the PNG cannot be decoded, so
// a caller is never lied to.
// ---------------------------------------------------------------------------

export interface FrameStats {
  /** Mean perceptual luma across decoded pixels, 0..1. */
  meanLuma: number;
  /** Rough colour spread (max-min channel mean), 0..1. High = colorful, ~0 = grey. */
  saturation: number;
  /** True when real PNG pixels were decoded; false on the byte-histogram fallback. */
  decoded: boolean;
}

function pixelStats(pixels: Buffer, total: number, channels: number): FrameStats {
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumLuma = 0;
  for (let i = 0; i < total; i++) {
    const base = i * channels;
    const first = pixels[base] ?? 0;
    const r = first;
    const g = channels >= 3 ? (pixels[base + 1] ?? 0) : first;
    const b = channels >= 3 ? (pixels[base + 2] ?? 0) : first;
    sumR += r;
    sumG += g;
    sumB += b;
    sumLuma += 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const denom = total || 1;
  const meanR = sumR / denom / 255;
  const meanG = sumG / denom / 255;
  const meanB = sumB / denom / 255;
  return {
    meanLuma: sumLuma / denom / 255,
    saturation: Math.max(meanR, meanG, meanB) - Math.min(meanR, meanG, meanB),
    decoded: true,
  };
}

function byteHistogram(png: Buffer): FrameStats {
  let sum = 0;
  const n = png.length || 1;
  for (let i = 0; i < png.length; i++) sum += (png[i] ?? 0) / 255;
  return { meanLuma: sum / n, saturation: 0, decoded: false };
}

/**
 * Decode an 8-bit PNG to `{ meanLuma, saturation, decoded }`. Falls back to a
 * byte-histogram (`decoded: false`) whenever the PNG cannot be decoded.
 */
export function decodePngStats(png: Buffer): FrameStats {
  const decoded = decodePngPixels(png);
  if (!decoded.ok) return byteHistogram(png);
  return pixelStats(decoded.pixels, decoded.width * decoded.height, decoded.channels);
}
