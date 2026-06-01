import zlib from "node:zlib";
import { z } from "zod";
import { capturePreview } from "../../feedback/previewCapture.js";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

/**
 * `extract_palette` — sample dominant colors from a TOP via the existing preview
 * endpoint (already returns an 8-bit PNG), decode pixels, and run k-means on the
 * RGB samples to yield a K-color palette. Pure Node post-processing — no Python
 * bridge round-trip required beyond `capturePreview`. Returns hex + 0..255 RGB
 * triples plus per-cluster pixel weight.
 */

export const extractPaletteSchema = z.object({
  source_top: z.string().describe("Path of the TOP to sample colors from."),
  k: z.coerce
    .number()
    .int()
    .min(2)
    .max(16)
    .default(5)
    .describe("Number of palette colors to extract (2..16)."),
  width: z.coerce
    .number()
    .int()
    .positive()
    .max(512)
    .default(128)
    .describe("Width to render the preview at before sampling (smaller is faster)."),
  height: z.coerce
    .number()
    .int()
    .positive()
    .max(512)
    .default(72)
    .describe("Height to render the preview at before sampling."),
});
export type ExtractPaletteArgs = z.infer<typeof extractPaletteSchema>;

const PNG_SIG = "89504e470d0a1a0a";

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilter(raw: Buffer, width: number, height: number, bpp: number): Buffer {
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++] ?? 0;
    const outRow = y * stride;
    const prevRow = outRow - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[p++] ?? 0;
      const left = x >= bpp ? (out[outRow + x - bpp] ?? 0) : 0;
      const up = y > 0 ? (out[prevRow + x] ?? 0) : 0;
      const ul = y > 0 && x >= bpp ? (out[prevRow + x - bpp] ?? 0) : 0;
      let r: number;
      switch (filter) {
        case 1:
          r = v + left;
          break;
        case 2:
          r = v + up;
          break;
        case 3:
          r = v + ((left + up) >> 1);
          break;
        case 4:
          r = v + paeth(left, up, ul);
          break;
        default:
          r = v;
      }
      out[outRow + x] = r & 0xff;
    }
  }
  return out;
}

