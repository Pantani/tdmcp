import { z } from "zod";
import { TdApiError } from "../../td-client/types.js";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const controlSchema = z.object({
  name: z
    .string()
    .describe(
      "Control label; also sanitized into a valid TD custom-parameter name (e.g. 'blur amount' → 'Bluramount').",
    ),
  type: z
    .enum(["float", "int", "toggle", "menu", "rgb", "pulse", "string"])
    .default("float")
    .describe(
      "Widget kind: float/int sliders, a toggle, a dropdown menu, an RGB swatch, a momentary pulse, or a text field.",
    ),
  label: z.string().optional().describe("Display label (defaults to `name`)."),
  min: z.coerce.number().optional().describe("Slider lower bound (float/int) — also hard-clamped."),
  max: z.coerce.number().optional().describe("Slider upper bound (float/int) — also hard-clamped."),
  default: z.union([z.number(), z.boolean(), z.string()]).optional().describe("Initial value."),
  menu_items: z.array(z.string()).optional().describe("Options for a 'menu' control."),
  bind_to: z
    .array(z.string())
    .optional()
    .describe(
      "Parameters this control should drive, each written as 'nodePath.parName' (e.g. '/project1/sys/blur1.size'). Each target is switched to expression mode so moving the control moves the parameter live. Not supported for 'rgb'/'pulse'.",
    ),
});

export const createControlPanelSchema = z.object({
  comp_path: z
    .string()
    .default("/project1")
    .describe(
      "COMP that will receive the custom parameters — usually a generated system's container.",
    ),
  page: z
    .string()
    .default("Controls")
    .describe("Name of the custom-parameter page to add the controls to."),
  controls: z
    .array(controlSchema)
    .min(1)
    .describe("The controls (knobs/sliders/toggles/menus) to expose."),
});
type CreateControlPanelArgs = z.infer<typeof createControlPanelSchema>;

interface ControlReport {
  comp: string;
  page: string;
  created: Array<{ control: string; name: string; type: string; pars: string[]; value: unknown }>;
  bound: Array<{ control: string; target: string }>;
  warnings: string[];
  fatal?: string;
}

