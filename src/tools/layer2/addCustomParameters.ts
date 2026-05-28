import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const paramSchema = z.object({
  name: z
    .string()
    .describe(
      "Becomes a TD custom-parameter name; auto-capitalized to leading-uppercase (e.g. 'blur radius' → 'Blurradius').",
    ),
  type: z
    .enum(["Float", "Int", "Toggle", "Menu", "Str", "Pulse", "RGB", "XYZ"])
    .describe(
      "Parameter widget kind: Float/Int sliders, Toggle checkbox, Menu dropdown, Str text field, Pulse momentary button, RGB colour swatch, XYZ 3-component vector.",
    ),
  label: z
    .string()
    .optional()
    .describe("Display label shown in the parameter panel; defaults to `name` if omitted."),
  default: z
    .union([z.number(), z.boolean(), z.string(), z.array(z.number())])
    .optional()
    .describe(
      "Initial value. For RGB/XYZ pass a 3-element array of floats (0–1) or a hex string '#rrggbb' for RGB.",
    ),
  min: z.coerce
    .number()
    .optional()
    .describe(
      "Float/Int slider lower bound — sets normMin (soft) and, when clamp is true, also min/clampMin (hard).",
    ),
  max: z.coerce
    .number()
    .optional()
    .describe(
      "Float/Int slider upper bound — sets normMax (soft) and, when clamp is true, also max/clampMax (hard).",
    ),
  clamp: z
    .boolean()
    .optional()
    .describe(
      "When true, also hard-clamps the parameter so values cannot exceed [min,max] regardless of how the artist types.",
    ),
  menu_names: z
    .array(z.string())
    .optional()
    .describe(
      "Menu option keys (internal identifiers). Required for Menu parameters; ignored for other types.",
    ),
  menu_labels: z
    .array(z.string())
    .optional()
    .describe(
      "Menu option display labels shown in the dropdown. Defaults to menu_names if omitted.",
    ),
  size: z.coerce
    .number()
    .int()
    .optional()
    .describe(
      "Vector size for Float parameters (e.g. size=2 → appendFloat(name, size=2) for a 2-component float). Ignored for other types.",
    ),
});

export const addCustomParametersSchema = z.object({
  comp_path: z
    .string()
    .describe(
      "Path to the COMP that will receive the custom parameter page (e.g. '/project1/myComp').",
    ),
  page: z
    .string()
    .default("Custom")
    .describe("Name of the custom-parameter page to create or append to (defaults to 'Custom')."),
  params: z
    .array(paramSchema)
    .min(1)
    .describe(
      "One or more parameter specs to append. Duplicates (params whose TD name already exists on the COMP) are skipped, not fatal.",
    ),
});

type AddCustomParametersArgs = z.infer<typeof addCustomParametersSchema>;

interface ParamEntry {
  name: string;
  type: string;
  pars: string[];
}

interface SkippedEntry {
  name: string;
  reason: string;
}

interface AddParamsReport {
  comp: string;
  page: string;
  created: ParamEntry[];
  skipped: SkippedEntry[];
  warnings: string[];
  fatal?: string;
}

// One Python pass: find-or-create a custom page on the target COMP, then append
// each declared parameter. Duplicate names are skipped (not fatal) so this tool
// is idempotent-safe when called twice on the same COMP. appendXYZ is a first-class
// citizen here (unlike create_control_panel which lacks it). ParMode is not in the
// exec globals, so we don't need it — this tool doesn't bind parameters by expression.
const ADD_PARAMS_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"comp": _p["comp"], "page": _p["page"], "created": [], "skipped": [], "warnings": []}

def _parname(s):
    s = "".join(ch for ch in s if ch.isalnum())
    if not s:
        s = "Par"
    if not s[0].isalpha():
        s = "P" + s
    return s[0].upper() + s[1:].lower()

def _parse_rgb(v):
    try:
        if isinstance(v, (list, tuple)) and len(v) >= 3:
            return [float(v[0]), float(v[1]), float(v[2])]
        s = str(v).strip().lstrip("#")
        if len(s) == 6:
            return [int(s[0:2], 16) / 255.0, int(s[2:4], 16) / 255.0, int(s[4:6], 16) / 255.0]
    except Exception:
        pass
    return None

