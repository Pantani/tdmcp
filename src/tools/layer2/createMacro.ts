import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const macroTargetSchema = z.object({
  param: z.string().describe("Parameter to drive, written as 'nodePath.parName'."),
  min: z.coerce.number().describe("Value this target takes when the macro is at 0."),
  max: z.coerce.number().describe("Value this target takes when the macro is at 1."),
  curve: z.coerce
    .number()
    .positive()
    .default(1)
    .describe("Response curve exponent: 1 = linear, >1 = ease-in, <1 = ease-out."),
});

export const createMacroSchema = z.object({
  comp_path: z
    .string()
    .default("/project1")
    .describe("COMP that will hold the macro knob (usually a control-panel container)."),
  name: z.string().describe("Macro control name, e.g. 'Energy' or 'Intensity'."),
  default: z.coerce.number().min(0).max(1).default(0).describe("Initial macro value (0–1)."),
  targets: z
    .array(macroTargetSchema)
    .min(1)
    .describe("Parameters this macro drives, each remapped from the macro's 0–1 into [min,max]."),
});
type CreateMacroArgs = z.infer<typeof createMacroSchema>;

interface MacroReport {
  comp: string;
  macro?: string;
  bound: string[];
  warnings: string[];
  fatal?: string;
}

// One Python pass: find-or-create a 0..1 float custom parameter (the macro knob), then bind
// each target parameter by expression to a remap of the macro into that target's [min,max]
// (with an optional curve exponent). ParMode isn't in the exec globals, so the expression
// enum is derived from a live parameter (type(par.mode)).
const MACRO_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"comp": _p["comp"], "bound": [], "warnings": []}
_c = op(_p["comp"])
try:
    if _c is None:
        report["fatal"] = "COMP not found: " + _p["comp"]
    elif not hasattr(_c, "appendCustomPage"):
        report["fatal"] = _p["comp"] + " is not a COMP, so it cannot hold a macro knob."
    else:
        _raw = _p["name"]
        _pn = "".join(ch for ch in _raw if ch.isalnum())
        _pn = (_pn[0].upper() + _pn[1:]) if _pn else "Macro"
        _par = getattr(_c.par, _pn, None)
        if _par is None:
            _page = None
            for _pg in _c.customPages:
                if _pg.name == "Macros":
                    _page = _pg; break
            if _page is None:
                _page = _c.appendCustomPage("Macros")
            _par = _page.appendFloat(_pn, label=_raw)[0]
            _par.normMin = 0.0; _par.normMax = 1.0
            _par.default = _p["default"]; _par.val = _p["default"]
        report["macro"] = _pn
        _mref = "op(%s).par.%s" % (repr(_c.path), _pn)
        for _t in _p["targets"]:
            try:
                _path = _t["param"]; _dot = _path.rfind(".")
                if _dot <= 0:
                    report["warnings"].append("Invalid target '%s' (expected 'nodePath.parName')." % _path); continue
                _np = _path[:_dot]; _prn = _path[_dot + 1:]; _n = op(_np)
                if _n is None:
                    report["warnings"].append("Target node not found: " + _np); continue
                _tp = getattr(_n.par, _prn, None)
                if _tp is None:
                    report["warnings"].append("Target parameter not found: " + _path); continue
                _lo = _t["min"]; _hi = _t["max"]; _curve = _t.get("curve", 1.0)
                _m = _mref if _curve == 1.0 else "(%s ** %s)" % (_mref, repr(_curve))
                _expr = "%s + (%s) * (%s)" % (repr(_lo), repr(_hi - _lo), _m)
                _PM = type(_tp.mode)
                _tp.expr = _expr; _tp.mode = _PM.EXPRESSION
                report["bound"].append(_path)
            except Exception:
                report["warnings"].append("Failed to bind %s: %s" % (_t.get("param", "?"), traceback.format_exc().splitlines()[-1]))
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildMacroScript(payload: object): string {
  return buildPayloadScript(MACRO_SCRIPT, payload);
}

export async function createMacroImpl(ctx: ToolContext, args: CreateMacroArgs) {
  return guardTd(
    async () => {
      const script = buildMacroScript({
        comp: args.comp_path,
        name: args.name,
        default: args.default,
        targets: args.targets,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<MacroReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return jsonResult(`Could not create macro: ${report.fatal}`, report);
      }
      const summary = `Macro "${report.macro}" on ${report.comp} drives ${report.bound.length} parameter(s)${
        report.warnings.length ? `, ${report.warnings.length} warning(s)` : ""
      }.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerCreateMacro: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_macro",
    {
      title: "Create macro control",
      description:
        "Add one macro knob (a 0–1 custom parameter) to a COMP that drives many parameters at once, each remapped into its own [min,max] range with an optional response curve — a one-to-many control for sweeping a whole look from a single fader. Targets are bound by expression so they track the macro live.",
      inputSchema: createMacroSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createMacroImpl(ctx, args),
  );
};
