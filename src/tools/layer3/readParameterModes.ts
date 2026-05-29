import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const parameterModeInfoSchema = z.object({
  name: z.string(),
  mode: z.string(),
  value: z.unknown().optional(),
  expression: z.string().optional(),
  bind_expression: z.string().optional(),
  export_source: z.string().optional(),
});

export const readParameterModesSchema = z.object({
  path: z.string().describe("Full path of the node whose parameter modes should be inspected."),
  keys: z
    .array(z.string())
    .optional()
    .describe("Optional parameter names to return. Omit to inspect every custom/built-in par."),
});
type ReadParameterModesArgs = z.infer<typeof readParameterModesSchema>;

export const readParameterModesOutputSchema = z.object({
  path: z.string(),
  parameters: z.record(z.string(), parameterModeInfoSchema),
  warnings: z.array(z.string()),
});

export type ParameterModeInfo = z.infer<typeof parameterModeInfoSchema>;

interface ReadParameterModesReport {
  path: string;
  parameters: Record<string, ParameterModeInfo>;
  warnings: string[];
  fatal?: string;
}

const READ_PARAMETER_MODES_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"path": _p["path"], "parameters": {}, "warnings": []}

def _mode_name(par):
    try:
        m = par.mode
        return getattr(m, "name", None) or str(m).split(".")[-1]
    except Exception:
        return "unknown"

def _safe_value(par):
    try:
        return par.eval()
    except Exception:
        try:
            return par.val
        except Exception:
            return None

def _safe_str(value):
    if value is None:
        return None
    try:
        text = str(value)
        return text if text else None
    except Exception:
        return None

def _par_info(par):
    info = {"name": par.name, "mode": _mode_name(par), "value": _safe_value(par)}
    expr = _safe_str(getattr(par, "expr", None))
    if expr is not None:
        info["expression"] = expr
    bind_expr = _safe_str(getattr(par, "bindExpr", None))
    if bind_expr is not None:
        info["bind_expression"] = bind_expr
    export_source = None
    for attr in ("exportSource", "exportOP", "exportPath"):
        try:
            v = getattr(par, attr, None)
            if v:
                export_source = getattr(v, "path", None) or str(v)
                break
        except Exception:
            pass
    if export_source:
        info["export_source"] = export_source
    return info

try:
    node = op(_p["path"])
    if node is None:
        report["fatal"] = "Node not found: " + _p["path"]
    else:
        keys = set(_p.get("keys") or [])
        for par in node.pars():
            if keys and par.name not in keys:
                continue
            try:
                report["parameters"][par.name] = _par_info(par)
            except Exception:
                report["warnings"].append("Could not inspect parameter " + getattr(par, "name", "?"))
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
      const exec = await ctx.client.executePythonScript(
        buildReadParameterModesScript({
          path: args.path,
          keys: args.keys,
        }),
        true,
      );
      return parsePythonReport<ReadParameterModesReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) return errorResult(`read_parameter_modes failed: ${report.fatal}`, report);
      const count = Object.keys(report.parameters).length;
      return structuredResult(`Read ${count} parameter mode(s) for ${report.path}.`, report);
    },
  );
}

export const registerReadParameterModes: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "read_parameter_modes",
    {
      title: "Read parameter modes",
      description:
        "Read a node's parameter modes (constant/expression/bind/export where TouchDesigner exposes them) plus expressions and binding/export hints. Use this before serializing or safely changing reactive parameters; get_td_node_parameters only returns evaluated values.",
      inputSchema: readParameterModesSchema.shape,
      outputSchema: readParameterModesOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => readParameterModesImpl(ctx, args),
  );
};
