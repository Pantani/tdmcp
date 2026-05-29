import { z } from "zod";
import { TdApiError } from "../../td-client/types.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const readParameterModesSchema = z.object({
  path: z.string().describe("Full path of the node whose parameters to inspect."),
  keys: z
    .array(z.string())
    .optional()
    .describe("Only report these parameter names (case-sensitive). Omit for all parameters."),
  non_default_only: z
    .boolean()
    .default(false)
    .describe(
      "Only return parameters whose mode is not plain constant (i.e. expression/export/bind) — the ones that matter for a faithful round-trip.",
    ),
});
type ReadParameterModesArgs = z.infer<typeof readParameterModesSchema>;

export const parameterModeInfoSchema = z.object({
  name: z.string(),
  value: z.unknown().optional(),
  mode: z.string(),
  expr: z.string().optional(),
  bind_expr: z.string().optional(),
  export_op: z.string().optional(),
  expression: z.string().optional(),
  bind_expression: z.string().optional(),
  export_source: z.string().optional(),
});

export const readParameterModesOutputSchema = z.object({
  path: z.string(),
  type: z.string(),
  name: z.string(),
  parameters: z.array(parameterModeInfoSchema),
  probe: z.record(z.string(), z.unknown()).optional(),
  warnings: z.array(z.string()),
});

interface ParameterEntry {
  name: string;
  value?: unknown;
  mode: string;
  expr?: string;
  bind_expr?: string;
  export_op?: string;
}

interface ReadParameterModesReport {
  path: string;
  type: string;
  name: string;
  parameters: ParameterEntry[];
  probe?: Record<string, unknown>;
  warnings: string[];
  fatal?: string;
}

// The payload travels as base64 so arbitrary strings cannot break Python quoting.
// All TD globals (op, app, etc.) live inside this script string — never outside it.
const READ_PARAMETER_MODES_SCRIPT = `
import json, base64, math, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"path": _p["path"], "type": "", "name": "", "parameters": [], "warnings": []}

def _json_safe(value):
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    try:
        _path = getattr(value, "path", None)
        if _path is not None:
            return str(_path)
    except Exception:
        pass
    try:
        return str(value)
    except Exception:
        return None
try:
    _c = op(_p["path"])
    if _c is None:
        report["fatal"] = "Node not found: " + str(_p["path"])
    else:
        report["type"] = _c.type
        report["name"] = _c.name
        _keys = _p.get("keys") or None
        _non_default_only = bool(_p.get("non_default_only", False))
        _pars = _c.pars()
        _first = True
        for par in _pars:
            try:
                _pname = par.name
                if _keys is not None and _pname not in _keys:
                    continue
                # Probe attributes on the first parameter to help confirm the real TD API.
                if _first:
                    _first = False
                    try:
                        _probe = {
                            "has_mode": hasattr(par, "mode"),
                            "has_expr": hasattr(par, "expr"),
                            "has_bindExpr": hasattr(par, "bindExpr"),
                            "has_exportOP": hasattr(par, "exportOP"),
                            "mode_repr": str(par.mode) if hasattr(par, "mode") else None,
                            "par_attrs": sorted([a for a in dir(par) if not a.startswith("_")])[:60],
                        }
                        report["probe"] = _probe
                    except Exception:
                        report["probe"] = {"error": traceback.format_exc().splitlines()[-1]}
                # Read mode; normalize "ParMode.CONSTANT" → "CONSTANT".
                try:
                    _raw_mode = par.mode
                    _mode = str(_raw_mode).split(".")[-1].upper() if _raw_mode is not None else "UNKNOWN"
                except Exception:
                    _mode = "UNKNOWN"
                # Skip constant parameters when the caller only wants non-defaults.
                if _non_default_only and _mode == "CONSTANT":
                    continue
                _entry = {"name": _pname, "mode": _mode}
                # Evaluated value — some pars raise on eval() (e.g. disconnected references).
                try:
                    _entry["value"] = _json_safe(par.eval())
                except Exception as _ve:
                    report["warnings"].append("Could not eval " + _pname + ": " + str(_ve))
                # Raw expression string — only meaningful when mode is EXPRESSION.
                try:
                    _expr = par.expr
                    if _expr:
                        _entry["expr"] = str(_expr)
                except Exception:
                    pass
                # Bind expression.
                try:
                    _be = getattr(par, "bindExpr", "")
                    if _be:
                        _entry["bind_expr"] = str(_be)
                except Exception:
                    pass
                # Export source operator path.
                try:
                    _eop = par.exportOP
                    if _eop is not None:
                        _entry["export_op"] = _eop.path
                except Exception:
                    pass
                report["parameters"].append(_entry)
            except Exception:
                try:
                    report["warnings"].append("Error reading par " + str(par.name) + ": " + traceback.format_exc().splitlines()[-1])
                except Exception:
                    report["warnings"].append("Error reading unknown par: " + traceback.format_exc().splitlines()[-1])
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildReadParameterModesScript(payload: object): string {
  return buildPayloadScript(READ_PARAMETER_MODES_SCRIPT, payload);
}

export async function readParameterModesImpl(ctx: ToolContext, args: ReadParameterModesArgs) {
  return guardTd(
    async () => {
      // 1) first-class endpoint (survives ALLOW_EXEC=0). Field names already match
      //    the report shape (name/mode/value/expr/bind_expr/export_op); `probe` is
      //    exec-only, so it is simply absent on this path.
      try {
        const r = await ctx.client.readParameterModes(args.path, args.keys, args.non_default_only);
        return {
          path: r.path,
          type: r.type,
          name: r.name,
          parameters: r.parameters as ParameterEntry[],
          warnings: r.warnings,
        } as ReadParameterModesReport;
      } catch (err) {
        if (!(err instanceof TdApiError)) throw err; // connection/timeout -> guardTd
        // older bridge (404/unsupported) -> fall through to the exec path
      }
      const script = buildReadParameterModesScript({
        path: args.path,
        keys: args.keys ?? null,
        non_default_only: args.non_default_only,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<ReadParameterModesReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`read_parameter_modes failed: ${report.fatal}`, report);
      }
      const nonConst = report.parameters.filter((p) => p.mode !== "CONSTANT").length;
      const summary = `${report.parameters.length} parameter(s) for ${report.path} (${report.type}) — ${nonConst} non-constant.`;
      return structuredResult(summary, {
        path: report.path,
        type: report.type,
        name: report.name,
        parameters: report.parameters,
        probe: report.probe,
        warnings: report.warnings,
      });
    },
  );
}

export const registerReadParameterModes: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "read_parameter_modes",
    {
      title: "Read parameter modes",
      description:
        "Read-only: for each parameter of a node, report its mode (CONSTANT / EXPRESSION / EXPORT / BIND), its evaluated value, and its raw expression / bind-expression / export-source strings. Use this to faithfully serialize a network for round-trip editing, diffing, or debugging — the evaluated value alone hides which parameters are driven by expressions or exports. Set `non_default_only` to surface only the parameters that would be lost in a plain value copy.",
      inputSchema: readParameterModesSchema.shape,
      outputSchema: readParameterModesOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => readParameterModesImpl(ctx, args),
  );
};
