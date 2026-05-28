import { z } from "zod";
import { checkPerformance } from "../../feedback/performanceMonitor.js";
import { guardTd, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const getTdPerformanceSchema = z.object({
  root_path: z.string().default("/project1").describe("Network root to measure cook times under."),
  target_fps: z
    .number()
    .positive()
    .default(60)
    .describe("Frame-rate target used to flag slow nodes."),
  recursive: z
    .boolean()
    .default(true)
    .describe(
      "Measure every descendant (true, default) so cook time inside generated containers is counted, not just the root's direct children.",
    ),
});
type GetTdPerformanceArgs = z.infer<typeof getTdPerformanceSchema>;

export const getTdPerformanceOutputSchema = z.object({
  path: z.string().describe("The network root that was measured, echoing the request."),
  targetFps: z.number().describe("The frame-rate target used to derive the per-frame budget."),
  frameBudgetMs: z
    .number()
    .describe("Milliseconds available per frame at the target FPS (1000 / targetFps)."),
  totalCookMs: z.number().describe("Sum of the measured nodes' last cook times, in milliseconds."),
  nodes: z
    .array(
      z.object({
        path: z.string().describe("Path of the measured node."),
        cook_time_ms: z.number().describe("That node's last cook time in milliseconds."),
        cook_count: z
          .number()
          .optional()
          .describe("How many times the node has cooked, when reported by TD."),
      }),
    )
    .describe("Per-node cook times, slowest first."),
  warnings: z
    .array(z.string())
    .describe(
      "Budget warnings: one line per node whose cook time exceeds the frame budget, plus a final aggregate line when the summed total cook time exceeds the budget. Empty when everything is within budget.",
    ),
});

export async function getTdPerformanceImpl(ctx: ToolContext, args: GetTdPerformanceArgs) {
  return guardTd(
    () => checkPerformance(ctx.client, args.root_path, args.target_fps, args.recursive),
    (report) =>
      structuredResult(
        report.warnings.length === 0
          ? `Within budget: ${report.totalCookMs.toFixed(2)}ms total under ${args.root_path} (${args.target_fps}fps).`
          : `${report.warnings.length} performance warning(s) under ${args.root_path}.`,
        report,
      ),
  );
}

export const registerGetTdPerformance: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "get_td_performance",
    {
      title: "Get network performance",
      description:
        "Read-only: report cook times under a network (recursively by default, slowest node first) and warn about nodes that exceed the frame budget. Returns {targetFps, frameBudgetMs, totalCookMs, nodes[], warnings[]} and changes nothing. Use this to just measure; use optimize_performance when you want suggestions and the option to auto-shrink the slow TOPs.",
      inputSchema: getTdPerformanceSchema.shape,
      outputSchema: getTdPerformanceOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => getTdPerformanceImpl(ctx, args),
  );
};
