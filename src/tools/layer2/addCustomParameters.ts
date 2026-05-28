import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const paramSchema = z.object({
  name: z
    .string()
    .describe("Parameter name; sanitized to a valid TD custom-par name (e.g. 'blur amount')."),
  type: z
    .enum(["Float", "Int", "Toggle", "Menu", "Str", "Pulse", "RGB", "XYZ"])
    .describe("Widget kind. TD's append* picks the underlying parameter family."),
  label: z.string().optional().describe("Display label (defaults to `name`)."),
  default: z
    .union([z.number(), z.string(), z.boolean(), z.array(z.number())])
    .optional()
    .describe(
      "Initial value: a number; a string for Str/Menu (or '#rrggbb' for RGB); a bool for Toggle; or a number array for RGB/XYZ or a multi-component (size > 1) Float/Int.",
    ),
  min: z.coerce.number().optional().describe("Slider lower bound (Float/Int) — sets normMin."),
  max: z.coerce.number().optional().describe("Slider upper bound (Float/Int) — sets normMax."),
  clamp: z
    .boolean()
    .default(false)
    .describe("Hard-clamp the value to [min,max] (sets min/max + clampMin/clampMax)."),
  menu_names: z.array(z.string()).optional().describe("(Menu) stored option keys."),
  menu_labels: z
    .array(z.string())
    .optional()
    .describe("(Menu) display labels (defaults to names)."),
  size: z.coerce
    .number()
    .int()
    .min(1)
    .max(4)
    .optional()
    .describe("(Float/Int) number of components for a multi-value parameter (1–4)."),
});

export const addCustomParametersSchema = z.object({
  comp_path: z.string().describe("The COMP to add custom parameters to."),
  page: z
    .string()
    .default("Custom")
    .describe("Custom-parameter page name (auto-capitalized; created if missing)."),
  params: z
    .array(paramSchema)
    .min(1)
    .describe("The parameters (knobs/menus/toggles/pulses) to append."),
});
type AddCustomParametersArgs = z.infer<typeof addCustomParametersSchema>;

interface ParamsReport {
  comp: string;
  page: string;
  added: string[];
  skipped: string[];
  warnings: string[];
  fatal?: string;
}

// Appending custom parameters is an attribute-level operation with no structured
// bridge endpoint, so the whole page is built in one Python pass. TD requires
// custom page/parameter names to start with an uppercase letter, so names are
// sanitized to alphanumerics with a leading capital (the human-readable original
// survives as the label). A parameter that already exists is skipped (not
// replaced) and reported as a warning so a partial add still returns useful info.
const PARAMS_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"comp": _p["comp"], "page": _p["page"], "added": [], "skipped": [], "warnings": []}

def _parname(s):
    s = "".join(ch for ch in s if ch.isalnum())
    if not s:
        s = "Par"
    if not s[0].isalpha():
        s = "P" + s
    # TD custom-parameter names are a leading uppercase letter then lowercase
    # letters/digits, so lowercase the tail (camelCase like 'CamZoom' is rejected).
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

