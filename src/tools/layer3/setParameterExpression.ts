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
                            continue
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

type Assignment = SetParameterExpressionArgs["assignments"][number];

/** Whole-batch exec path (ALLOW_EXEC=1): used for reset/unbind and older-bridge fallback. */
async function runBatchViaExec(
  ctx: ToolContext,
  args: SetParameterExpressionArgs,
): Promise<SetParameterExpressionReport> {
  const script = buildSetExprScript({ path: args.path, assignments: args.assignments });
  const exec = await ctx.client.executePythonScript(script, true);
  return parsePythonReport<SetParameterExpressionReport>(exec.stdout);
}

/** The local pre-flight the exec path mirrors: a required field is missing for this mode. */
function preflightWarning(a: Assignment): string | undefined {
  if ((a.mode === "expression" || a.mode === "bind") && !a.expr) {
    return `param '${a.param}': expr required for mode '${a.mode}'`;
  }
  if (a.mode === "constant" && a.value === undefined) {
    return `param '${a.param}': value required for mode 'constant'`;
  }
  return undefined;
}

/**
 * Outcome of one per-param attempt. `proven` on a `warned` result records whether
 * the endpoint actually responded (an endpoint rejection proves the route is
 * present; a local pre-flight skip does not). `abandon` means a missing-endpoint
 * hit before the route was proven present, so the caller falls back to exec.
 */
type AttemptResult =
  | { kind: "applied"; entry: AppliedEntry }
  | { kind: "warned"; warning: string; proven: boolean }
  | { kind: "abandon" };

/** Map a failed endpoint call to a per-param result (abandon / warn / rethrow). */
function classifyEndpointError(
  a: Assignment,
  endpointProven: boolean,
  err: unknown,
): AttemptResult {
  // A missing endpoint BEFORE the route is proven present (older bridge) abandons
  // the loop for the whole-batch exec fallback. Any other TdApiError is a
  // validation rejection from a PRESENT route — fail-forward as a per-param warning
  // and mark the route proven.
  if (!endpointProven && isMissingEndpoint(err)) return { kind: "abandon" };
  if (err instanceof TdApiError) {
    return { kind: "warned", warning: `param '${a.param}': ${err.message}`, proven: true };
  }
  throw err; // connection/timeout -> guardTd
}

/** Classify one assignment: local pre-flight, then the endpoint attempt. */
async function classifyAssignment(
  ctx: ToolContext,
  path: string,
  a: Assignment,
  endpointProven: boolean,
): Promise<AttemptResult> {
  const warning = preflightWarning(a);
  if (warning) return { kind: "warned", warning, proven: false };
  try {
    const r = await ctx.client.setParameterMode(path, a.param, a.mode, a.expr, a.value);
    return {
      kind: "applied",
      entry: {
        param: r.param,
        mode: a.mode,
        readback_mode: r.readback_mode,
        readback_expr: r.readback_expr,
      },
    };
  } catch (err) {
    return classifyEndpointError(a, endpointProven, err);
  }
}

/** Fail-forward accumulator for the per-param endpoint loop. */
interface EndpointBatch {
  applied: AppliedEntry[];
  warnings: string[];
  // "Proven present" = an endpoint call returned (success OR a non-missing
  // rejection). A local pre-flight skip does NOT prove the route, so the first
  // ACTUAL endpoint call can land at index > 0.
  endpointProven: boolean;
}

/** Fold one classified result into the batch; returns false when the loop must abandon. */
function foldResult(batch: EndpointBatch, result: AttemptResult): boolean {
  if (result.kind === "abandon") return false;
  if (result.kind === "applied") {
    batch.endpointProven = true;
    batch.applied.push(result.entry);
    return true;
  }
  if (result.proven) batch.endpointProven = true;
  batch.warnings.push(result.warning);
  return true;
}

/**
 * First-class per-param endpoint path (survives ALLOW_EXEC=0), fail-forward.
 * Returns the report, or `null` when the endpoint is absent (older bridge) so the
 * caller falls back to whole-batch exec.
 */
async function runBatchViaEndpoint(
  ctx: ToolContext,
  args: SetParameterExpressionArgs,
): Promise<SetParameterExpressionReport | null> {
  const batch: EndpointBatch = { applied: [], warnings: [], endpointProven: false };
  for (const a of args.assignments) {
    if (!a) continue;
    const result = await classifyAssignment(ctx, args.path, a, batch.endpointProven);
    if (!foldResult(batch, result)) return null;
  }
  return { path: args.path, applied: batch.applied, warnings: batch.warnings };
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
      if (needsExec) return runBatchViaExec(ctx, args);
      // Prefer the per-param endpoint; a null return means the route is absent
      // (older bridge), so fall back to the whole-batch exec path.
      const report = await runBatchViaEndpoint(ctx, args);
      return report ?? runBatchViaExec(ctx, args);
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
