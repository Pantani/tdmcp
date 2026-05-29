import { z } from "zod";
import { isMissingEndpoint } from "../../td-client/types.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const getBridgeLogsSchema = z.object({
  scope: z
    .string()
    .default("/")
    .describe(
      "Network path to collect cook errors/warnings from (default whole project). Must be an existing operator path.",
    ),
  max_lines: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(100)
    .describe("Cap how many log lines to return (1–500)."),
  include_cook_errors: z
    .boolean()
    .default(true)
    .describe("Include current operator cook errors/warnings across the scope."),
});
type GetBridgeLogsArgs = z.infer<typeof getBridgeLogsSchema>;

export const getBridgeLogsOutputSchema = z.object({
  scope: z.string().describe("The network path that was scanned, echoing the request."),
  lines: z
    .array(
      z.object({
        source: z
          .string()
          .describe("Log source: 'cook' for cook errors/warnings, 'textport' for textport lines."),
        level: z.string().describe("Severity level: 'error' or 'warning'."),
        text: z.string().describe("The log message text."),
        op: z
          .string()
          .optional()
          .describe("Full operator path that produced this line (for cook sources)."),
      }),
    )
    .describe("Collected log lines, newest-first within each source."),
  count: z.number().describe("Total number of lines returned (after capping at max_lines)."),
  probe: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Diagnostic info about which log sources were reachable in this TD build (cook_errors always present; textport availability varies by build).",
    ),
  warnings: z
    .array(z.string())
    .describe("Non-fatal issues during collection (e.g. truncation notes)."),
});

interface BridgeLogsReport {
  scope: string;
  lines: Array<{ source: string; level: string; text: string; op?: string }>;
  count: number;
  probe?: Record<string, unknown>;
  warnings: string[];
  fatal?: string;
}

// Walk op(scope).findChildren() and collect errors/warnings from each operator.
// ALSO try a best-effort textport/DAT probe — entirely wrapped in try/except so
// it can never make the cook-errors path fail. The probe dict reports what was
// reachable so a live validation can confirm which sources exist in the running build.
const GET_BRIDGE_LOGS_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
_scope = _p["scope"]
_max_lines = int(_p["max_lines"])
_include_cook = bool(_p["include_cook_errors"])
report = {"scope": _scope, "lines": [], "count": 0, "probe": {}, "warnings": []}
try:
    _root = op(_scope)
    if _root is None:
        report["fatal"] = "Scope operator not found: " + str(_scope)
        print(json.dumps(report))
        raise SystemExit(0)

    # --- Cook errors/warnings walk (guaranteed path) ---
    if _include_cook:
        try:
            _all_ops = [_root] + list(_root.findChildren(recurse=True))
            report["probe"]["cook_walk_count"] = len(_all_ops)
            # Cap the walk to avoid runaway scans on giant projects
            _walk_cap = 2000
            if len(_all_ops) > _walk_cap:
                _all_ops = _all_ops[:_walk_cap]
                report["warnings"].append(
                    f"Op walk capped at {_walk_cap} (project has more). Some cook errors may be missing."
                )
            for _o in _all_ops:
                try:
                    # op.errors()/op.warnings() return a STRING, not a list. Wrap
                    # each in a single-element list so a (possibly multi-line)
                    # message becomes exactly ONE log line — iterating the string
                    # directly would emit one bogus line per character.
                    _err = _o.errors(recurse=False)
                    for _msg in ([str(_err)] if _err else []):
                        report["lines"].append({
                            "source": "cook",
                            "level": "error",
                            "text": str(_msg),
                            "op": _o.path,
                        })
                    _warn = _o.warnings(recurse=False)
                    for _msg in ([str(_warn)] if _warn else []):
                        report["lines"].append({
                            "source": "cook",
                            "level": "warning",
                            "text": str(_msg),
                            "op": _o.path,
                        })
                except Exception:
                    pass  # one unreadable op doesn't stop the walk
            report["probe"]["cook_errors_available"] = True
        except Exception:
            report["probe"]["cook_errors_available"] = False
            report["probe"]["cook_errors_exc"] = traceback.format_exc().splitlines()[-1]

    # --- Textport / print-log probe (best-effort, UNVERIFIED across TD builds) ---
    # Try every known programmatic route. Whatever works, append those lines.
    _tp_lines = []
    try:
        # Route 1: Error DAT at a common location (artists sometimes wire one up)
        _err_dat = op("/project1/error_dat") or op("/project1/errorlog") or op("/error_dat")
        if _err_dat is not None and hasattr(_err_dat, "numRows"):
            for _r in range(_err_dat.numRows):
                try:
                    _tp_lines.append({"source": "textport", "level": "error", "text": str(_err_dat[_r, 0])})
                except Exception:
                    pass
            report["probe"]["error_dat_path"] = _err_dat.path
    except Exception:
        pass
    try:
        # Route 2: ui.log() buffer — present in some TD builds as a DAT
        if hasattr(ui, "log"):
            _log_str = str(ui.log) if not callable(ui.log) else None
            if _log_str:
                for _ln in _log_str.splitlines()[-200:]:
                    _tp_lines.append({"source": "textport", "level": "error", "text": _ln})
                report["probe"]["ui_log_available"] = True
    except Exception:
        pass
    try:
        # Route 3: app.textportLines() — if the method exists
        if hasattr(app, "textportLines"):
            _tpl = app.textportLines()
            if _tpl:
                for _ln in _tpl:
                    _tp_lines.append({"source": "textport", "level": "error", "text": str(_ln)})
                report["probe"]["textport_lines_available"] = True
    except Exception:
        pass
    if _tp_lines:
        report["lines"].extend(_tp_lines)
    else:
        report["probe"]["textport_available"] = False

    # --- Truncate to max_lines ---
    if len(report["lines"]) > _max_lines:
        report["warnings"].append(
            f"Truncated to {_max_lines} of {len(report['lines'])} lines."
        )
        report["lines"] = report["lines"][:_max_lines]
    report["count"] = len(report["lines"])

