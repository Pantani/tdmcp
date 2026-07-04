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
          .enum(["expression", "bind", "constant", "reset", "unbind"])
          .default("expression")
          .describe(
            "expression: set par.expr; bind: set par.bindExpr; constant: set par.val from `value`; reset: restore par default (par.reset()); unbind: freeze current eval() value as a constant, dropping the driver.",
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

// All TD globals (op) live inside this string — never reference them from TS.
// The payload travels as base64 so quotes/newlines in artist strings cannot
// break Python quoting. The mode flip resolves the enum via `type(_par.mode)`
// (mirroring the bridge's param-text service) — never a bare `ParMode`, which is
// not a name in the exec namespace and used to NameError, silently leaving the
// parameter in Constant mode.
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
                        _par.mode = type(_par.mode).EXPRESSION
                    except Exception:
                        report["warnings"].append("param '" + str(_a["param"]) + "': could not flip to Expression mode")
                elif _m == "bind":
                    _e = _a.get("expr")
                    if not _e:
                        report["warnings"].append("param '" + str(_a["param"]) + "': expr required for mode 'bind'")
                        continue
                    _par.bindExpr = _e
                    try:
                        _par.mode = type(_par.mode).BIND
                    except Exception:
                        report["warnings"].append("param '" + str(_a["param"]) + "': could not flip to Bind mode")
                elif _m == "reset":
                    # par.reset() clears value+expr+bind+mode in one call. It is not
                    # documented in the bundled Par.json (UNVERIFIED — probe live); the
                    # fallback restores par.default + flips to Constant for a Par without it.
                    _reset = getattr(_par, "reset", None)
                    if callable(_reset):
                        try:
                            _reset()
                        except Exception:
                            report["warnings"].append("param '" + str(_a["param"]) + "': reset() failed")
                    else:
                        try:
                            _par.val = _par.default
                        except Exception:
                            pass
                        try:
                            _par.mode = type(_par.mode).CONSTANT
                        except Exception:
                            pass
                elif _m == "unbind":
                    # Freeze the current driven value as a constant, dropping the driver.
                    try:
                        _frozen = _par.eval()
                        _par.val = _frozen
                        _par.mode = type(_par.mode).CONSTANT
                    except Exception:
                        report["warnings"].append("param '" + str(_a["param"]) + "': could not unbind")
                        continue
                else:
                    _v = _a.get("value")
                    if _v is None:
                        report["warnings"].append("param '" + str(_a["param"]) + "': value required for mode 'constant'")
                        continue
                    _par.val = _v
                    try:
                        _par.mode = type(_par.mode).CONSTANT
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
      // reset/unbind are not yet accepted by the PATCH …/mode endpoint. On an
      // un-upgraded bridge the endpoint would reject the unknown mode as a per-param
      // validation warning while other params succeed — a half-applied batch across a
      // version boundary. To stay correct, if ANY assignment uses reset/unbind, run the
      // whole batch through the exec path (which always works when ALLOW_EXEC=1).
      const needsExec = args.assignments.some((a) => a.mode === "reset" || a.mode === "unbind");
      if (needsExec) {
        const script = buildSetExprScript({
          path: args.path,
          assignments: args.assignments,
        });
        const exec = await ctx.client.executePythonScript(script, true);
        return parsePythonReport<SetParameterExpressionReport>(exec.stdout);
      }
      // 1) first-class per-param endpoint (survives ALLOW_EXEC=0). It flips par.mode
      //    via type(par.mode), which also fixes the silent `ParMode` NameError the
      //    exec path hit. Loop fail-forward — per-item failures become warnings.
      //    If a missing-endpoint error hits BEFORE the endpoint is proven present
      //    (older bridge / 404), abandon the loop and fall back to whole-batch exec.
      const applied: AppliedEntry[] = [];
      const warnings: string[] = [];
      let endpointUsable = true;
      // "Proven present" = any call returned — a success OR a non-missing rejection
      // (the route exists, it just refused that param). Tracking this instead of
      // `i === 0` is correct when earlier assignments are skipped locally (missing
      // expr/value), so the first ACTUAL endpoint call can land at index > 0.
      let endpointProven = false;
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
          endpointProven = true;
          applied.push({
            param: r.param,
            mode: a.mode,
            readback_mode: r.readback_mode,
            readback_expr: r.readback_expr,
          });
        } catch (err) {
          // A missing endpoint BEFORE the route is proven present (older bridge)
          // triggers the whole-batch exec fallback. A validation error (unknown
          // param, missing node — also a TdApiError) is fail-forward per-param,
          // so later valid assignments still apply and ALLOW_EXEC=0 users get the
          // real reason instead of an exec-disabled error.
          if (!endpointProven && isMissingEndpoint(err)) {
            endpointUsable = false;
            break;
          }
          if (err instanceof TdApiError) {
            // The route exists (it rejected this param), so any later error is not
            // a missing endpoint — keep going fail-forward as a per-param warning.
            endpointProven = true;
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
        "Set one or more parameters on a node to an expression, bind expression, or constant value without needing the raw-Python escape hatch. Supports five modes: 'expression' (par.expr = ...), 'bind' (par.bindExpr = ...), 'constant' (par.val = ...), 'reset' (restore the parameter default via par.reset()), and 'unbind' (freeze the current evaluated value as a constant, dropping the driver). Multiple assignments are applied fail-forward — per-item failures accumulate as warnings so a partial batch still returns useful results. Batches using reset/unbind run through the exec path and require TDMCP_BRIDGE_ALLOW_EXEC=1. Use this instead of execute_python_script when TDMCP_RAW_PYTHON is off.",
      inputSchema: setParameterExpressionSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => setParameterExpressionImpl(ctx, args),
  );
};