// The whole panel is built in one Python pass: appending custom parameters is an
// attribute-level operation with no structured bridge endpoint, and doing it in a
// single script keeps the page/parameter/binding work atomic. `ParMode` is *not*
// injected into the bridge's exec globals, so the expression-mode enum is derived
// from a live parameter (`type(par.mode)`) instead of imported.
const PANEL_SCRIPT = String.raw`
import json, base64, traceback
_payload = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
_comp = op(_payload["comp"]); _page_name = _payload["page"]; _controls = _payload["controls"]
report = {"comp": _payload["comp"], "page": _page_name, "created": [], "bound": [], "warnings": []}

def _parname(s):
    s = "".join(ch for ch in s if ch.isalnum())
    if not s:
        s = "Par"
    if not s[0].isalpha():
        s = "P" + s
    return s[0].upper() + s[1:]

if _comp is None:
    report["fatal"] = "COMP not found: " + _payload["comp"]
elif not hasattr(_comp, "appendCustomPage"):
    report["fatal"] = _payload["comp"] + " is not a COMP, so it cannot hold custom parameters."
else:
    _page = None
    for _pg in _comp.customPages:
        if _pg.name == _page_name:
            _page = _pg
            break
    if _page is None:
        _page = _comp.appendCustomPage(_page_name)
    for _spec in _controls:
        try:
            _name = _parname(_spec["name"]); _typ = _spec.get("type", "float"); _label = _spec.get("label") or _spec["name"]
            if _typ == "float":
                _pg = _page.appendFloat(_name, label=_label)
            elif _typ == "int":
                _pg = _page.appendInt(_name, label=_label)
            elif _typ == "toggle":
                _pg = _page.appendToggle(_name, label=_label)
            elif _typ == "menu":
                _pg = _page.appendMenu(_name, label=_label)
            elif _typ == "rgb":
                _pg = _page.appendRGB(_name, label=_label)
            elif _typ == "pulse":
                _pg = _page.appendPulse(_name, label=_label)
            elif _typ in ("string", "str"):
                _pg = _page.appendStr(_name, label=_label)
            else:
                report["warnings"].append("Unknown control type '%s' for '%s'." % (_typ, _spec["name"]))
                continue
            _p0 = _pg[0]; _dflt = _spec.get("default", None)
            if _typ in ("float", "int"):
                _mn = _spec.get("min", None); _mx = _spec.get("max", None)
                if _mn is not None:
                    _p0.normMin = _mn; _p0.min = _mn; _p0.clampMin = True
                if _mx is not None:
                    _p0.normMax = _mx; _p0.max = _mx; _p0.clampMax = True
                if _dflt is not None:
                    _p0.default = _dflt; _p0.val = _dflt
            elif _typ == "toggle":
                if _dflt is not None:
                    _p0.default = bool(_dflt); _p0.val = bool(_dflt)
            elif _typ == "menu":
                _items = _spec.get("menu_items") or []
                if _items:
                    _names = [str(x) for x in _items]
                    _p0.menuNames = _names; _p0.menuLabels = _names
                if _dflt is not None and str(_dflt) in [str(x) for x in _items]:
                    _p0.default = str(_dflt); _p0.val = str(_dflt)
            elif _typ in ("string", "str"):
                if _dflt is not None:
                    _p0.default = str(_dflt); _p0.val = str(_dflt)
            report["created"].append({"control": _spec["name"], "name": _name, "type": _typ, "pars": [pp.name for pp in _pg], "value": _p0.eval()})
            _binds = _spec.get("bind_to") or []
            if _binds and _typ in ("rgb", "pulse"):
                report["warnings"].append("bind_to ignored for '%s' (a %s control cannot drive a single parameter)." % (_spec["name"], _typ))
                _binds = []
            for _t in _binds:
                try:
                    _dot = _t.rfind(".")
                    if _dot <= 0:
                        report["warnings"].append("Invalid bind target '%s' (expected 'nodePath.parName')." % _t)
                        continue
                    _np = _t[:_dot]; _pn = _t[_dot + 1:]; _tn = op(_np)
                    if _tn is None:
                        report["warnings"].append("Bind target node not found: %s" % _np)
                        continue
                    _tp = getattr(_tn.par, _pn, None)
                    if _tp is None:
                        report["warnings"].append("Bind target parameter not found: %s.%s" % (_np, _pn))
                        continue
                    _PM = type(_tp.mode)
                    _tp.expr = "op(%s).par.%s" % (repr(_payload["comp"]), _name)
                    _tp.mode = _PM.EXPRESSION
                    report["bound"].append({"control": _name, "target": _np + "." + _pn})
                except Exception:
                    report["warnings"].append("Failed to bind '%s' to '%s': %s" % (_name, _t, traceback.format_exc().splitlines()[-1]))
        except Exception:
            report["warnings"].append("Failed to create control '%s': %s" % (_spec.get("name", "?"), traceback.format_exc().splitlines()[-1]))
print(json.dumps(report))
`;

export function buildPanelScript(payload: object): string {
  const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  return PANEL_SCRIPT.replace("__PAYLOAD_B64__", b64);
}

/** Pulls the JSON report out of the script's stdout (first `{` … last `}`). */
export function parseReport(stdout: string | undefined): ControlReport {
  if (!stdout) throw new TdApiError("The control-panel script returned no output.");
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new TdApiError(`Could not parse control-panel result: ${stdout.slice(0, 200)}`);
  }
  return JSON.parse(stdout.slice(start, end + 1)) as ControlReport;
}

export async function createControlPanelImpl(ctx: ToolContext, args: CreateControlPanelArgs) {
  return guardTd(
    async () => {
      const script = buildPanelScript({
        comp: args.comp_path,
        page: args.page,
        controls: args.controls,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parseReport(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return jsonResult(`Could not build control panel: ${report.fatal}`, report);
      }
      const summary = `Added ${report.created.length} control(s) on page "${report.page}" of ${report.comp}, ${report.bound.length} bound to live parameter(s)${
        report.warnings.length ? `, ${report.warnings.length} warning(s)` : ""
      }.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerCreateControlPanel: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_control_panel",
    {
      title: "Create control panel",
      description:
        "Expose live controls on a COMP: append custom parameters (sliders, toggles, menus, RGB, pulse) and bind them to node parameters so the artist can drive a generated system in real time. Point `comp_path` at a system container and list the controls; use each control's `bind_to` to wire it to one or more 'nodePath.parName' targets.",
      inputSchema: createControlPanelSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createControlPanelImpl(ctx, args),
  );
};
