import { z } from "zod";
import { friendlyTdError } from "../../td-client/types.js";
import { structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const preflightStatusSchema = z.enum(["pass", "warn", "fail"]);

export const showPreflightReportSchema = z.object({
  root_path: z.string().default("/project1").describe("Network root to inspect before a show."),
  target_fps: z.coerce
    .number()
    .positive()
    .default(60)
    .describe("Frame-rate target for cook-time warnings."),
  recursive: z.boolean().default(true).describe("Inspect nested nodes for topology/performance."),
  include_displays: z.boolean().default(true).describe("Include GPU/display/perform-mode checks."),
  include_performance: z
    .boolean()
    .default(true)
    .describe("Include network cook-time budget checks."),
});
type ShowPreflightReportArgs = z.infer<typeof showPreflightReportSchema>;

export const showPreflightReportOutputSchema = z.object({
  status: preflightStatusSchema,
  root_path: z.string(),
  target_fps: z.number(),
  summary: z.object({
    pass: z.number(),
    warn: z.number(),
    fail: z.number(),
  }),
  checks: z.array(
    z.object({
      id: z.string(),
      status: preflightStatusSchema,
      message: z.string(),
      data: z.unknown().optional(),
    }),
  ),
});

type Check = z.infer<typeof showPreflightReportOutputSchema>["checks"][number];

function worstStatus(checks: Check[]): "pass" | "warn" | "fail" {
  if (checks.some((check) => check.status === "fail")) return "fail";
  if (checks.some((check) => check.status === "warn")) return "warn";
  return "pass";
}

function summarize(checks: Check[]) {
  return {
    pass: checks.filter((check) => check.status === "pass").length,
    warn: checks.filter((check) => check.status === "warn").length,
    fail: checks.filter((check) => check.status === "fail").length,
  };
}

export async function showPreflightReportImpl(ctx: ToolContext, args: ShowPreflightReportArgs) {
  const checks: Check[] = [];

  try {
    const info = await ctx.client.getInfo();
    checks.push({
      id: "bridge",
      status: "pass",
      message: `TouchDesigner bridge reachable${info.bridge_version ? ` (${info.bridge_version})` : ""}.`,
      data: info,
    });
  } catch (err) {
    checks.push({
      id: "bridge",
      status: "fail",
      message: friendlyTdError(err),
    });
  }

  try {
    const errors = await ctx.client.getNetworkErrors(args.root_path);
    checks.push({
      id: "network_errors",
      status: errors.errors.length === 0 ? "pass" : "fail",
      message:
        errors.errors.length === 0
          ? `No node errors under ${args.root_path}.`
          : `${errors.errors.length} node error(s) under ${args.root_path}.`,
      data: errors,
    });
  } catch (err) {
    checks.push({
      id: "network_errors",
      status: "warn",
      message: `Could not read node errors: ${friendlyTdError(err)}`,
    });
  }

  try {
    const topology = await ctx.client.getNetworkTopology(args.root_path, args.recursive);
    checks.push({
      id: "topology",
      status: topology.nodes.length === 0 ? "warn" : "pass",
      message: `${topology.nodes.length} node(s), ${topology.connections.length} connection(s) under ${args.root_path}.`,
      data: topology,
    });
  } catch (err) {
    checks.push({
      id: "topology",
      status: "warn",
      message: `Could not read topology: ${friendlyTdError(err)}`,
    });
  }

  if (args.include_performance) {
    try {
      const perf = await ctx.client.getNetworkPerformance(args.root_path, args.recursive);
      const frameBudgetMs = 1000 / args.target_fps;
      const totalCookMs =
        perf.total_cook_time_ms ?? perf.nodes.reduce((total, node) => total + node.cook_time_ms, 0);
      const slowNodes = perf.nodes.filter((node) => node.cook_time_ms > frameBudgetMs);
      const overBudget = totalCookMs > frameBudgetMs || slowNodes.length > 0;
      checks.push({
        id: "performance",
        status: overBudget ? "warn" : "pass",
        message: overBudget
          ? `${totalCookMs.toFixed(2)}ms cook cost exceeds ${frameBudgetMs.toFixed(2)}ms budget or has ${slowNodes.length} slow node(s).`
          : `${totalCookMs.toFixed(2)}ms cook cost within ${frameBudgetMs.toFixed(2)}ms frame budget.`,
        data: { ...perf, frameBudgetMs, totalCookMs, slowNodes },
      });
    } catch (err) {
      checks.push({
        id: "performance",
        status: "warn",
        message: `Could not read performance: ${friendlyTdError(err)}`,
      });
    }
  }

  if (args.include_displays) {
    try {
      const system = await ctx.client.getSystemInfo(["gpu", "monitors", "performMode"]);
      const monitorCount = Array.isArray(system.monitors) ? system.monitors.length : 0;
      checks.push({
        id: "displays",
        status: monitorCount > 0 ? "pass" : "warn",
        message:
          monitorCount > 0
            ? `${monitorCount} monitor(s) detected; performMode=${String(system.performMode)}.`
            : "No monitor topology was reported by TouchDesigner.",
        data: system,
      });
    } catch (err) {
      checks.push({
        id: "displays",
        status: "warn",
        message: `Could not read GPU/display info: ${friendlyTdError(err)}`,
      });
    }
  }

  const status = worstStatus(checks);
  const summary = summarize(checks);
  const report = {
    status,
    root_path: args.root_path,
    target_fps: args.target_fps,
    summary,
    checks,
  };
  return structuredResult(
    `Show preflight ${status.toUpperCase()}: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail.`,
    report,
  );
}

export const registerShowPreflightReport: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "show_preflight_report",
    {
      title: "Show preflight report",
      description:
        "Read-only pre-show check: bridge reachability, node errors, topology, cook-time budget, GPU/display topology and perform-mode status in one PASS/WARN/FAIL report. Use before rehearsals or venue handoff to see what is safe, suspicious, or failing without mutating the project.",
      inputSchema: showPreflightReportSchema.shape,
      outputSchema: showPreflightReportOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => showPreflightReportImpl(ctx, args),
  );
};
