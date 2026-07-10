import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const FAMILY_TYPE = {
  CHOP: "scriptCHOP",
  DAT: "scriptDAT",
  SOP: "scriptSOP",
  TOP: "scriptTOP",
} as const;

const customParamSchema = z.object({
  name: z.string().min(1).describe("Custom parameter name; normalized to a TD-legal identifier."),
  default: z
    .union([z.number(), z.string(), z.boolean()])
    .optional()
    .describe(
      "Initial value; type infers the parameter family (number→Float, bool→Toggle, string→Str).",
    ),
});
export type AuthorScriptCustomParam = z.infer<typeof customParamSchema>;

export const authorScriptOperatorSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP to create the Script op inside."),
  name: z.string().optional().describe("Name for the Script op; TD auto-names when omitted."),
  family: z
    .enum(["CHOP", "DAT", "SOP", "TOP"])
    .describe("Script op family — selects the operator type and the onCook stub signature."),
  custom_params: z
    .array(customParamSchema)
    .default([])
    .describe("Custom parameters to append on the Script op's 'Custom' page."),
  on_cook_body: z
    .string()
    .optional()
    .describe(
      "Optional body for onCook(scriptOp); injected verbatim. When omitted a per-family no-op stub is used.",
    ),
});
type AuthorScriptOperatorArgs = z.infer<typeof authorScriptOperatorSchema>;

interface AuthorReport {
  op_path: string;
  callbacks_path: string;
  params_added: string[];
  warnings: string[];
  fatal?: string;
}

/** Normalize a user-supplied custom-par name to a TD-legal identifier (alnum, leading capital). */
export function normalizeParName(raw: string): string {
  let s = raw.replace(/[^A-Za-z0-9]/g, "_");
  if (!s) s = "Par";
  if (!/^[A-Za-z]/.test(s)) s = `P${s}`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const DEFAULT_BODIES: Record<AuthorScriptOperatorArgs["family"], string> = {
  CHOP: `    c = scriptOp.appendChan('chan1')\n    c[0] = 0.0`,
  DAT: `    scriptOp.appendRow(['name', 'value'])`,
  SOP: `    p = scriptOp.appendPoint()\n    p.P = (0.0, 0.0, 0.0)`,
  // The TOP body is the entire copyNumpyArray line, since the spec injects body
  // *in lieu of* the default copyNumpyArray call.
  TOP: `    import numpy\n    scriptOp.copyNumpyArray(numpy.zeros((4,4,4), dtype=numpy.float32))`,
};

/** Build the callbacks DAT text for a given family + optional onCook body. */
export function buildCallbacksText(
  family: AuthorScriptOperatorArgs["family"],
  onCookBody: string | undefined,
): string {
  const body = onCookBody ?? DEFAULT_BODIES[family];
  const typeName = FAMILY_TYPE[family];
  if (family === "TOP") {
    return [
      "# me - this DAT",
      "# scriptOp - the OP which is cooking",
      "def onSetupParameters(scriptOp):",
      "    return",
      "",
      "def onPulse(par):",
      "    return",
      "",
      "def onCook(scriptOp):",
      `    # type: (${typeName}) -> None`,
      body,
      "    return",
      "",
    ].join("\n");
  }
  return [
    "# me - this DAT",
    "# scriptOp - the OP which is cooking",
    "def onSetupParameters(scriptOp):",
    "    return",
    "",
    "def onPulse(par):",
    "    return",
    "",
    "def onCook(scriptOp):",
    `    # type: (${typeName}) -> None`,
    "    scriptOp.clear()",
    body,
    "    return",
    "",
  ].join("\n");
}

// One Python pass: locate the auto-created callbacks DAT, overwrite its text, then
// append custom parameters (Float/Str/Toggle) based on the JS type of each default.
// Collisions and unknown errors are collected as warnings — partial success returns
// a useful report instead of a hard failure.
const AUTHOR_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"op_path": _p["op_path"], "callbacks_path": "", "params_added": [], "warnings": []}
try:
    _op = op(_p["op_path"])
    if _op is None:
        report["fatal"] = "Script op not found: " + _p["op_path"]
    else:
        _cb = None
        try:
            _cb = _op.par.callbacks.eval()
        except Exception:
            _cb = None
        if _cb is None:
            _cb = _op.parent().op(_op.name + '_callbacks')
        if _cb is None:
            report["fatal"] = "Could not resolve callbacks DAT for " + _p["op_path"]
        else:
            _cb.text = _p["callbacks_text"]
            report["callbacks_path"] = _cb.path
            _page = None
            if _p["custom_params"]:
                for _pg in _op.customPages:
                    if _pg.name == "Custom":
                        _page = _pg
                        break
                if _page is None:
                    _page = _op.appendCustomPage("Custom")
            for _cp in _p["custom_params"]:
                try:
                    _name = _cp["name"]
                    if getattr(_op.par, _name, None) is not None:
                        report["warnings"].append("Parameter '%s' already exists — skipped." % _name)
                        continue
                    _dflt = _cp.get("default", None)
                    if isinstance(_dflt, bool):
                        _tup = _page.appendToggle(_name, replace=False)
                        _tup[0].default = _dflt; _tup[0].val = _dflt
                    elif isinstance(_dflt, (int, float)):
                        _tup = _page.appendFloat(_name, replace=False)
                        _tup[0].default = float(_dflt); _tup[0].val = float(_dflt)
                    elif isinstance(_dflt, str):
                        _tup = _page.appendStr(_name, replace=False)
                        _tup[0].default = _dflt; _tup[0].val = _dflt
                    else:
                        _tup = _page.appendFloat(_name, replace=False)
                        _tup[0].default = 0.0; _tup[0].val = 0.0
                    report["params_added"].append(_name)
                except Exception:
                    report["warnings"].append("Failed to add '%s': %s" % (_cp.get("name", "?"), traceback.format_exc().splitlines()[-1]))
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildAuthorScript(payload: object): string {
  return buildPayloadScript(AUTHOR_SCRIPT, payload);
}

