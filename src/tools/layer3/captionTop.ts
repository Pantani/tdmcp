import zlib from "node:zlib";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { capturePreview } from "../../feedback/previewCapture.js";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const captionTopSchema = z.object({
  node_path: z.string().describe("Path of the TOP to caption."),
  width: z.coerce
    .number()
    .int()
    .positive()
    .default(320)
    .describe("Width to render the preview at before describing it. Smaller is faster."),
  height: z.coerce
    .number()
    .int()
    .positive()
    .default(180)
    .describe("Height to render the preview at before describing it. Smaller is faster."),
  use_vision: z
    .boolean()
    .default(true)
    .describe(
      "Use the configured vision LLM endpoint when available; else fall back to a deterministic histogram description.",
    ),
});
type CaptionTopArgs = z.infer<typeof captionTopSchema>;

export const captionTopOutputSchema = z.object({
  node_path: z.string().describe("Echoed TOP path."),
  width: z.number().describe("Width the preview was rendered at."),
  height: z.number().describe("Height the preview was rendered at."),
  source: z
    .enum(["vision", "histogram"])
    .describe("Which describer produced the caption: a vision LLM or the deterministic histogram."),
  caption: z.string().describe("Plain-text description of what the TOP currently shows."),
  stats: z
    .object({
      mean_luma: z.number().describe("Mean perceptual luma across decoded pixels, 0..1."),
      mean_r: z.number().describe("Mean red channel, 0..1."),
      mean_g: z.number().describe("Mean green channel, 0..1."),
      mean_b: z.number().describe("Mean blue channel, 0..1."),
      near_black_fraction: z
        .number()
        .describe("Fraction of pixels whose luma is below the near-black threshold, 0..1."),
      saturation: z
        .number()
        .describe("Rough color spread (max-min channel mean), 0..1. High = colorful, ~0 = grey."),
      pixels_sampled: z.number().describe("Number of pixels the histogram was computed over."),
      classification: z
        .string()
        .describe("Coarse label: 'black' | 'very dark' | 'dark' | 'bright' | 'colorful' | 'mid'."),
      decoded: z
        .boolean()
        .describe(
          "True when real PNG pixels were decoded; false when stats fell back to a byte-histogram approximation.",
        ),
    })
    .describe("Deterministic image statistics computed from the preview PNG."),
  warnings: z
    .array(z.string())
    .describe("Non-fatal notes (e.g. vision skipped, approximate stats)."),
});

interface DecodedStats {
  mean_luma: number;
  mean_r: number;
  mean_g: number;
  mean_b: number;
  near_black_fraction: number;
  saturation: number;
  pixels_sampled: number;
  classification: string;
  decoded: boolean;
}

// ---------------------------------------------------------------------------
// Deterministic PNG histogram (dependency-free)
//
// pngjs is NOT a dependency of this repo, and the brief forbids adding one. The
// preview endpoint always returns an 8-bit PNG (format defaults to "png"), so we
// decode it ourselves with Node's built-in `zlib.inflateSync` plus the standard
// PNG un-filter step. This yields REAL pixel values (not raw compressed bytes),
// which keeps the histogram deterministic and meaningful. If anything about the
// PNG is unexpected (unsupported colour type / bit depth, truncated or undecodable
// data), we fall back to a byte-histogram over the decoded buffer and flag it via
// `decoded: false` + a warning, so a caller is never lied to.
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = "89504e470d0a1a0a";
const NEAR_BLACK_LUMA = 0.06;

function channelsForColorType(colorType: number): number | null {
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
      const left = x >= bpp ? (out[outRow + x - bpp] ?? 0) : 0;
      const up = y > 0 ? (out[prevRow + x] ?? 0) : 0;
      const upLeft = y > 0 && x >= bpp ? (out[prevRow + x - bpp] ?? 0) : 0;
      let recon: number;
      switch (filter) {
        case 0:
          recon = value;
          break;
        case 1:
          recon = value + left;
          break;
        case 2:
          recon = value + up;
          break;
        case 3:
          recon = value + ((left + up) >> 1);
          break;
        case 4:
          recon = value + paeth(left, up, upLeft);
          break;
        default:
          recon = value; // unknown filter — best effort
      }
      out[outRow + x] = recon & 0xff;
    }
  }
  return out;
}

function classify(meanLuma: number, nearBlackFraction: number, saturation: number): string {
  if (nearBlackFraction >= 0.995 || meanLuma < 0.01) return "black";
  if (meanLuma < 0.08) return "very dark";
  if (saturation >= 0.18) return "colorful";
  if (meanLuma >= 0.75) return "bright";
  if (meanLuma < 0.3) return "dark";
  return "mid";
}