except SystemExit:
    pass
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildGetBridgeLogsScript(payload: object): string {
  return buildPayloadScript(GET_BRIDGE_LOGS_SCRIPT, payload);
}

export async function getBridgeLogsImpl(ctx: ToolContext, args: GetBridgeLogsArgs) {
  return guardTd(
    async () => {
      // 1) first-class /api/logs endpoint (survives ALLOW_EXEC=0): reads the bridge
      //    Error DAT instead of char-iterating op.errors(). Map its rows into the
      //    existing {source:"cook", level, text, op} shape. Fall back to the exec
      //    op-walk when the endpoint 404s OR reports available:false (older bridge).
      //    /api/logs IS the Error-DAT cook source, so only hit it when the caller
      //    wants cook errors; otherwise skip to the exec path, which honors the
      //    include_cook_errors flag and returns only the non-cook probe logs.
      if (args.include_cook_errors) {
        try {
          // getLogs(severity, maxLines, scope) — request all severities, the
          // caller's max_lines, and pass the scope through so the endpoint filters
          // to that operator path (was previously sending scope as the severity).
          const logs = await ctx.client.getLogs("all", args.max_lines, args.scope);
          if (logs.available) {
            const lines = logs.lines.map((l) => ({
              source: "cook",
              level: (l.severity || "error").toLowerCase(),
              text: l.message,
              op: l.source,
            }));
            return {
              scope: args.scope,
              lines,
              count: lines.length,
              probe: { endpoint: true, error_dat: logs.error_dat },
              warnings: logs.warnings,
            } as BridgeLogsReport;
          }
          // available:false -> fall through to the exec op-walk.
        } catch (err) {
          // Fall back to the exec op-walk ONLY when the endpoint is absent (older
          // bridge); a current bridge's validation 400 (bad scope) must surface.
          if (!isMissingEndpoint(err)) throw err;
        }
      }
      const script = buildGetBridgeLogsScript({
        scope: args.scope,
        max_lines: args.max_lines,
        include_cook_errors: args.include_cook_errors,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<BridgeLogsReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`get_bridge_logs failed: ${report.fatal}`, report);
      }
      const errorCount = report.lines.filter((l) => l.level === "error").length;
      const warnCount = report.lines.filter((l) => l.level === "warning").length;
      const summary =
        `${report.count} log line(s) from ${report.scope}` +
        ` (${errorCount} error(s), ${warnCount} warning(s)).`;
      return structuredResult(summary, {
        scope: report.scope,
        lines: report.lines,
        count: report.count,
        probe: report.probe,
        warnings: report.warnings,
      });
    },
  );
}

export const registerGetBridgeLogs: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "get_bridge_logs",
    {
      title: "Get bridge logs and cook errors",
      description:
        "Read-only: collect recent cook errors and warnings from the running TouchDesigner project for debugging. Walks the operator tree under `scope` and gathers each operator's current cook errors and warnings (guaranteed). Also attempts a best-effort probe of textport/log DATs if they exist in the project. Use this when a script or cook fails and you need more context than the immediate error string — it surfaces the real Python traceback or operator cook errors without requiring a new REST endpoint. Returns {lines[], count, probe} where probe reports which log sources were reachable in this TD build.",
      inputSchema: getBridgeLogsSchema.shape,
      outputSchema: getBridgeLogsOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => getBridgeLogsImpl(ctx, args),
  );
};