function decodePngRgb(
  png: Buffer,
): { width: number; height: number; pixels: Buffer; channels: number } | null {
  // Wrap the entire chunk-walk in a try/catch: malformed-but-PNG-signature inputs
  // can produce out-of-bounds reads (e.g. a truncated IHDR whose declared length
  // is < 13 bytes makes readUInt32BE(4) throw). Any decode failure should fall
  // back to the byte-histogram path, never crash the tool.
  try {
    if (png.length < 8 || png.subarray(0, 8).toString("hex") !== PNG_SIG) return null;
    let off = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    const idat: Buffer[] = [];
    while (off + 8 <= png.length) {
      const len = png.readUInt32BE(off);
      const type = png.toString("ascii", off + 4, off + 8);
      const start = off + 8;
      const end = start + len;
      if (end > png.length) break;
      const data = png.subarray(start, end);
      if (type === "IHDR") {
        // IHDR is exactly 13 bytes; reject anything shorter so readUInt32BE
        // and the bit-depth/colour-type reads can't throw or silently zero.
        if (data.length < 13) return null;
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        bitDepth = data[8] ?? 0;
        colorType = data[9] ?? 0;
      } else if (type === "IDAT") {
        idat.push(Buffer.from(data));
      } else if (type === "IEND") {
        break;
      }
      off = end + 4;
    }
    if (bitDepth !== 8 || width <= 0 || height <= 0 || idat.length === 0) return null;
    let channels: number;
    switch (colorType) {
      case 0:
        channels = 1;
        break;
      case 2:
        channels = 3;
        break;
      case 4:
        channels = 2;
        break;
      case 6:
        channels = 4;
        break;
      default:
        return null;
    }
    try {
      const raw = zlib.inflateSync(Buffer.concat(idat));
      const pixels = unfilter(raw, width, height, channels);
      return { width, height, pixels, channels };
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

function toHex(r: number, g: number, b: number): string {
  const h = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Deterministic k-means (k=K) over RGB samples; seeded by evenly-spaced indices. */
function kmeans(
  samples: Array<[number, number, number]>,
  k: number,
): Array<{ rgb: [number, number, number]; weight: number }> {
  if (samples.length === 0) return [];
  const effectiveK = Math.min(k, samples.length);
  // Seed: evenly spaced indices for determinism.
  const centroids: Array<[number, number, number]> = [];
  for (let i = 0; i < effectiveK; i++) {
    const idx = Math.floor((i * samples.length) / effectiveK);
    const s = samples[idx] ?? [0, 0, 0];
    centroids.push([s[0], s[1], s[2]]);
  }
  const assign = new Array<number>(samples.length).fill(0);
  for (let iter = 0; iter < 12; iter++) {
    let changed = false;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      if (!s) continue;
      let best = 0;
      let bestD = Number.POSITIVE_INFINITY;
      for (let c = 0; c < centroids.length; c++) {
        const ct = centroids[c];
        if (!ct) continue;
        const dr = s[0] - ct[0];
        const dg = s[1] - ct[1];
        const db = s[2] - ct[2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (assign[i] !== best) {
        assign[i] = best;
        changed = true;
      }
    }
    const sums = centroids.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const a = assign[i];
      if (!s || a === undefined) continue;
      const slot = sums[a];
      if (!slot) continue;
      slot[0] = (slot[0] ?? 0) + s[0];
      slot[1] = (slot[1] ?? 0) + s[1];
      slot[2] = (slot[2] ?? 0) + s[2];
      slot[3] = (slot[3] ?? 0) + 1;
    }
    for (let c = 0; c < centroids.length; c++) {
      const slot = sums[c];
      if (!slot || (slot[3] ?? 0) === 0) continue;
      centroids[c] = [
        (slot[0] ?? 0) / (slot[3] ?? 1),
        (slot[1] ?? 0) / (slot[3] ?? 1),
        (slot[2] ?? 0) / (slot[3] ?? 1),
      ];
    }
    if (!changed) break;
  }
  // Tally per-centroid weights.
  const weights = new Array<number>(centroids.length).fill(0);
  for (let i = 0; i < samples.length; i++) {
    const a = assign[i];
    if (a === undefined) continue;
    weights[a] = (weights[a] ?? 0) + 1;
  }
  const out: Array<{ rgb: [number, number, number]; weight: number }> = [];
  for (let c = 0; c < centroids.length; c++) {
    const ct = centroids[c];
    if (!ct) continue;
    out.push({ rgb: ct, weight: (weights[c] ?? 0) / samples.length });
  }
  // Sort descending by weight (most-dominant first).
  out.sort((a, b) => b.weight - a.weight);
  return out;
}

interface PaletteReport {
  source_top: string;
  k: number;
  width: number;
  height: number;
  pixels_sampled: number;
  hex_colors: string[];
  swatches: Array<{ hex: string; rgb: [number, number, number]; weight: number }>;
  warnings: string[];
}

export async function extractPaletteImpl(ctx: ToolContext, args: ExtractPaletteArgs) {
  return guardTd<PaletteReport>(
    async () => {
      const preview = await capturePreview(ctx.client, args.source_top, args.width, args.height);
      const warnings: string[] = [];
      const png = Buffer.from(preview.base64, "base64");
      const decoded = decodePngRgb(png);
      const samples: Array<[number, number, number]> = [];
      if (!decoded) {
        warnings.push(
          "Could not decode the preview PNG; palette is computed from a byte-histogram (approximate).",
        );
        // Approximate: treat triples of bytes as RGB samples.
        for (let i = 0; i + 2 < png.length; i += 3) {
          samples.push([png[i] ?? 0, png[i + 1] ?? 0, png[i + 2] ?? 0]);
          if (samples.length > 4096) break;
        }
      } else {
        const { width, height, pixels, channels } = decoded;
        const total = width * height;
        // Subsample to a cap to keep k-means fast.
        const cap = 4096;
        const stride = Math.max(1, Math.floor(total / cap));
        for (let i = 0; i < total; i += stride) {
          const base = i * channels;
          let r: number;
          let g: number;
          let b: number;
          if (channels >= 3) {
            r = pixels[base] ?? 0;
            g = pixels[base + 1] ?? 0;
            b = pixels[base + 2] ?? 0;
          } else {
            const lum = pixels[base] ?? 0;
            r = lum;
            g = lum;
            b = lum;
          }
          samples.push([r, g, b]);
        }
      }
      const clusters = kmeans(samples, args.k);
      const swatches = clusters.map((c) => ({
        hex: toHex(c.rgb[0], c.rgb[1], c.rgb[2]),
        rgb: [Math.round(c.rgb[0]), Math.round(c.rgb[1]), Math.round(c.rgb[2])] as [
          number,
          number,
          number,
        ],
        weight: c.weight,
      }));
      return {
        source_top: preview.path,
        k: args.k,
        width: preview.width,
        height: preview.height,
        pixels_sampled: samples.length,
        hex_colors: swatches.map((s) => s.hex),
        swatches,
        warnings,
      };
    },
    (report) =>
      jsonResult(
        `Extracted ${report.swatches.length}-color palette from ${report.source_top}: ${report.hex_colors.join(", ")}.`,
        report,
      ),
  );
}

export const registerExtractPalette: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "extract_palette",
    {
      title: "Extract a K-color palette from a TOP",
      description:
        "Sample dominant colors from a TOP by capturing its preview PNG and running deterministic k-means on the decoded RGB pixels. Returns `{source_top, k, width, height, pixels_sampled, hex_colors[], swatches[{hex,rgb,weight}], warnings[]}` sorted by dominance (most-frequent cluster first). Feeds AI grading prompts, `create_palette`, and design hand-offs. Read-only; no nodes are created or modified.",
      inputSchema: extractPaletteSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => extractPaletteImpl(ctx, args),
  );
};
