import { z } from "zod";
import { friendlyTdError } from "../../td-client/types.js";
import { structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const hardwareSectionSchema = z.enum(["bridge", "display", "status_surfaces"]);
const checkStatusSchema = z.enum(["pass", "warning", "fail", "unverified"]);

export const diagnoseHardwareEnvironmentSchema = z.object({
  expected_min_monitors: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Optional minimum display/monitor count expected for the room/projector setup."),
  include: z
    .array(hardwareSectionSchema)
    .nonempty()
    .optional()
    .describe(
      "Subset of hardware checks to run. Defaults to bridge + display, and also status_surfaces when status_paths is non-empty.",
    ),
  status_paths: z
    .array(z.string())
    .default([])
    .describe(
      "Optional DAT paths containing generated status JSON, such as source_status or bridge_status.",
    ),
});
type DiagnoseHardwareEnvironmentArgs = z.infer<typeof diagnoseHardwareEnvironmentSchema>;

export const diagnoseHardwareEnvironmentOutputSchema = z.object({
  bridge: z.record(z.string(), z.unknown()).optional(),
  checks: z.array(
    z.object({
      evidence: z.record(z.string(), z.unknown()).optional(),
      id: z.string(),
      recommendation: z.string().optional(),
      status: checkStatusSchema,
      title: z.string(),
    }),
  ),
  connected: z.boolean(),
  endpoint: z.string(),
  overall: checkStatusSchema,
  status_surfaces: z.array(z.record(z.string(), z.unknown())).optional(),
  system: z.record(z.string(), z.unknown()).optional(),
});

type CheckStatus = z.infer<typeof checkStatusSchema>;

interface HardwareCheck {
  evidence?: Record<string, unknown>;
  id: string;
  recommendation?: string;
  status: CheckStatus;
  title: string;
}

interface HardwareReport {
  bridge?: Record<string, unknown>;
  checks: HardwareCheck[];
  connected: boolean;
  endpoint: string;
  overall: CheckStatus;
  status_surfaces?: Record<string, unknown>[];
  system?: Record<string, unknown>;
}

function defaultSections(args: DiagnoseHardwareEnvironmentArgs): Set<string> {
  if (args.include) return new Set(args.include);
  const sections = new Set<string>(["bridge", "display"]);
  if (args.status_paths.length > 0) sections.add("status_surfaces");
  return sections;
}

function overallStatus(checks: readonly HardwareCheck[]): CheckStatus {
  if (checks.some((check) => check.status === "fail")) return "fail";
  if (checks.some((check) => check.status === "warning")) return "warning";
  if (checks.some((check) => check.status === "unverified")) return "unverified";
  return "pass";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function boolValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string")
    return !["", "0", "false", "no", "off"].includes(value.toLowerCase());
  if (value === undefined || value === null) return fallback;
  return Boolean(value);
}

function statusSurfaceCheck(path: string, payload: Record<string, unknown>): HardwareCheck {
  const state = String(payload.state ?? "unknown").toLowerCase();
  const ok = boolValue(payload.ok, false);
  const stale = boolValue(payload.stale, false);
  const failedState = ["failed", "missing", "stalled", "exited"].includes(state);
  const status: CheckStatus = ok && !stale && !failedState ? "pass" : "fail";
  return {
    evidence: {
      error: payload.error,
      height: payload.height,
      ok,
      sourceKind: payload.sourceKind,
      stale,
      state,
      width: payload.width,
    },
    id: `status:${path}`,
    recommendation:
      status === "pass"
        ? undefined
        : "Open the generated status DAT in TouchDesigner and fix the reported source/helper state before calibrating the artwork.",
    status,
    title: `Status surface ${path}`,
  };
}

async function readStatusSurface(
  ctx: ToolContext,
  path: string,
): Promise<{ check: HardwareCheck; payload?: Record<string, unknown> }> {
  try {
    const dat = await ctx.client.getDatText(path);
    const payload = asRecord(JSON.parse(dat.text));
    if (!payload) {
      return {
        check: {
          evidence: { path },
          id: `status:${path}`,
          recommendation: "The DAT exists but does not contain a JSON object.",
          status: "fail",
          title: `Status surface ${path}`,
        },
      };
    }
    return { check: statusSurfaceCheck(path, payload), payload: { path, ...payload } };
  } catch (err) {
    return {
      check: {
        evidence: { path, reason: friendlyTdError(err) },
        id: `status:${path}`,
        recommendation:
          "Confirm the status DAT path is correct and that the generated component is still present.",
        status: "fail",
        title: `Status surface ${path}`,
      },
    };
  }
}

function createReport(endpoint: string, checks: HardwareCheck[]): HardwareReport {
  return {
    checks,
    connected: false,
    endpoint,
    overall: "unverified",
  };
}

function bridgeFailureCheck(endpoint: string, err: unknown): HardwareCheck {
  return {
    evidence: { endpoint, reason: friendlyTdError(err) },
    id: "bridge",
    recommendation:
      "Start TouchDesigner and verify the tdmcp bridge is reachable before diagnosing hardware.",
    status: "fail",
    title: "TouchDesigner bridge reachable",
  };
}

async function collectBridgeDiagnostics(
  ctx: ToolContext,
  sections: ReadonlySet<string>,
  checks: HardwareCheck[],
  report: HardwareReport,
): Promise<boolean> {
  try {
    const bridge = await ctx.client.getInfo();
    report.connected = true;
    report.bridge = bridge as Record<string, unknown>;
    if (sections.has("bridge")) {
      checks.push({
        evidence: bridge as Record<string, unknown>,
        id: "bridge",
        status: "pass",
        title: "TouchDesigner bridge reachable",
      });
    }
    return true;
  } catch (err) {
    checks.push(bridgeFailureCheck(report.endpoint, err));
    report.overall = overallStatus(checks);
    return false;
  }
}

function displayStatus(monitorError: unknown, enoughMonitors: boolean): CheckStatus {
  if (monitorError) return "warning";
  return enoughMonitors ? "pass" : "warning";
}

async function collectDisplayDiagnostics(
  ctx: ToolContext,
  args: DiagnoseHardwareEnvironmentArgs,
  sections: ReadonlySet<string>,
  checks: HardwareCheck[],
  report: HardwareReport,
): Promise<void> {
  if (!sections.has("display")) return;
  try {
    const system = await ctx.client.getSystemInfo(["monitors", "performMode"]);
    report.system = system as Record<string, unknown>;
    const monitors = Array.isArray(system.monitors) ? system.monitors : [];
    const monitorError = asRecord(system.monitors)?.error;
    const expected = args.expected_min_monitors ?? 1;
    const enoughMonitors = monitors.length >= expected;
    checks.push({
      evidence: {
        actual: monitors.length,
        expected_min_monitors: expected,
        monitor_error: monitorError,
        performMode: system.performMode,
      },
      id: "display",
      recommendation: enoughMonitors
        ? undefined
        : "Connect/enable the projector or lower expected_min_monitors for this diagnostic pass.",
      status: displayStatus(monitorError, enoughMonitors),
      title: "Display/projector topology",
    });
  } catch (err) {
    checks.push({
      evidence: { reason: friendlyTdError(err) },
      id: "display",
      recommendation: "Update or restart the bridge if /api/system is unavailable.",
      status: "warning",
      title: "Display/projector topology",
    });
  }
}

async function collectStatusSurfaceDiagnostics(
  ctx: ToolContext,
  args: DiagnoseHardwareEnvironmentArgs,
  sections: ReadonlySet<string>,
  checks: HardwareCheck[],
  report: HardwareReport,
): Promise<void> {
  if (!sections.has("status_surfaces")) return;
  const surfaces: Record<string, unknown>[] = [];
  if (args.status_paths.length === 0) {
    checks.push({
      id: "status_surfaces",
      recommendation:
        "Pass generated source_status or bridge_status DAT paths to verify live sensor/helper health.",
      status: "unverified",
      title: "Generated sensor/helper status surfaces",
    });
  }
  for (const path of args.status_paths) {
    const { check, payload } = await readStatusSurface(ctx, path);
    checks.push(check);
    if (payload) surfaces.push(payload);
  }
  report.status_surfaces = surfaces;
}

export async function diagnoseHardwareEnvironmentImpl(
  ctx: ToolContext,
  args: DiagnoseHardwareEnvironmentArgs,
) {
  const sections = defaultSections(args);
  const checks: HardwareCheck[] = [];
  const endpoint = ctx.client.endpoint;
  const report = createReport(endpoint, checks);
  const connected = await collectBridgeDiagnostics(ctx, sections, checks, report);
  if (!connected) {
    return structuredResult("Hardware environment diagnosis: fail.", report);
  }

  await collectDisplayDiagnostics(ctx, args, sections, checks, report);
  await collectStatusSurfaceDiagnostics(ctx, args, sections, checks, report);

  report.overall = overallStatus(checks);
  return structuredResult(`Hardware environment diagnosis: ${String(report.overall)}.`, report);
}

export const registerDiagnoseHardwareEnvironment: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "diagnose_hardware_environment",
    {
      title: "Diagnose hardware environment",
      description:
        "Read-only: check whether TouchDesigner is reachable, whether display/projector topology matches expectations, and whether generated sensor/helper status DATs such as source_status or bridge_status are healthy. This is a room/hardware preflight for physical installations; it returns PASS/WARNING/FAIL/UNVERIFIED checks without mutating the TD project.",
      inputSchema: diagnoseHardwareEnvironmentSchema.shape,
      outputSchema: diagnoseHardwareEnvironmentOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => diagnoseHardwareEnvironmentImpl(ctx, args),
  );
};