/**
 * Decode an 8-bit PNG to per-channel/luma statistics. Returns `decoded: false`
 * stats (computed over the raw decompressed bytes) if the PNG cannot be decoded.
 */
function computeStats(png: Buffer, warnings: string[]): DecodedStats {
  const approximate = (reason: string): DecodedStats => {
    if (reason) warnings.push(reason);
    // Byte-histogram fallback: treat decoded bytes as luma samples in 0..255.
    let sum = 0;
    let nearBlack = 0;
    const n = png.length || 1;
    for (let i = 0; i < png.length; i++) {
      const v = (png[i] ?? 0) / 255;
      sum += v;
      if (v < NEAR_BLACK_LUMA) nearBlack++;
    }
    const mean = sum / n;
    return {
      mean_luma: mean,
      mean_r: mean,
      mean_g: mean,
      mean_b: mean,
      near_black_fraction: nearBlack / n,
      saturation: 0,
      pixels_sampled: png.length,
      classification: classify(mean, nearBlack / n, 0),
      decoded: false,
    };
  };

  try {
    if (png.length < 8 || png.subarray(0, 8).toString("hex") !== PNG_SIGNATURE) {
      return approximate("preview was not a PNG; stats are an approximate byte-histogram.");
    }
    let off = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    const idat: Buffer[] = [];
    while (off + 8 <= png.length) {
      const len = png.readUInt32BE(off);
      const type = png.toString("ascii", off + 4, off + 8);
      const dataStart = off + 8;
      const dataEnd = dataStart + len;
      if (dataEnd > png.length) break;
      const data = png.subarray(dataStart, dataEnd);
      if (type === "IHDR") {
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        bitDepth = data[8] ?? 0;
        colorType = data[9] ?? 0;
      } else if (type === "IDAT") {
        idat.push(Buffer.from(data));
      } else if (type === "IEND") {
        break;
      }
      off = dataEnd + 4; // skip the 4-byte CRC
    }

    if (bitDepth !== 8) {
      return approximate(
        `PNG bit depth ${bitDepth} unsupported; stats are an approximate byte-histogram.`,
      );
    }
    const channels = channelsForColorType(colorType);
    if (channels === null) {
      return approximate(
        `PNG colour type ${colorType} (palette) unsupported; stats are an approximate byte-histogram.`,
      );
    }
    if (width <= 0 || height <= 0 || idat.length === 0) {
      return approximate(
        "PNG had no decodable image data; stats are an approximate byte-histogram.",
      );
    }

    const raw = zlib.inflateSync(Buffer.concat(idat));
    const pixels = unfilter(raw, width, height, channels);

    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let sumLuma = 0;
    let nearBlack = 0;
    const total = width * height;
    for (let i = 0; i < total; i++) {
      const base = i * channels;
      let r: number;
      let g: number;
      let b: number;
      if (channels >= 3) {
        r = pixels[base] ?? 0;
        g = pixels[base + 1] ?? 0;
        b = pixels[base + 2] ?? 0;
      } else {
        // grayscale (channels 1 or 2): single luminance sample
        const lum = pixels[base] ?? 0;
        r = lum;
        g = lum;
        b = lum;
      }
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sumR += r;
      sumG += g;
      sumB += b;
      sumLuma += luma;
      if (luma / 255 < NEAR_BLACK_LUMA) nearBlack++;
    }
    const denom = total || 1;
    const meanR = sumR / denom / 255;
    const meanG = sumG / denom / 255;
    const meanB = sumB / denom / 255;
    const meanLuma = sumLuma / denom / 255;
    const saturation = Math.max(meanR, meanG, meanB) - Math.min(meanR, meanG, meanB);
    const nearBlackFraction = nearBlack / denom;
    return {
      mean_luma: meanLuma,
      mean_r: meanR,
      mean_g: meanG,
      mean_b: meanB,
      near_black_fraction: nearBlackFraction,
      saturation,
      pixels_sampled: total,
      classification: classify(meanLuma, nearBlackFraction, saturation),
      decoded: true,
    };
  } catch (err) {
    return approximate(
      `PNG decode failed (${
        err instanceof Error ? err.message : String(err)
      }); stats are an approximate byte-histogram.`,
    );
  }
}

function dominantColorPhrase(stats: DecodedStats): string {
  if (stats.saturation < 0.08) {
    return stats.mean_luma >= 0.5 ? "mostly light grey/white" : "mostly grey";
  }
  const channels: Array<[string, number]> = [
    ["red", stats.mean_r],
    ["green", stats.mean_g],
    ["blue", stats.mean_b],
  ];
  channels.sort((a, b) => b[1] - a[1]);
  const top = channels[0];
  const second = channels[1];
  if (top && second && top[1] - second[1] < 0.06) {
    return `${top[0]}/${second[0]} tones`;
  }
  return top ? `${top[0]}-dominant` : "mixed tones";
}

