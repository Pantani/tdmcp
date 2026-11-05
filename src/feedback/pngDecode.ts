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

/** Decode bounds. Previews are small; anything past these is refused, not allocated. */
export const MAX_PNG_INPUT_BYTES = 64 * 1024 * 1024;
export const MAX_PNG_DIMENSION = 16_384;
export const MAX_PNG_DECODED_BYTES = 256 * 1024 * 1024;

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
      return value; // 0 (unknown filters are refused before un-filtering)
  }
}

/** Un-filter one scanline in place (kept separate to bound nesting depth). */
function unfilterRow(
  out: Buffer,
  raw: Buffer,
  rawStart: number,
  outRow: number,
  prevRow: number,
  filter: number,
  stride: number,
  bpp: number,
  hasPrev: boolean,
): void {
  for (let x = 0; x < stride; x++) {
    const value = raw[rawStart + x] ?? 0;
    const left = x >= bpp ? (out[outRow + x - bpp] ?? 0) : 0;
    const up = hasPrev ? (out[prevRow + x] ?? 0) : 0;
    const ul = hasPrev && x >= bpp ? (out[prevRow + x - bpp] ?? 0) : 0;
    out[outRow + x] = reconstruct(filter, value, left, up, ul) & 0xff;
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
    unfilterRow(out, raw, rawPos, outRow, outRow - stride, filter, stride, bpp, y > 0);
    rawPos += stride;
  }
  return out;
}

interface PngMeta {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
  idat: Buffer[];
}

/** Parse IHDR + concatenated IDAT chunks. Stops at IEND or on a truncated chunk. */
export function parsePngChunks(png: Buffer): PngMeta {
  const meta: PngMeta = { width: 0, height: 0, bitDepth: 0, colorType: 0, interlace: 0, idat: [] };
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
      meta.interlace = data[12] ?? 0;
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
  | { reason: "unsupported-interlace"; interlace: number }
  | { reason: "unsupported-filter"; filter: number }
  | { reason: "truncated"; expected: number; actual: number }
  | { reason: "too-large" }
  | { reason: "decode-error"; detail: string };

export type PngDecodeResult =
  | { ok: true; pixels: Buffer; width: number; height: number; channels: number }
  | ({ ok: false } & PngDecodeFailure);

/** Refuse anything this decoder cannot represent faithfully, before allocating. */
function headerFailure(meta: PngMeta, channels: number | null): PngDecodeFailure | undefined {
  if (meta.bitDepth !== 8) return { reason: "unsupported-bit-depth", bitDepth: meta.bitDepth };
  if (channels === null) return { reason: "unsupported-color-type", colorType: meta.colorType };
  if (meta.width <= 0 || meta.height <= 0 || meta.idat.length === 0) {
    return { reason: "no-image-data" };
  }
  if (meta.interlace !== 0) return { reason: "unsupported-interlace", interlace: meta.interlace };
  const oversized =
    meta.width > MAX_PNG_DIMENSION ||
    meta.height > MAX_PNG_DIMENSION ||
    (meta.width * channels + 1) * meta.height > MAX_PNG_DECODED_BYTES;
  return oversized ? { reason: "too-large" } : undefined;
}

/** First scanline whose filter byte is outside the five the PNG spec defines. */
function badFilter(raw: Buffer, stride: number, height: number): number | undefined {
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0;
    if (filter > 4) return filter;
  }
  return undefined;
}

function inflateScanlines(meta: PngMeta, channels: number): PngDecodeResult {
  const stride = meta.width * channels;
  const expected = (stride + 1) * meta.height;
  const raw = zlib.inflateSync(Buffer.concat(meta.idat), { maxOutputLength: expected });
  if (raw.length < expected) {
    return { ok: false, reason: "truncated", expected, actual: raw.length };
  }
  const filter = badFilter(raw, stride, meta.height);
  if (filter !== undefined) return { ok: false, reason: "unsupported-filter", filter };
  const pixels = unfilter(raw, meta.width, meta.height, channels);
  return { ok: true, pixels, width: meta.width, height: meta.height, channels };
}

/**
 * Decode an 8-bit PNG to raw pixel bytes. On any failure returns `ok: false` with a
 * machine-readable `reason` (plus the offending value) so callers craft their own
 * fallback and messaging.
 */
export function decodePngPixels(png: Buffer): PngDecodeResult {
  if (png.length < 8 || png.subarray(0, 8).toString("hex") !== PNG_SIGNATURE) {
    return { ok: false, reason: "not-png" };
  }
  if (png.length > MAX_PNG_INPUT_BYTES) return { ok: false, reason: "too-large" };
  try {
    const meta = parsePngChunks(png);
    const channels = channelsForColorType(meta.colorType);
    const failure = headerFailure(meta, channels);
    if (failure) return { ok: false, ...failure };
    return inflateScanlines(meta, channels as number);
  } catch (err) {
    return {
      ok: false,
      reason: "decode-error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
