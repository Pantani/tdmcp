import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const expressionTarget = z
  .string()
  .regex(/^\/.+\.[A-Za-z_][A-Za-z0-9_]*$/, "target must look like /path/to/node.param");

export const setParameterExpressionSchema = z.object({
  target: expressionTarget.describe(
    "Parameter to switch to expression mode, written as '/node/path.param'.",
  ),
  expression: z
    .string()
    .min(1)
    .describe(
      "TouchDesigner Python expression to assign to the parameter, e.g. \"op('/x')['bass'] * 2\".",
    ),
  preserve_on_error: z
    .boolean()
    .default(true)
    .describe(
      "If switching mode fails after editing the expression, try to restore the prior state.",
    ),
});
type SetParameterExpressionArgs = z.infer<typeof setParameterExpressionSchema>;

const modeSnapshotSchema = z.object({
  mode: z.string(),
  expression: z.string().optional(),
  value: z.unknown().optional(),
});

export const setParameterExpressionOutputSchema = z.object({
  target: z.string(),
  node: z.string(),
  parameter: z.string(),
  before: modeSnapshotSchema,
  after: modeSnapshotSchema,
  warnings: z.array(z.string()),
});

interface SetParameterExpressionReport {
  target: string;
  node: string;
  parameter: string;
  before: z.infer<typeof modeSnapshotSchema>;
  after: z.infer<typeof modeSnapshotSchema>;
  warnings: string[];
  fatal?: string;
}

const SET_PARAMETER_EXPRESSION_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"target": _p["target"], "node": "", "parameter": "", "before": {}, "after": {}, "warnings": []}

def _mode_name(par):
    try:
        m = par.mode
        return getattr(m, "name", None) or str(m).split(".")[-1]
    except Exception:
        return "unknown"

def _snapshot(par):
    snap = {"mode": _mode_name(par)}
    try:
        snap["value"] = par.eval()
    except Exception:
        try:
            snap["value"] = par.val
        except Exception:
            pass
    try:
        expr = str(par.expr)
        if expr:
            snap["expression"] = expr
    except Exception:
        pass
    return snap

try:
    target = _p["target"]
    node_path, par_name = target.rsplit(".", 1)
    report["node"] = node_path
    report["parameter"] = par_name
    node = op(node_path)
    if node is None:
        report["fatal"] = "Node not found: " + node_path
    elif not hasattr(node.par, par_name):
        report["fatal"] = "Parameter not found: " + target
    else:
        par = getattr(node.par, par_name)
        report["before"] = _snapshot(par)
        old_expr = getattr(par, "expr", "")
        old_mode = getattr(par, "mode", None)
        try:
            par.expr = _p["expression"]
            par.mode = type(par.mode).EXPRESSION
        except Exception as exc:
            if _p.get("preserve_on_error", True):
                try:
                    par.expr = old_expr
                    if old_mode is not None:
                        par.mode = old_mode
                except Exception as restore_exc:
                    report["warnings"].append("Could not restore prior parameter state: " + str(restore_exc))
            report["fatal"] = "Failed to set expression on " + target + ": " + str(exc)
        report["after"] = _snapshot(par)
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildSetParameterExpressionScript(payload: object): string {
  return buildPayloadScript(SET_PARAMETER_EXPRESSION_SCRIPT, payload);
}

export async function setParameterExpressionImpl(
  ctx: ToolContext,
  args: SetParameterExpressionArgs,
) {
  return guardTd(
    async () => {
      const exec = await ctx.client.executePythonScript(
        buildSetParameterExpressionScript({
          target: args.target,
          expression: args.expression,
          preserve_on_error: args.preserve_on_error,
        }),
        true,
      );
      return parsePythonReport<SetParameterExpressionReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`set_parameter_expression failed: ${report.fatal}`, report);
      }
      return structuredResult(
        `Set ${report.target} to expression mode (${report.after.expression ?? args.expression}).`,
        report,
      );
    },
  );
}

export const registerSetParameterExpression: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "set_parameter_expression",
    {
      title: "Set parameter expression",
      description:
        "Switch one parameter into expression mode and assign a TouchDesigner Python expression. Use this when update_td_node_parameters would incorrectly replace a live/reactive expression with a constant value.",
      inputSchema: setParameterExpressionSchema.shape,
      outputSchema: setParameterExpressionOutputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => setParameterExpressionImpl(ctx, args),
  );
};