/** Build the deterministic, human-readable caption from the histogram stats. */
function histogramCaption(stats: DecodedStats): string {
  const luma = `mean luma ${stats.mean_luma.toFixed(2)}`;
  switch (stats.classification) {
    case "black":
      return `Output looks black (${luma}); the TOP appears to be rendering nothing.`;
    case "very dark":
      return `Very dark image (${luma}), ${dominantColorPhrase(stats)}; little is visible.`;
    case "dark":
      return `Dark image (${luma}), ${dominantColorPhrase(stats)}.`;
    case "bright":
      return `Bright image (${luma}), ${dominantColorPhrase(stats)}.`;
    case "colorful":
      return `Colorful image (${luma}), ${dominantColorPhrase(stats)}, saturation ${stats.saturation.toFixed(2)}.`;
    default:
      return `Mid-tone image (${luma}), ${dominantColorPhrase(stats)}.`;
  }
}

/**
 * Minimal, structural duck-type for an optional vision describer that a future
 * ToolContext might carry. The current ToolContext has NO such field, so this is
 * UNVERIFIED-live and always resolves to "no endpoint" today — the histogram is
 * the proven path. We probe rather than hardcode so wiring a real endpoint later
 * needs no change here.
 */
interface VisionLike {
  describeImage?: (input: { base64: string; mimeType: string; prompt?: string }) => Promise<string>;
}

function resolveVision(ctx: ToolContext): VisionLike | undefined {
  const loose = ctx as ToolContext & { vision?: VisionLike; llm?: VisionLike };
  if (loose.vision && typeof loose.vision.describeImage === "function") return loose.vision;
  if (loose.llm && typeof loose.llm.describeImage === "function") return loose.llm;
  return undefined;
}

interface CaptionReport {
  node_path: string;
  width: number;
  height: number;
  source: "vision" | "histogram";
  caption: string;
  stats: DecodedStats;
  warnings: string[];
}

export async function captionTopImpl(
  ctx: ToolContext,
  args: CaptionTopArgs,
): Promise<CallToolResult> {
  return guardTd<CaptionReport>(
    async () => {
      const preview = await capturePreview(ctx.client, args.node_path, args.width, args.height);
      const warnings: string[] = [];
      const png = Buffer.from(preview.base64, "base64");
      const stats = computeStats(png, warnings);

      let caption = histogramCaption(stats);
      let source: "vision" | "histogram" = "histogram";

      if (args.use_vision) {
        const vision = resolveVision(ctx);
        if (vision?.describeImage) {
          try {
            const visionCaption = await vision.describeImage({
              base64: preview.base64,
              mimeType: preview.mimeType,
              prompt: "Briefly describe what this TouchDesigner output shows.",
            });
            if (visionCaption && visionCaption.trim().length > 0) {
              caption = visionCaption.trim();
              source = "vision";
            } else {
              warnings.push("Vision endpoint returned an empty caption; used histogram instead.");
            }
          } catch (err) {
            warnings.push(
              `Vision endpoint failed (${
                err instanceof Error ? err.message : String(err)
              }); used histogram instead.`,
            );
          }
        } else {
          warnings.push("No vision endpoint configured; used deterministic histogram.");
        }
      }

      return {
        node_path: preview.path,
        width: preview.width,
        height: preview.height,
        source,
        caption,
        stats,
        warnings,
      };
    },
    (report) => jsonResult(`${report.node_path}: ${report.caption} [${report.source}]`, report),
  );
}

export const registerCaptionTop: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "caption_top",
    {
      title: "Caption a TOP (is the output alive?)",
      description:
        "Read-only: render a TOP's preview and return a plain-text description of it — the headless 'is the output alive?' primitive. Two paths: (a) a configured vision LLM endpoint when available, (b) a DETERMINISTIC luma/colour-histogram fallback decoded from the preview PNG pixels (always works, no model needed). Reports dominant colours, mean luma, near-black fraction, a coarse classification ('black'/'very dark'/'dark'/'bright'/'colorful'/'mid'), and a friendly caption. Returns {node_path, width, height, source:'vision'|'histogram', caption, stats{...}, warnings}. Use it after a build to confirm the network is actually rendering instead of a black frame. The vision path is currently inert (no vision field on the tool context) and falls back to the histogram.",
      inputSchema: captionTopSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => captionTopImpl(ctx, args),
  );
};
