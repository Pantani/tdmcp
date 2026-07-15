import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodePngStats } from "../../src/feedback/frameStats.js";
import { channelsForColorType, decodePngPixels, unfilter } from "../../src/feedback/pngDecode.js";

const SIG = Buffer.from("89504e470d0a1a0a", "hex");

/**
 * Build a minimal, CRC-agnostic PNG (parsePngChunks skips CRCs). `rows` is one
 * entry per scanline: `[filterByte, ...unfilteredPixelBytes]` — we re-apply the
 * chosen filter forward so the decoder's reverse step is exercised per filter type.
 */
function makePng(opts: {
  width: number;
  height: number;
  colorType: number;
  bitDepth?: number;
  rows: number[][];
  corruptIdat?: boolean;
}): Buffer {
  const bitDepth = opts.bitDepth ?? 8;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(opts.width, 0);
  ihdr.writeUInt32BE(opts.height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = opts.colorType;
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    return Buffer.concat([len, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]); // 4 dummy CRC bytes
  };
  const scanlines = Buffer.concat(opts.rows.map((r) => Buffer.from(r)));
  const idatData = opts.corruptIdat ? Buffer.from([1, 2, 3, 4]) : zlib.deflateSync(scanlines);
  return Buffer.concat([
    SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", idatData),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("channelsForColorType", () => {
  it("maps every supported colour type and rejects palette", () => {
    expect(channelsForColorType(0)).toBe(1);
    expect(channelsForColorType(2)).toBe(3);
    expect(channelsForColorType(4)).toBe(2);
    expect(channelsForColorType(6)).toBe(4);
    expect(channelsForColorType(3)).toBeNull(); // indexed/palette
  });
});

describe("decodePngPixels failure reasons", () => {
  it("flags a buffer without the PNG signature", () => {
    const r = decodePngPixels(Buffer.from([1, 2, 3]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not-png");
  });

  it("flags an unsupported bit depth", () => {
    const r = decodePngPixels(
      makePng({ width: 1, height: 1, colorType: 2, bitDepth: 16, rows: [[0, 0, 0, 0]] }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "unsupported-bit-depth") expect(r.bitDepth).toBe(16);
    else throw new Error("expected unsupported-bit-depth");
  });

  it("flags an unsupported (palette) colour type", () => {
    const r = decodePngPixels(makePng({ width: 1, height: 1, colorType: 3, rows: [[0, 0]] }));
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "unsupported-color-type") expect(r.colorType).toBe(3);
    else throw new Error("expected unsupported-color-type");
  });

  it("flags zero-dimension / missing image data", () => {
    const r = decodePngPixels(makePng({ width: 0, height: 0, colorType: 2, rows: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no-image-data");
  });

  it("flags a decode error when IDAT is not inflatable", () => {
    const r = decodePngPixels(
      makePng({ width: 1, height: 1, colorType: 2, rows: [[0, 9, 9, 9]], corruptIdat: true }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "decode-error") expect(r.detail.length).toBeGreaterThan(0);
    else throw new Error("expected decode-error");
  });
});

describe("decodePngPixels reverses every scanline filter", () => {
  it("decodes an RGB image using filters 0..4 across rows", () => {
    // width 2, rgb → bpp 3, stride 6. One row per filter byte 0..4.
    const rows = [
      [0, 10, 20, 30, 40, 50, 60],
      [1, 1, 1, 1, 1, 1, 1],
      [2, 2, 2, 2, 2, 2, 2],
      [3, 3, 3, 3, 3, 3, 3],
      [4, 4, 4, 4, 4, 4, 4],
    ];
    const r = decodePngPixels(makePng({ width: 2, height: 5, colorType: 2, rows }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.channels).toBe(3);
      expect(r.width).toBe(2);
      expect(r.height).toBe(5);
      expect(r.pixels.length).toBe(2 * 5 * 3);
    }
  });

  it("decodes a grayscale image (channels=1)", () => {
    const r = decodePngPixels(
      makePng({ width: 2, height: 1, colorType: 0, rows: [[0, 100, 200]] }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.channels).toBe(1);
  });
});

describe("unfilter", () => {
  it("returns a zero-length buffer for an empty image", () => {
    expect(unfilter(Buffer.alloc(0), 0, 0, 3).length).toBe(0);
  });
});

describe("decodePngStats (frameStats over the shared decoder)", () => {
  it("computes real luma/saturation for a decoded RGB image", () => {
    const stats = decodePngStats(
      makePng({ width: 1, height: 1, colorType: 2, rows: [[0, 255, 0, 0]] }),
    );
    expect(stats.decoded).toBe(true);
    expect(stats.saturation).toBeGreaterThan(0); // pure red → colour spread
    expect(stats.meanLuma).toBeGreaterThan(0);
  });

  it("collapses a grayscale image to zero saturation", () => {
    const stats = decodePngStats(
      makePng({ width: 2, height: 1, colorType: 0, rows: [[0, 128, 128]] }),
    );
    expect(stats.decoded).toBe(true);
    expect(stats.saturation).toBe(0);
  });

  it("falls back to a byte-histogram (decoded:false) on a non-PNG buffer", () => {
    const stats = decodePngStats(Buffer.from([0, 128, 255]));
    expect(stats.decoded).toBe(false);
    expect(stats.saturation).toBe(0);
    expect(stats.meanLuma).toBeGreaterThan(0);
  });
});
