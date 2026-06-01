import { inflateSync } from "node:zlib";
import { z } from "zod";
import { checkPerformance } from "../../feedback/performanceMonitor.js";
import { LLM_SYSTEM_OPTION } from "../../llm/client.js";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const scoreBuildSchema = z.object({
  scopePath: z
    .string()
    .default("/project1")
    .describe("Network root to score. Defaults to /project1."),
  criteria: z
    .array(z.enum(["palette", "motion", "complexity", "errors", "perf"]))
    .default(["palette", "motion", "complexity", "errors", "perf"])
    .describe(
      "Subset of rubric criteria to evaluate. Final score is the equal-weight mean of the selected ones.",
    ),
  targetFps: z
    .number()
    .positive()
    .default(60)
    .describe("FPS target used to derive the perf budget (same semantics as get_td_performance)."),
  llmCritique: z
    .boolean()
    .default(false)
    .describe(
      "When true and ctx.llm is configured, attach a short paragraph of artist-readable critique. Best-effort: LLM failure never fails the tool.",
    ),
  previewTopPath: z
    .string()
    .optional()
    .describe(
      "Override the TOP sampled for palette/motion. Defaults to the first /scopePath/out* TOP, then any /scopePath/*_out TOP.",
    ),
});
type ScoreBuildArgs = z.infer<typeof scoreBuildSchema>;

export const scoreBuildOutputSchema = z.object({
  scopePath: z.string(),
  final: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe("Equal-weight mean of returned per-criterion scores, rounded."),
  perCriterion: z
    .object({
      palette: z.number().int().min(0).max(100).optional(),
      motion: z.number().int().min(0).max(100).optional(),
      complexity: z.number().int().min(0).max(100).optional(),
      errors: z.number().int().min(0).max(100).optional(),
      perf: z.number().int().min(0).max(100).optional(),
    })
    .describe(
      "Sub-scores for the criteria that were requested AND could be measured. Missing keys are reported in warnings.",
    ),
  evidence: z
    .object({
      errorCount: z.number().optional(),
      errorGroupCount: z.number().optional(),
      totalCookMs: z.number().optional(),
      frameBudgetMs: z.number().optional(),
      nodeCount: z.number().optional(),
      paletteChroma: z.number().optional(),
      paletteHueVar: z.number().optional(),
      motionDelta: z.number().optional(),
      previewTopPath: z.string().optional(),
    })
    .describe("Raw measurements behind the sub-scores."),
  suggestions: z.array(z.string()),
  critique: z.string().optional(),
  warnings: z.array(z.string()),
});
export type ScoreBuildOutput = z.infer<typeof scoreBuildOutputSchema>;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function scoreErrors(errors: { path: string; message: string }[]): number {
  if (errors.length === 0) return 100;
  const groups = new Set(errors.map((e) => e.message)).size;
  return Math.max(0, Math.round(100 - 15 * errors.length - 25 * groups));
}

function scorePerf(totalCookMs: number, frameBudgetMs: number, overBudgetNodes: number): number {
  const ratio = totalCookMs / frameBudgetMs;
  const base = Math.round(100 * (1 - Math.max(0, ratio - 0.5) / 1.5));
  return clamp(base - 5 * overBudgetNodes, 0, 100);
}

function scoreComplexity(n: number): number {
  if (n < 5) return Math.max(0, 100 - (5 - n) * 15);
  if (n <= 40) return 100;
  if (n <= 120) return Math.round(100 - (n - 40) * 0.5);
  return Math.max(0, Math.round(60 - (n - 120) * 0.4));
}

interface DecodedImage {
  width: number;
  height: number;
  /** RGB bytes (length = width*height*3). */
  rgb: Uint8Array;
}

/**
 * Minimal PNG decoder for 8-bit RGB / RGBA images (filter type per-row, no
 * interlacing). Returns null on anything fancier — caller falls back to a
 * warning + omitted sub-score, matching the spec.
 */
