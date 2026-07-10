import zlib from "node:zlib";

// ---------------------------------------------------------------------------
// Standalone, dependency-free PNG → luma/saturation decoder.
//
// The preview endpoint always returns an 8-bit PNG, decoded here with Node's
// built-in zlib plus the standard PNG un-filter step to yield REAL pixel values.
// Anything unexpected (unsupported colour type / bit depth, truncated or
// undecodable data) falls back to a byte-histogram over the buffer and is flagged
// via `decoded: false`, so a caller is never lied to.
//
// This is a self-contained copy of captionTop.ts's `computeStats` luma/saturation
// core (intentionally NOT importing it, to keep the evolve_parameters build fully
// isolated from shared files). An integrator may DRY the two later.
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = "89504e470d0a1a0a";

export interface FrameStats {
  /** Mean perceptual luma across decoded pixels, 0..1. */
  meanLuma: number;
  /** Rough colour spread (max-min channel mean), 0..1. High = colorful, ~0 = grey. */
  saturation: number;
  /** True when real PNG pixels were decoded; false on the byte-histogram fallback. */
  decoded: boolean;
}

function channelsForColorType(colorType: number): number | null {
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
      return value;
  }
}

const at = (buf: Buffer, i: number): number => buf[i] ?? 0;

/** Reverse the per-scanline PNG filters, returning the unfiltered pixel bytes. */
function unfilter(raw: Buffer, width: number, height: number, bpp: number): Buffer {
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let rawPos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rawPos++] ?? 0;
    const outRow = y * stride;
    const prevRow = outRow - stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[rawPos++] ?? 0;
      const left = x >= bpp ? at(out, outRow + x - bpp) : 0;
      const up = y > 0 ? at(out, prevRow + x) : 0;
      const ul = y > 0 && x >= bpp ? at(out, prevRow + x - bpp) : 0;
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

function parseChunks(png: Buffer): PngMeta {
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
  try {
    if (png.length < 8 || png.subarray(0, 8).toString("hex") !== PNG_SIGNATURE) {
      return byteHistogram(png);
    }
    const meta = parseChunks(png);
    const channels = channelsForColorType(meta.colorType);
    if (meta.bitDepth !== 8 || channels === null) return byteHistogram(png);
    if (meta.width <= 0 || meta.height <= 0 || meta.idat.length === 0) return byteHistogram(png);
    const raw = zlib.inflateSync(Buffer.concat(meta.idat));
    const pixels = unfilter(raw, meta.width, meta.height, channels);
    return pixelStats(pixels, meta.width * meta.height, channels);
  } catch {
    return byteHistogram(png);
  }
}