try:
    _comp = op(_p["comp"])
    if _comp is None:
        report["fatal"] = "COMP not found: " + str(_p["comp"])
    elif not hasattr(_comp, "appendCustomPage"):
        report["fatal"] = str(_p["comp"]) + " is not a COMP, so it cannot hold custom parameters."
    else:
        _page_name = _parname(_p["page"]) if _p["page"] else "Custom"
        _page = None
        for _pg in _comp.customPages:
            if _pg.name == _page_name:
                _page = _pg
                break
        if _page is None:
            _page = _comp.appendCustomPage(_page_name)
        for _spec in _p["params"]:
            try:
                _Name = _parname(_spec["name"])
                _typ = _spec.get("type", "Float")
                _label = _spec.get("label") or _spec["name"]
                if getattr(_comp.par, _Name, None) is not None:
                    report["skipped"].append({"name": _Name, "reason": "parameter already exists"})
                    continue
                _pg_group = None
                if _typ == "Float":
                    _sz = _spec.get("size", None)
                    if _sz is not None and isinstance(_sz, int) and _sz > 1:
                        _pg_group = _page.appendFloat(_Name, label=_label, size=_sz)
                    else:
                        _pg_group = _page.appendFloat(_Name, label=_label)
                elif _typ == "Int":
                    _pg_group = _page.appendInt(_Name, label=_label)
                elif _typ == "Toggle":
                    _pg_group = _page.appendToggle(_Name, label=_label)
                elif _typ == "Menu":
                    _pg_group = _page.appendMenu(_Name, label=_label)
                elif _typ == "Str":
                    _pg_group = _page.appendStr(_Name, label=_label)
                elif _typ == "Pulse":
                    _pg_group = _page.appendPulse(_Name, label=_label)
                elif _typ == "RGB":
                    _pg_group = _page.appendRGB(_Name, label=_label)
                elif _typ == "XYZ":
                    _pg_group = _page.appendXYZ(_Name, label=_label)
                else:
                    report["warnings"].append("Unknown parameter type '%s' for '%s'." % (_typ, _spec["name"]))
                    continue
                _dflt = _spec.get("default", None)
                _mn = _spec.get("min", None)
                _mx = _spec.get("max", None)
                _clamp = bool(_spec.get("clamp", False))
                if _typ in ("Float", "Int"):
                    _p0 = _pg_group[0]
                    if _mn is not None:
                        _p0.normMin = _mn
                        if _clamp:
                            _p0.min = _mn
                            _p0.clampMin = True
                    if _mx is not None:
                        _p0.normMax = _mx
                        if _clamp:
                            _p0.max = _mx
                            _p0.clampMax = True
                    if _dflt is not None:
                        if isinstance(_dflt, list):
                            for _i, _par in enumerate(_pg_group):
                                if _i < len(_dflt):
                                    _par.default = _dflt[_i]; _par.val = _dflt[_i]
                        else:
                            _p0.default = _dflt; _p0.val = _dflt
                elif _typ == "Toggle":
                    if _dflt is not None:
                        _pg_group[0].default = bool(_dflt); _pg_group[0].val = bool(_dflt)
                elif _typ == "Str":
                    if _dflt is not None:
                        _pg_group[0].default = str(_dflt); _pg_group[0].val = str(_dflt)
                elif _typ == "Menu":
                    _mnames = _spec.get("menu_names") or []
                    _mlabels = _spec.get("menu_labels") or _mnames
                    if _mnames:
                        _pg_group[0].menuNames = [str(x) for x in _mnames]
                        _pg_group[0].menuLabels = [str(x) for x in _mlabels]
                    if _dflt is not None and str(_dflt) in [str(x) for x in _mnames]:
                        _pg_group[0].default = str(_dflt); _pg_group[0].val = str(_dflt)
                elif _typ == "RGB":
                    if _dflt is not None:
                        _rgb = _parse_rgb(_dflt)
                        if _rgb is not None:
                            for _i in range(min(3, len(_pg_group))):
                                _pg_group[_i].default = _rgb[_i]; _pg_group[_i].val = _rgb[_i]
                elif _typ == "XYZ":
                    if _dflt is not None and isinstance(_dflt, (list, tuple)) and len(_dflt) >= 3:
                        for _i in range(min(3, len(_pg_group))):
                            _pg_group[_i].default = float(_dflt[_i]); _pg_group[_i].val = float(_dflt[_i])
                report["created"].append({"name": _Name, "type": _typ, "pars": [pp.name for pp in _pg_group]})
            except Exception:
                report["warnings"].append("Failed to create parameter '%s': %s" % (_spec.get("name", "?"), traceback.format_exc().splitlines()[-1]))
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildAddCustomParametersScript(payload: object): string {
  return buildPayloadScript(ADD_PARAMS_SCRIPT, payload);
}

export async function addCustomParametersImpl(ctx: ToolContext, args: AddCustomParametersArgs) {
  return guardTd(
    async () => {
      const script = buildAddCustomParametersScript({
        comp: args.comp_path,
        page: args.page,
        params: args.params,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<AddParamsReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not add custom parameters: ${report.fatal}`, report);
      }
      const n = report.created.length;
      const k = report.skipped.length;
      const w = report.warnings.length;
      const summary =
        `Added ${n} parameter(s) on page "${report.page}" of ${report.comp}` +
        (k > 0 ? ` (${k} skipped` : "") +
        (k > 0 && w > 0 ? `, ${w} warning(s))` : k > 0 ? ")" : "") +
        (k === 0 && w > 0 ? `, ${w} warning(s)` : "") +
        ".";
      return jsonResult(summary, report);
    },
  );
}

export const registerAddCustomParameters: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "add_custom_parameters",
    {
      title: "Add custom parameters",
      description:
        "Append a declarative custom-parameter page to any COMP: Float/Int sliders, Toggle, Menu dropdown, Str text, Pulse button, RGB colour swatch, or XYZ 3-component vector. Lower-level and more declarative than create_control_panel — no bind_to wiring, but adds XYZ and per-parameter options (clamp, separate menu_names/menu_labels, vector size). Duplicate names are skipped, not fatal, so the call is safe to repeat.",
      inputSchema: addCustomParametersSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => addCustomParametersImpl(ctx, args),
  );
};