function decodePng(b64: string): DecodedImage | null {
  try {
    const buf = Buffer.from(b64, "base64");
    if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50) return null;
    let off = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlace = 0;
    const idatChunks: Buffer[] = [];
    while (off + 8 <= buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.slice(off + 4, off + 8).toString("ascii");
      const dataStart = off + 8;
      const dataEnd = dataStart + len;
      if (dataEnd + 4 > buf.length) return null;
      if (type === "IHDR") {
        width = buf.readUInt32BE(dataStart);
        height = buf.readUInt32BE(dataStart + 4);
        bitDepth = buf[dataStart + 8] ?? 0;
        colorType = buf[dataStart + 9] ?? 0;
        interlace = buf[dataStart + 12] ?? 0;
      } else if (type === "IDAT") {
        idatChunks.push(buf.slice(dataStart, dataEnd));
      } else if (type === "IEND") {
        break;
      }
      off = dataEnd + 4;
    }
    if (bitDepth !== 8 || interlace !== 0) return null;
    if (colorType !== 2 && colorType !== 6) return null; // RGB / RGBA only
    const bpp = colorType === 2 ? 3 : 4;
    const stride = width * bpp;
    const raw = inflateSync(Buffer.concat(idatChunks));
    if (raw.length < (stride + 1) * height) return null;
    const out = new Uint8Array(width * height * 3);
    const cur = Buffer.alloc(stride);
    const prev = Buffer.alloc(stride);
    let rp = 0;
    for (let y = 0; y < height; y++) {
      const filter = raw[rp++] ?? 0;
      for (let x = 0; x < stride; x++) {
        const v = raw[rp++] ?? 0;
        const left = x >= bpp ? (cur[x - bpp] ?? 0) : 0;
        const up = prev[x] ?? 0;
        const upLeft = x >= bpp ? (prev[x - bpp] ?? 0) : 0;
        let recon = v;
        if (filter === 1) recon = (v + left) & 0xff;
        else if (filter === 2) recon = (v + up) & 0xff;
        else if (filter === 3) recon = (v + Math.floor((left + up) / 2)) & 0xff;
        else if (filter === 4) {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const pr = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          recon = (v + pr) & 0xff;
        }
        cur[x] = recon;
      }
      // copy RGB triplets out
      const outRow = y * width * 3;
      for (let x = 0; x < width; x++) {
        out[outRow + x * 3] = cur[x * bpp] ?? 0;
        out[outRow + x * 3 + 1] = cur[x * bpp + 1] ?? 0;
        out[outRow + x * 3 + 2] = cur[x * bpp + 2] ?? 0;
      }
      cur.copy(prev);
    }
    return { width, height, rgb: out };
  } catch {
    return null;
  }
}

function rgbToHueDeg(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return h;
}

function paletteStats(img: DecodedImage): { chroma: number; hueVar: number } {
  const px = img.width * img.height;
  let chromaSum = 0;
  const hues: number[] = [];
  for (let i = 0; i < px; i++) {
    const r = img.rgb[i * 3] ?? 0;
    const g = img.rgb[i * 3 + 1] ?? 0;
    const b = img.rgb[i * 3 + 2] ?? 0;
    chromaSum += Math.max(r, g, b) - Math.min(r, g, b);
    if (Math.max(r, g, b) - Math.min(r, g, b) > 8) hues.push(rgbToHueDeg(r, g, b));
  }
  const chroma = chromaSum / px;
  let hueVar = 0;
  if (hues.length > 1) {
    const mean = hues.reduce((s, h) => s + h, 0) / hues.length;
    hueVar = Math.sqrt(hues.reduce((s, h) => s + (h - mean) ** 2, 0) / hues.length);
  }
  return { chroma, hueVar };
}

function frameDelta(a: DecodedImage, b: DecodedImage): number | null {
  if (a.width !== b.width || a.height !== b.height) return null;
  const n = a.rgb.length;
  let acc = 0;
  for (let i = 0; i < n; i++) acc += Math.abs((a.rgb[i] ?? 0) - (b.rgb[i] ?? 0));
  return acc / n;
}

