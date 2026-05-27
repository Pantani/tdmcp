import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const randomizeControlsSchema = z.object({
  comp_path: z
    .string()
    .default("/project1")
    .describe("COMP whose custom parameters to randomize (usually a control-panel container)."),
  params: z
    .array(z.string())
    .optional()
    .describe("Specific custom-parameter names to randomize. Defaults to every numeric one."),
  amount: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(1)
    .describe(
      "How far to move toward a random value in range: 1 = fully random, 0.2 = a gentle nudge from the current value. Lets you improvise without losing the current look.",
    ),
  seed: z.coerce.number().int().optional().describe("Optional RNG seed for repeatable results."),
});
type RandomizeControlsArgs = z.infer<typeof randomizeControlsSchema>;

interface RandomizeReport {
  comp: string;
  randomized: Array<{ name: string; value: number }>;
  skipped: string[];
  warnings: string[];
  fatal?: string;
}

// One Python pass: for each numeric custom parameter, pick a value in its slider range
// (normMin..normMax) and blend toward it by `amount`. Non-numeric params (toggles, menus,
// strings) are skipped, so a randomize is always safe to fire live.
const RANDOMIZE_SCRIPT = `
import json, base64, traceback, random
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"comp": _p["comp"], "randomized": [], "skipped": [], "warnings": []}
_c = op(_p["comp"])
try:
    if _c is None:
        report["fatal"] = "COMP not found: " + _p["comp"]
    elif not hasattr(_c, "customPars"):
        report["fatal"] = _p["comp"] + " is not a COMP, so it has no custom parameters."
    else:
        if _p.get("seed") is not None:
            random.seed(_p["seed"])
        _amt = _p["amount"]
        _wanted = _p.get("params")
        _pars = list(_c.customPars) if not _wanted else [getattr(_c.par, n, None) for n in _wanted]
        for _par in _pars:
            if _par is None:
                continue
            if not getattr(_par, "isNumber", False) or _par.readOnly:
                report["skipped"].append(getattr(_par, "name", "?")); continue
            _lo = _par.normMin; _hi = _par.normMax
            if _lo is None or _hi is None or _hi <= _lo:
                report["skipped"].append(_par.name); continue
            try:
                _old = float(_par.eval())
            except Exception:
                _old = _lo
            _r = random.uniform(_lo, _hi)
            _new = _old * (1 - _amt) + _r * _amt
            if _par.style == "Int":
                _new = int(round(_new))
            try:
                _par.val = _new
                report["randomized"].append({"name": _par.name, "value": _new})
            except Exception:
                report["warnings"].append("Could not set " + _par.name)
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildRandomizeScript(payload: object): string {
  return buildPayloadScript(RANDOMIZE_SCRIPT, payload);
}

export async function randomizeControlsImpl(ctx: ToolContext, args: RandomizeControlsArgs) {
  return guardTd(
    async () => {
      const script = buildRandomizeScript({
        comp: args.comp_path,
        params: args.params ?? null,
        amount: args.amount,
        seed: args.seed ?? null,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<RandomizeReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return jsonResult(`Randomize failed: ${report.fatal}`, report);
      }
      const summary = `Randomized ${report.randomized.length} control(s) on ${report.comp} (amount ${args.amount})${
        report.skipped.length ? `, skipped ${report.skipped.length} non-numeric` : ""
      }.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerRandomizeControls: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "randomize_controls",
    {
      title: "Randomize controls",
      description:
        "Randomize a COMP's numeric custom parameters within their slider ranges — an instant new variation for live improvisation. `amount` blends toward random (1 = fully random, low values nudge the current look). Non-numeric controls (toggles, menus) are left untouched, so it is always safe to fire. Pair with manage_presets/manage_cue to snapshot a happy accident.",
      inputSchema: randomizeControlsSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => randomizeControlsImpl(ctx, args),
  );
};
