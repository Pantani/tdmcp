import { z } from "zod";
import { checkPerformance } from "../../feedback/performanceMonitor.js";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const profileCookCostSchema = z.object({
  scopePath: z.string().default("/project1").describe("Network root to profile (recursive)."),
  samples: z
    .number()
    .int()
    .min(2)
    .max(240)
    .default(30)
    .describe("How many snapshots to take across the window."),
  intervalMs: z
    .number()
    .int()
    .min(16)
    .max(2000)
    .default(100)
    .describe("Delay between snapshots in milliseconds (>= one frame at 60fps)."),
  topN: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(15)
    .describe("How many hotspots to return, ranked desc by p95."),
  targetFps: z
    .number()
    .positive()
    .default(60)
    .describe("Forwarded to get_td_performance for the per-frame budget annotation."),
});

export type ProfileCookCostArgs = z.infer<typeof profileCookCostSchema>;

export const profileCookCostOutputSchema = z.object({
  path: z.string(),
  samples: z.number(),
  intervalMs: z.number(),
  targetFps: z.number(),
  frameBudgetMs: z.number(),
  windowMs: z.number(),
  hotspots: z.array(
    z.object({
      path: z.string(),
      type: z.string().optional(),
      meanCookMs: z.number(),
      p95CookMs: z.number(),
      maxCookMs: z.number(),
      sampleCount: z.number(),
      overBudget: z.boolean(),
    }),
  ),
  warnings: z.array(z.string()),
});

function p95(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(Math.ceil(0.95 * sorted.length) - 1, sorted.length - 1);
  return sorted[idx] ?? 0;
}

export async function profileCookCostImpl(ctx: ToolContext, args: ProfileCookCostArgs) {
  const { scopePath, samples, intervalMs, topN, targetFps } = args;
  const frameBudgetMs = 1000 / targetFps;
  const cookMap = new Map<string, { times: number[]; type?: string }>();
  const warnings: string[] = [];
  let collectedSamples = 0;
  const startMs = Date.now();

  for (let i = 0; i < samples; i++) {
    try {
      const report = await checkPerformance(ctx.client, scopePath, targetFps, true);
      collectedSamples++;
      for (const node of report.nodes) {
        const entry = cookMap.get(node.path);
        if (entry) {
          entry.times.push(node.cook_time_ms);
        } else {
          cookMap.set(node.path, { times: [node.cook_time_ms] });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(
        `Only ${collectedSamples}/${samples} samples collected before bridge error: ${msg}`,
      );
      break;
    }
    if (i < samples - 1) {
      await new Promise<void>((r) => setTimeout(r, intervalMs));
    }
  }

  const windowMs = Date.now() - startMs;

  if (collectedSamples === 0) {
    return errorResult("No samples collected — bridge may be offline.");
  }

  // Check for all-zero-identical pattern (paused timeline)
  let allZero = true;
  for (const { times } of cookMap.values()) {
    if (times.some((t) => t !== 0)) {
      allZero = false;
      break;
    }
  }
  if (allZero && cookMap.size > 0) {
    warnings.push("All cook times are 0 across every sample — TD timeline may be paused.");
  }

  const hotspots = Array.from(cookMap.entries()).map(([path, { times, type }]) => {
    const sorted = [...times].sort((a, b) => a - b);
    const mean = times.reduce((s, v) => s + v, 0) / times.length;
    const p95v = p95(sorted);
    const max = Math.max(...times);
    return {
      path,
      type,
      meanCookMs: mean,
      p95CookMs: p95v,
      maxCookMs: max,
      sampleCount: times.length,
      overBudget: p95v > frameBudgetMs,
    };
  });

  hotspots.sort((a, b) => {
    if (b.p95CookMs !== a.p95CookMs) return b.p95CookMs - a.p95CookMs;
    if (b.meanCookMs !== a.meanCookMs) return b.meanCookMs - a.meanCookMs;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  const topHotspots = hotspots.slice(0, topN);
  const overCount = topHotspots.filter((h) => h.overBudget).length;

  const summary =
    overCount > 0
      ? `${overCount} node(s) over budget (p95 > ${frameBudgetMs.toFixed(2)}ms) in ${collectedSamples} samples.`
      : `No nodes over budget in ${collectedSamples} samples under ${scopePath}.`;

  return structuredResult(summary, {
    path: scopePath,
    samples: collectedSamples,
    intervalMs,
    targetFps,
    frameBudgetMs,
    windowMs,
    hotspots: topHotspots,
    warnings,
  });
}

export const registerProfileCookCost: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "profile_cook_cost",
    {
      title: "Profile cook cost",
      description:
        "Read-only: sample cook times over a window (N samples × intervalMs) and rank hotspot nodes by p95 cook time. Use this to diagnose intermittent stalls that a single get_td_performance snapshot misses. Returns {path, samples, intervalMs, targetFps, frameBudgetMs, windowMs, hotspots[], warnings[]}.",
      inputSchema: profileCookCostSchema.shape,
      outputSchema: profileCookCostOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => profileCookCostImpl(ctx, args),
  );
};