async function resolvePreviewTop(
  ctx: ToolContext,
  scopePath: string,
  override: string | undefined,
): Promise<string | null> {
  if (override) return override;
  try {
    const topo = await ctx.client.getNetworkTopology(scopePath, true);
    const tops = topo.nodes.filter((n) => /TOP$/.test(n.type ?? ""));
    const out1 = tops.find((n) => n.path === `${scopePath}/out1`);
    if (out1) return out1.path;
    const outish = tops.find((n) => /(^|\/)out\d*$|_out$/i.test(n.path));
    if (outish) return outish.path;
    return tops[0]?.path ?? null;
  } catch {
    return null;
  }
}

function buildSuggestions(
  per: Record<string, number | undefined>,
  nodeCount: number | undefined,
  paused: boolean,
): string[] {
  const out: string[] = [];
  const ranked = Object.entries(per)
    .filter(([, v]) => v !== undefined && v < 70)
    .sort((a, b) => (a[1] as number) - (b[1] as number));
  for (const [k] of ranked) {
    if (k === "errors")
      out.push("Fix the largest error cluster first (see `summarize_td_errors`).");
    else if (k === "perf")
      out.push("Cook over budget — try `optimize_performance` to shrink the slowest TOPs.");
    else if (k === "complexity") {
      if ((nodeCount ?? 0) < 5) out.push("Network feels sparse — layer in a feedback/post effect.");
      else if ((nodeCount ?? 0) > 120)
        out.push("Very dense — consider folding sub-networks into reusable components.");
      else out.push("Complexity is off-target — adjust node count toward 5–40 ops.");
    } else if (k === "palette" && (per.palette ?? 100) < 60)
      out.push("Output is near-monochrome — add a `create_color_grade` or palette ramp.");
    else if (k === "motion" && (per.motion ?? 100) < 40) {
      const tail = paused ? " (TD timeline is paused — press Play.)" : "";
      out.push(
        `Output is static — bind a CHOP source via \`bind_to_channel\` or add \`create_feedback_network\`.${tail}`,
      );
    }
  }
  return out;
}

