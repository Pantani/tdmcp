import zlib from "node:zlib";

// ---------------------------------------------------------------------------
// Shared, dependency-free 8-bit PNG decode primitive.
//
// The preview endpoint always returns an 8-bit PNG. This module owns the low-level
// mechanics (signature check, chunk parse, zlib inflate, per-scanline un-filter)
// once, so both `frameStats.ts` (luma/saturation for evolve_parameters) and
// `captionTop.ts` (per-channel/near-black stats + captions) build their own pixel
// accumulation on top without duplicating the decoder.
//
// It returns a DISCRIMINATED result rather than throwing or returning null, so each
// caller can react to WHY a PNG was undecodable — `captionTop` maps the reason to a
// specific human warning, `frameStats` falls back to a byte-histogram. Callers that
// only need pixels ignore the reason.
// ---------------------------------------------------------------------------

export const PNG_SIGNATURE = "89504e470d0a1a0a";

/** Channels per pixel for a PNG colour type, or null for unsupported (palette). */
export function channelsForColorType(colorType: number): number | null {
  // 0 grayscale, 2 truecolor, 3 indexed, 4 grayscale+alpha, 6 truecolor+alpha
  switch (colorType) {
    case 0:
      return 1;
    case 2:
      return 3;
    case 4:
      return 2;
    case 6:
      return 4;
    default:
      return null; // indexed (palette) needs the PLTE chunk — not handled here
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function reconstruct(filter: number, value: number, left: number, up: number, ul: number): number {
  switch (filter) {
    case 1:
      return value + left;
    case 2:
      return value + up;
    case 3:
      return value + ((left + up) >> 1);
    case 4:
      return value + paeth(left, up, ul);
    default:
      return value; // 0 or unknown filter — best effort
  }
}

/** Reverse the per-scanline PNG filters, returning the unfiltered pixel bytes. */
export function unfilter(raw: Buffer, width: number, height: number, bpp: number): Buffer {
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let rawPos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rawPos++] ?? 0;
    const outRow = y * stride;
    const prevRow = outRow - stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[rawPos++] ?? 0;
      const left = x >= bpp ? (out[outRow + x - bpp] ?? 0) : 0;
      const up = y > 0 ? (out[prevRow + x] ?? 0) : 0;
      const ul = y > 0 && x >= bpp ? (out[prevRow + x - bpp] ?? 0) : 0;
      out[outRow + x] = reconstruct(filter, value, left, up, ul) & 0xff;
    }
  }
  return out;
}

interface PngMeta {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  idat: Buffer[];
}

/** Parse IHDR + concatenated IDAT chunks. Stops at IEND or on a truncated chunk. */
export function parsePngChunks(png: Buffer): PngMeta {
  const meta: PngMeta = { width: 0, height: 0, bitDepth: 0, colorType: 0, idat: [] };
  let off = 8;
  while (off + 8 <= png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString("ascii", off + 4, off + 8);
    const dataEnd = off + 8 + len;
    if (dataEnd > png.length) break;
    const data = png.subarray(off + 8, dataEnd);
    if (type === "IHDR") {
      meta.width = data.readUInt32BE(0);
      meta.height = data.readUInt32BE(4);
      meta.bitDepth = data[8] ?? 0;
      meta.colorType = data[9] ?? 0;
    } else if (type === "IDAT") {
      meta.idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    off = dataEnd + 4; // skip the 4-byte CRC
  }
  return meta;
}

export type PngDecodeFailure =
  | { reason: "not-png" }
  | { reason: "unsupported-bit-depth"; bitDepth: number }
  | { reason: "unsupported-color-type"; colorType: number }
  | { reason: "no-image-data" }
  | { reason: "decode-error"; detail: string };

export type PngDecodeResult =
  | { ok: true; pixels: Buffer; width: number; height: number; channels: number }
  | ({ ok: false } & PngDecodeFailure);

/**
 * Decode an 8-bit PNG to raw pixel bytes. On any failure returns `ok: false` with a
 * machine-readable `reason` (plus the offending value) so callers craft their own
 * fallback and messaging.
 */
export function decodePngPixels(png: Buffer): PngDecodeResult {
  if (png.length < 8 || png.subarray(0, 8).toString("hex") !== PNG_SIGNATURE) {
    return { ok: false, reason: "not-png" };
  }
  try {
    const meta = parsePngChunks(png);
    if (meta.bitDepth !== 8) {
      return { ok: false, reason: "unsupported-bit-depth", bitDepth: meta.bitDepth };
    }
    const channels = channelsForColorType(meta.colorType);
    if (channels === null) {
      return { ok: false, reason: "unsupported-color-type", colorType: meta.colorType };
    }
    if (meta.width <= 0 || meta.height <= 0 || meta.idat.length === 0) {
      return { ok: false, reason: "no-image-data" };
    }
    const raw = zlib.inflateSync(Buffer.concat(meta.idat));
    const pixels = unfilter(raw, meta.width, meta.height, channels);
    return { ok: true, pixels, width: meta.width, height: meta.height, channels };
  } catch (err) {
    return {
      ok: false,
      reason: "decode-error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