export async function authorScriptOperatorImpl(ctx: ToolContext, args: AuthorScriptOperatorArgs) {
  const opType = FAMILY_TYPE[args.family];
  const kbWarnings: string[] = [];
  if (!ctx.knowledge.operatorExists(opType)) {
    kbWarnings.push(
      `Operator type "${opType}" was not found in the knowledge base — proceeding anyway.`,
    );
  }
  const normalizedParams: AuthorScriptCustomParam[] = args.custom_params.map((cp) => ({
    name: normalizeParName(cp.name),
    default: cp.default,
  }));
  const callbacksText = buildCallbacksText(args.family, args.on_cook_body);

  return guardTd(
    async () => {
      const node = await ctx.client.createNode({
        parent_path: args.parent_path,
        type: opType,
        name: args.name,
      });
      const script = buildAuthorScript({
        op_path: node.path,
        callbacks_text: callbacksText,
        custom_params: normalizedParams,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      const report = parsePythonReport<AuthorReport>(exec.stdout);
      return { node, report };
    },
    ({ node, report }) => {
      if (report.fatal) {
        return errorResult(`Could not author Script ${args.family}: ${report.fatal}`, {
          node,
          report,
          warnings: [...kbWarnings, ...(report.warnings ?? [])],
        });
      }
      const allWarnings = [...kbWarnings, ...(report.warnings ?? [])];
      const summary = `Authored Script ${args.family} at ${report.op_path} (${report.params_added.length} custom par(s)${
        allWarnings.length ? `, ${allWarnings.length} warning(s)` : ""
      }).`;
      return jsonResult(summary, {
        node,
        op_path: report.op_path,
        callbacks_path: report.callbacks_path,
        params_added: report.params_added,
        warnings: allWarnings,
      });
    },
  );
}

export const registerAuthorScriptOperator: ToolRegistrar = (server, ctx) => {
  // This tool persists caller-supplied Python in a callbacks DAT, so it is a
  // raw-Python escape hatch and must obey TDMCP_RAW_PYTHON=off.
  if (ctx.allowRawPython === false) return;
  server.registerTool(
    "author_script_operator",
    {
      title: "Author Script operator",
      description:
        "Scaffold a Script CHOP/DAT/SOP/TOP with a ready-to-edit onCook(scriptOp) stub and optional custom parameters. Creates the Script op plus its companion callbacks DAT, writes a per-family stub (chan/row/point/numpy) — or your `on_cook_body` — and appends Float/Toggle/Str custom pars inferred from each default's type. Returns {op_path, callbacks_path, params_added, warnings}. Note: Script ops only cook when something requests them, so a paused timeline + no downstream consumer means no cook (not a bug).",
      inputSchema: authorScriptOperatorSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (args) => authorScriptOperatorImpl(ctx, args),
  );
};