_comp = op(_p["comp"])
try:
    if _comp is None:
        report["fatal"] = "COMP not found: " + _p["comp"]
    elif not hasattr(_comp, "appendCustomPage"):
        report["fatal"] = _p["comp"] + " is not a COMP, so it cannot hold custom parameters."
    else:
        _page_name = _p["page"]
        _page = None
        for _pg in _comp.customPages:
            if _pg.name == _page_name:
                _page = _pg
                break
        if _page is None:
            _page = _comp.appendCustomPage(_page_name)
        for _spec in _p["params"]:
            try:
                _name = _parname(_spec["name"]); _typ = _spec["type"]; _label = _spec.get("label") or _spec["name"]
                if getattr(_comp.par, _name, None) is not None:
                    report["skipped"].append(_name)
                    report["warnings"].append("Parameter '%s' already exists on %s — skipped." % (_name, _p["comp"]))
                    continue
                _size = _spec.get("size") or 1
                if _typ == "Float":
                    _pg = _page.appendFloat(_name, label=_label, size=_size)
                elif _typ == "Int":
                    _pg = _page.appendInt(_name, label=_label, size=_size)
                elif _typ == "Toggle":
                    _pg = _page.appendToggle(_name, label=_label)
                elif _typ == "Menu":
                    _pg = _page.appendMenu(_name, label=_label)
                elif _typ == "Str":
                    _pg = _page.appendStr(_name, label=_label)
                elif _typ == "Pulse":
                    _pg = _page.appendPulse(_name, label=_label)
                elif _typ == "RGB":
                    _pg = _page.appendRGB(_name, label=_label)
                elif _typ == "XYZ":
                    _pg = _page.appendXYZ(_name, label=_label)
                else:
                    report["warnings"].append("Unknown parameter type '%s' for '%s'." % (_typ, _spec["name"]))
                    continue
                _p0 = _pg[0]; _dflt = _spec.get("default", None); _clamp = bool(_spec.get("clamp"))
                if _typ in ("Float", "Int"):
                    _mn = _spec.get("min", None); _mx = _spec.get("max", None)
                    if _mn is not None:
                        for _pp in _pg:
                            _pp.normMin = _mn
                            if _clamp:
                                _pp.min = _mn; _pp.clampMin = True
                    if _mx is not None:
                        for _pp in _pg:
                            _pp.normMax = _mx
                            if _clamp:
                                _pp.max = _mx; _pp.clampMax = True
                    if _dflt is not None:
                        if isinstance(_dflt, (list, tuple)):
                            # A multi-component (size > 1) Float/Int takes a per-component
                            # array; never assign the whole list to a single numeric par.
                            for _i in range(min(len(_pg), len(_dflt))):
                                _pg[_i].default = _dflt[_i]; _pg[_i].val = _dflt[_i]
                        else:
                            for _pp in _pg:
                                _pp.default = _dflt; _pp.val = _dflt
                elif _typ == "Toggle":
                    if _dflt is not None:
                        # A string default ("false"/"0"/"off") is truthy under bool(),
                        # so parse common falsey strings explicitly first.
                        if isinstance(_dflt, str):
                            _b = _dflt.strip().lower() not in ("", "0", "false", "no", "off")
                        else:
                            _b = bool(_dflt)
                        _p0.default = _b; _p0.val = _b
                elif _typ == "Menu":
                    _names = [str(x) for x in (_spec.get("menu_names") or [])]
                    _labels = [str(x) for x in (_spec.get("menu_labels") or [])] or _names
                    if _names:
                        _p0.menuNames = _names; _p0.menuLabels = _labels
                    if _dflt is not None and str(_dflt) in _names:
                        _p0.default = str(_dflt); _p0.val = str(_dflt)
                elif _typ == "Str":
                    if _dflt is not None:
                        _p0.default = str(_dflt); _p0.val = str(_dflt)
                elif _typ == "RGB":
                    if _dflt is not None:
                        _rgb = _parse_rgb(_dflt)
                        if _rgb is not None:
                            for _i in range(min(3, len(_pg))):
                                _pg[_i].default = _rgb[_i]; _pg[_i].val = _rgb[_i]
                elif _typ == "XYZ":
                    if _dflt is not None:
                        if isinstance(_dflt, (list, tuple)):
                            for _i in range(min(len(_pg), len(_dflt))):
                                _pg[_i].default = _dflt[_i]; _pg[_i].val = _dflt[_i]
                        else:
                            for _pp in _pg:
                                _pp.default = _dflt; _pp.val = _dflt
                report["added"].append(_name)
            except Exception:
                report["warnings"].append("Failed to add '%s': %s" % (_spec.get("name", "?"), traceback.format_exc().splitlines()[-1]))
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildParamsScript(payload: object): string {
  return buildPayloadScript(PARAMS_SCRIPT, payload);
}

export async function addCustomParametersImpl(ctx: ToolContext, args: AddCustomParametersArgs) {
  // TD page names must start with an uppercase letter; capitalize the first char
  // here (the rest may contain spaces, which pages allow but parameter names do not).
  const page = args.page ? args.page.charAt(0).toUpperCase() + args.page.slice(1) : "Custom";
  return guardTd(
    async () => {
      const script = buildParamsScript({
        comp: args.comp_path,
        page,
        params: args.params,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<ParamsReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not add custom parameters: ${report.fatal}`, report);
      }
      const summary = `Added ${report.added.length} parameter(s) on page "${report.page}" of ${report.comp}${
        report.skipped.length ? `, ${report.skipped.length} skipped (already present)` : ""
      }${report.warnings.length ? `, ${report.warnings.length} warning(s)` : ""}.`;
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
        "Append a custom-parameter page (knobs, sliders, toggles, menus, pulses, RGB, XYZ) to a COMP so a generated network becomes a tunable, reusable component. Point `comp_path` at the COMP and list the `params`; an existing parameter is skipped (reported as a warning), not overwritten. Pair with `scaffold_extension` for behavior and `manage_component` to save the result as a .tox.",
      inputSchema: addCustomParametersSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => addCustomParametersImpl(ctx, args),
  );
};
