import { z } from "zod";
import { isMissingEndpoint, TdApiError } from "../../td-client/types.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const setParameterExpressionSchema = z.object({
  path: z.string().describe("Full path of the node whose parameters to set."),
  assignments: z
    .array(
      z.object({
        param: z.string().describe("Parameter name (case-sensitive), e.g. 'tx'."),
        mode: z
          .enum(["expression", "bind", "constant"])
          .default("expression")
          .describe(
            "expression: set par.expr; bind: set par.bindExpr; constant: set par.val from `value`.",
          ),
        expr: z
          .string()
          .optional()
          .describe(
            "The expression or bind string (required for mode expression/bind), e.g. 'me.time.seconds' or 'op(\"audio\")[\"level\"]'.",
          ),
        value: z
          .union([z.number(), z.string(), z.boolean()])
          .optional()
          .describe("Constant value (for mode 'constant')."),
      }),
    )
    .min(1)
    .describe("One or more parameter assignments."),
});

type SetParameterExpressionArgs = z.infer<typeof setParameterExpressionSchema>;

interface AppliedEntry {
  param: string;
  mode: string;
  readback_mode: string;
  readback_expr: string;
}

interface SetParameterExpressionReport {
  path: string;
  applied: AppliedEntry[];
  warnings: string[];
  probe?: {
    has_mode: boolean;
    has_expr: boolean;
    has_bindExpr: boolean;
    ParMode_available: boolean;
  };
  fatal?: string;
}

// All TD globals (op, ParMode) live inside this string — never reference them
// from TS. The payload travels as base64 so quotes/newlines in artist strings
// cannot break Python quoting.
const SET_EXPR_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"path": _p["path"], "applied": [], "warnings": []}
try:
    _c = op(_p["path"])
    if _c is None:
        report["fatal"] = "Node not found: " + str(_p["path"])
    else:
        _probe_done = False
        for _a in _p["assignments"]:
            try:
                _par = getattr(_c.par, _a["param"], None)
                if _par is None:
                    report["warnings"].append("No such parameter: " + str(_a["param"]))
                    continue
                # Capture probe info from the first accessible parameter.
                if not _probe_done:
                    try:
                        report["probe"] = {
                            "has_mode": hasattr(_par, "mode"),
                            "has_expr": hasattr(_par, "expr"),
                            "has_bindExpr": hasattr(_par, "bindExpr"),
                            "ParMode_available": ("ParMode" in dir()),
                        }
                    except Exception:
                        pass
                    _probe_done = True
                _m = _a.get("mode", "expression")
                if _m == "expression":
                    _e = _a.get("expr")
                    if not _e:
                        report["warnings"].append("param '" + str(_a["param"]) + "': expr required for mode 'expression'")
                        continue
                    _par.expr = _e
                    try:
                        _par.mode = ParMode.EXPRESSION
                    except Exception:
                        report["warnings"].append("ParMode enum unavailable; set raw attribute only")
                elif _m == "bind":
                    _e = _a.get("expr")
                    if not _e:
                        report["warnings"].append("param '" + str(_a["param"]) + "': expr required for mode 'bind'")
                        continue
                    _par.bindExpr = _e
                    try:
                        _par.mode = ParMode.BIND
                    except Exception:
                        report["warnings"].append("ParMode enum unavailable; set raw attribute only")
                else:
                    _v = _a.get("value")
                    if _v is None:
                        report["warnings"].append("param '" + str(_a["param"]) + "': value required for mode 'constant'")
                        continue
                    _par.val = _v
                    try:
                        _par.mode = ParMode.CONSTANT
                    except Exception:
                        pass
                report["applied"].append({
                    "param": _a["param"],
                    "mode": _m,
                    "readback_mode": str(getattr(_par, "mode", "")),
                    "readback_expr": str(getattr(_par, "expr", "")),
                })
            except Exception:
                report["warnings"].append("param '" + str(_a.get("param", "?")) + "': " + traceback.format_exc().splitlines()[-1])
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildSetExprScript(payload: object): string {
  return buildPayloadScript(SET_EXPR_SCRIPT, payload);
}

export async function setParameterExpressionImpl(
  ctx: ToolContext,
  args: SetParameterExpressionArgs,
): Promise<import("@modelcontextprotocol/sdk/types.js").CallToolResult> {
  return guardTd(
    async () => {
      // 1) first-class per-param endpoint (survives ALLOW_EXEC=0). It flips par.mode
      //    via type(par.mode), which also fixes the silent `ParMode` NameError the
      //    exec path hit. Loop fail-forward — per-item failures become warnings.
      //    If the FIRST call hits a TdApiError (older bridge / 404), abandon the
      //    loop and fall back to the whole-batch exec script below.
      const applied: AppliedEntry[] = [];
      const warnings: string[] = [];
      let endpointUsable = true;
      for (let i = 0; i < args.assignments.length; i++) {
        const a = args.assignments[i];
        if (!a) continue;
        // Mirror the exec path's pre-flight: expr is required for expression/bind.
        if ((a.mode === "expression" || a.mode === "bind") && !a.expr) {
          warnings.push(`param '${a.param}': expr required for mode '${a.mode}'`);
          continue;
        }
        if (a.mode === "constant" && a.value === undefined) {
          warnings.push(`param '${a.param}': value required for mode 'constant'`);
          continue;
        }
        try {
          const r = await ctx.client.setParameterMode(args.path, a.param, a.mode, a.expr, a.value);
          applied.push({
            param: r.param,
            mode: a.mode,
            readback_mode: r.readback_mode,
            readback_expr: r.readback_expr,
          });
        } catch (err) {
          // Only a genuinely missing endpoint (older bridge) on the FIRST call
          // triggers the whole-batch exec fallback. A validation error (unknown
          // param, missing node — also a TdApiError) is fail-forward per-param,
          // so later valid assignments still apply and ALLOW_EXEC=0 users get the
          // real reason instead of an exec-disabled error.
          if (i === 0 && isMissingEndpoint(err)) {
            endpointUsable = false;
            break;
          }
          if (err instanceof TdApiError) {
            warnings.push(`param '${a.param}': ${err.message}`);
            continue;
          }
          throw err; // connection/timeout -> guardTd
        }
      }
      if (endpointUsable) {
        return { path: args.path, applied, warnings } as SetParameterExpressionReport;
      }
      // fallback: whole-batch exec (older bridge).
      const script = buildSetExprScript({
        path: args.path,
        assignments: args.assignments,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<SetParameterExpressionReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(
          `set_parameter_expression failed on ${args.path}: ${report.fatal}`,
          report,
        );
      }
      const nApplied = report.applied.length;
      const nWarn = report.warnings.length;
      const summary = `Set ${nApplied} parameter(s) on ${args.path}${nWarn > 0 ? ` (${nWarn} warning(s))` : ""}.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerSetParameterExpression: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "set_parameter_expression",
    {
      title: "Set parameter expression / bind / constant",
      description:
        "Set one or more parameters on a node to an expression, bind expression, or constant value without needing the raw-Python escape hatch. Supports three modes: 'expression' (par.expr = ...), 'bind' (par.bindExpr = ...), and 'constant' (par.val = ...). Multiple assignments are applied fail-forward — per-item failures accumulate as warnings so a partial batch still returns useful results. Use this instead of execute_python_script when TDMCP_RAW_PYTHON is off.",
      inputSchema: setParameterExpressionSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => setParameterExpressionImpl(ctx, args),
  );
};
