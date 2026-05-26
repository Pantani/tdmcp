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
  path: z.string(),
  targetFps: z.number(),
  frameBudgetMs: z.number(),
  totalCookMs: z.number(),
  nodes: z.array(
    z.object({
      path: z.string(),
      cook_time_ms: z.number(),
      cook_count: z.number().optional(),
    }),
  ),
  warnings: z.array(z.string()),
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
        "Report cook times under a network (recursively by default, slowest node first) and warn about nodes that exceed the frame budget.",
      inputSchema: getTdPerformanceSchema.shape,
      outputSchema: getTdPerformanceOutputSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => getTdPerformanceImpl(ctx, args),
  );
};