export async function scoreBuildImpl(ctx: ToolContext, args: ScoreBuildArgs) {
  const warnings: string[] = [];
  const per: Partial<Record<"palette" | "motion" | "complexity" | "errors" | "perf", number>> = {};
  const evidence: Record<string, number | string> = {};
  const wanted = new Set(args.criteria);

  try {
    // errors
    if (wanted.has("errors")) {
      try {
        const errs = await ctx.client.getNetworkErrors(args.scopePath);
        const groups = new Set(errs.errors.map((e) => e.message)).size;
        per.errors = scoreErrors(errs.errors);
        evidence.errorCount = errs.errors.length;
        evidence.errorGroupCount = groups;
      } catch (err) {
        warnings.push(`errors probe failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // perf
    if (wanted.has("perf")) {
      try {
        const perf = await checkPerformance(ctx.client, args.scopePath, args.targetFps, true);
        const overBudget = perf.nodes.filter((n) => n.cook_time_ms > perf.frameBudgetMs).length;
        per.perf = scorePerf(perf.totalCookMs, perf.frameBudgetMs, overBudget);
        evidence.totalCookMs = perf.totalCookMs;
        evidence.frameBudgetMs = perf.frameBudgetMs;
      } catch (err) {
        warnings.push(`perf probe failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // complexity
    if (wanted.has("complexity")) {
      try {
        const topo = await ctx.client.getNetworkTopology(args.scopePath, true);
        const nodes = topo.nodes.filter((n) => !/(base|baseCOMP)$/i.test(n.type ?? ""));
        const n = nodes.length;
        per.complexity = scoreComplexity(n);
        evidence.nodeCount = n;
      } catch (err) {
        warnings.push(
          `complexity probe failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // palette + motion (share a preview TOP)
    const needsPreview = wanted.has("palette") || wanted.has("motion");
    if (needsPreview) {
      const topPath = await resolvePreviewTop(ctx, args.scopePath, args.previewTopPath);
      if (!topPath) {
        warnings.push("Could not resolve a preview TOP under scope — palette/motion omitted.");
      } else {
        evidence.previewTopPath = topPath;
        let frame1: DecodedImage | null = null;
        try {
          const p1 = await ctx.client.getPreview(topPath, 64, 36);
          frame1 = decodePng(p1.base64);
        } catch {
          warnings.push(`Preview capture failed for ${topPath}.`);
        }
        if (!frame1) {
          warnings.push(
            "PNG decoder could not read the preview (non-RGB/RGBA-8 or interlaced); palette/motion omitted.",
          );
        } else {
          if (wanted.has("palette")) {
            const { chroma, hueVar } = paletteStats(frame1);
            evidence.paletteChroma = +chroma.toFixed(2);
            evidence.paletteHueVar = +hueVar.toFixed(2);
            per.palette = clamp(
              Math.round(0.5 * ((chroma / 255) * 100) + 0.5 * Math.min(100, (hueVar / 40) * 100)),
              0,
              100,
            );
          }
          if (wanted.has("motion")) {
            await new Promise((r) => setTimeout(r, 250));
            let frame2: DecodedImage | null = null;
            try {
              const p2 = await ctx.client.getPreview(topPath, 64, 36);
              frame2 = decodePng(p2.base64);
            } catch {
              /* handled below */
            }
            let paused = false;
            try {
              const info = (await ctx.client.getInfo()) as unknown as {
                time?: { play?: boolean };
              };
              if (info?.time?.play === false) {
                paused = true;
                warnings.push("Timeline paused → motion read as 0; press Play in TD.");
              }
            } catch {
              /* ignore */
            }
            if (!frame2) {
              warnings.push("Second motion frame unreadable; motion omitted.");
            } else {
              const d = frameDelta(frame1, frame2);
              if (d === null) {
                warnings.push("Motion frames had different sizes; motion omitted.");
              } else {
                evidence.motionDelta = +d.toFixed(3);
                per.motion = clamp(Math.round(Math.min(100, (d / 24) * 100)), 0, 100);
              }
            }
            void paused;
          }
        }
      }
    }
  } catch (err) {
    return errorResult(`score_build failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const subs = Object.values(per).filter((v): v is number => typeof v === "number");
  if (subs.length === 0) {
    return errorResult("score_build produced no sub-scores (all criteria unmeasurable).", {
      warnings,
    });
  }
  const final = Math.round(subs.reduce((s, v) => s + v, 0) / subs.length);

  const paused = warnings.some((w) => w.includes("Timeline paused"));
  const suggestions = buildSuggestions(per, evidence.nodeCount as number | undefined, paused);

  let critique: string | undefined;
  if (args.llmCritique) {
    if (!ctx.llm) {
      // silent no-op per spec
    } else {
      try {
        const scorecard = {
          final,
          perCriterion: per,
          warnings,
          scopePath: args.scopePath,
          targetFps: args.targetFps,
        };
        const res = await ctx.llm.complete([{ role: "user", content: JSON.stringify(scorecard) }], {
          [LLM_SYSTEM_OPTION]:
            "You are a senior live-visuals director. Given a deterministic scorecard of a TouchDesigner build, write 2–4 short sentences telling the artist the single most impactful change to make. No preamble, no scores, no JSON — just plain prose. <= 80 words.",
          maxTokens: 180,
          temperature: 0.4,
          timeoutMs: 8000,
        });
        critique = res.text.trim();
      } catch (err) {
        warnings.push(
          `LLM critique unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  const output: ScoreBuildOutput = {
    scopePath: args.scopePath,
    final,
    perCriterion: per,
    evidence: evidence as ScoreBuildOutput["evidence"],
    suggestions,
    critique,
    warnings,
  };
  return structuredResult(
    `score_build: ${final}/100 (${subs.length} criteria) under ${args.scopePath}.`,
    output,
  );
}

export const registerScoreBuild: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "score_build",
    {
      title: "Score a TouchDesigner build",
      description:
        "Read-only: score a built network 0–100 on a fixed rubric (palette/motion/complexity/errors/perf) and return per-criterion sub-scores plus deterministic improvement suggestions. Optional LLM critique when llmCritique=true and ctx.llm is configured. Composes existing bridge endpoints — creates nothing.",
      inputSchema: scoreBuildSchema.shape,
      outputSchema: scoreBuildOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => scoreBuildImpl(ctx, args),
  );
};
