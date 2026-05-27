import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { MORPH_HOOK } from "./manageCue.js";

const faderSchema = z.object({
  param: z.string().describe("Parameter the fader drives, written as 'nodePath.parName'."),
  label: z.string().optional(),
  min: z.coerce.number().default(0).describe("Value at the bottom of the fader."),
  max: z.coerce.number().default(1).describe("Value at the top of the fader."),
});

const cueButtonSchema = z.object({
  cue: z.string().describe("Name of a cue (stored with manage_cue) to fire."),
  label: z.string().optional(),
  morph_seconds: z.coerce
    .number()
    .min(0)
    .default(0)
    .describe("0 = jump instantly to the cue; >0 = crossfade over this many seconds."),
});

export const createControlSurfaceSchema = z.object({
  comp_path: z
    .string()
    .default("/project1")
    .describe(
      "Control COMP that holds the cues (manage_cue) and custom params. The surface is built inside it and its buttons fire that COMP's cues.",
    ),
  name: z.string().default("surface").describe("Name of the panel container to build."),
  align: z
    .enum(["horizlr", "verttb", "gridcols", "gridrows", "none"])
    .default("horizlr")
    .describe("How the panel lays out its widgets."),
  faders: z.array(faderSchema).default([]).describe("Vertical faders, each driving a parameter."),
  cue_buttons: z
    .array(cueButtonSchema)
    .default([])
    .describe("Buttons that recall or morph to named cues."),
});
type CreateControlSurfaceArgs = z.infer<typeof createControlSurfaceSchema>;

interface SurfaceReport {
  comp: string;
  surface?: string;
  faders: Array<{ slider: string; param: string }>;
  cue_buttons: Array<{ button: string; cue: string; morph_seconds: number }>;
  warnings: string[];
  fatal?: string;
}

// Fixed callback for the single Panel Execute DAT that watches every cue button. On a
// press it looks the button up in the surface's stored button→cue map and either snaps the
// cue's values onto the control COMP or, when a morph time is set, writes a transition record
// and kicks the cue_morph hook (the same engine manage_cue uses).
const SURFACE_BUTTON_CB = `import td

def onOffToOn(panelValue):
    btn = panelValue.owner
    surf = btn.parent()
    cmap = surf.fetch('tdmcp_surface_cues', {})
    info = cmap.get(btn.path)
    if not info:
        return
    comp = op(info.get('comp'))
    if comp is None:
        return
    to = comp.fetch('tdmcp_cues', {}).get(info.get('cue'))
    if not to:
        return
    dur = info.get('dur', 0) or 0
    if dur > 0:
        frm = {}
        for k in to:
            pr = getattr(comp.par, k, None)
            if pr is not None:
                try:
                    frm[k] = pr.eval()
                except Exception:
                    pass
        comp.store('tdmcp_cue_transition', {'active': True, 'from': frm, 'to': to, 'start': td.absTime.seconds, 'duration': dur})
        h = comp.op('cue_morph')
        if h is not None:
            h.par.active = True
    else:
        for k, v in to.items():
            pr = getattr(comp.par, k, None)
            if pr is not None and not pr.readOnly:
                try:
                    pr.val = v
                except Exception:
                    pass
    return
`;

const SURFACE_SCRIPT = `
import json, base64, traceback
import td
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"comp": _p["comp"], "warnings": [], "faders": [], "cue_buttons": []}
_c = op(_p["comp"])
try:
    if _c is None:
        report["fatal"] = "COMP not found: " + _p["comp"]
    elif not hasattr(_c, "create"):
        report["fatal"] = _p["comp"] + " is not a COMP."
    else:
        _surf = _c.op(_p["name"]) or _c.create(td.containerCOMP, _p["name"])
        try:
            _surf.par.align = _p["align"]
        except Exception:
            pass
        report["surface"] = _surf.path
        _buttons = _p.get("cue_buttons", [])
        if any((b.get("morph_seconds") or 0) > 0 for b in _buttons):
            _hook = _c.op("cue_morph") or _c.create(td.executeDAT, "cue_morph")
            _hook.text = _p["morph_hook"]
            if hasattr(_hook.par, "framestart"):
                _hook.par.framestart = True
            _hook.par.active = True
        for _f in _p.get("faders", []):
            try:
                _path = _f["param"]; _dot = _path.rfind(".")
                if _dot <= 0:
                    report["warnings"].append("Invalid fader target '%s'." % _path); continue
                _np = _path[:_dot]; _prn = _path[_dot + 1:]; _tn = op(_np)
                if _tn is None:
                    report["warnings"].append("Fader target node not found: " + _np); continue
                _tp = getattr(_tn.par, _prn, None)
                if _tp is None:
                    report["warnings"].append("Fader target parameter not found: " + _path); continue
                _lo = _f["min"]; _hi = _f["max"]
                _sl = _surf.create(td.sliderCOMP)
                try:
                    _sl.par.w = 80; _sl.par.h = 240
                    if _f.get("label"):
                        _sl.par.label = _f["label"]
                except Exception:
                    pass
                try:
                    _cur = float(_tp.eval())
                    _sl.par.value0 = max(0.0, min(1.0, (_cur - _lo) / (_hi - _lo))) if _hi > _lo else 0.0
                except Exception:
                    pass
                _expr = "%s + (%s) * op(%r).par.value0" % (repr(_lo), repr(_hi - _lo), _sl.path)
                _PM = type(_tp.mode); _tp.expr = _expr; _tp.mode = _PM.EXPRESSION
                report["faders"].append({"slider": _sl.path, "param": _path})
            except Exception:
                report["warnings"].append("Fader failed: " + traceback.format_exc().splitlines()[-1])
        _cmap = {}
        _btn_paths = []
        for _b in _buttons:
            try:
                _cue = _b["cue"]; _dur = float(_b.get("morph_seconds") or 0)
                _bt = _surf.create(td.buttonCOMP)
                try:
                    _bt.par.w = 110; _bt.par.h = 240
                    _bt.par.label = _b.get("label") or _cue
                    if hasattr(_bt.par, "buttontype"):
                        _bt.par.buttontype = "momentary"
                except Exception:
                    pass
                _cmap[_bt.path] = {"comp": _c.path, "cue": _cue, "dur": _dur}
                _btn_paths.append(_bt.path)
                report["cue_buttons"].append({"button": _bt.path, "cue": _cue, "morph_seconds": _dur})
            except Exception:
                report["warnings"].append("Cue button failed: " + traceback.format_exc().splitlines()[-1])
        if _btn_paths:
            _surf.store("tdmcp_surface_cues", _cmap)
            _pe = _surf.op("cue_dispatch") or _surf.create(td.panelexecuteDAT, "cue_dispatch")
            _pe.text = _p["button_cb"]
            try:
                _pe.par.panels = " ".join(_btn_paths)
                if hasattr(_pe.par, "offtoon"):
                    _pe.par.offtoon = True
                _pe.par.active = True
            except Exception:
                report["warnings"].append("Could not wire the cue dispatcher.")
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildSurfaceScript(payload: object): string {
  return buildPayloadScript(SURFACE_SCRIPT, payload);
}

export async function createControlSurfaceImpl(ctx: ToolContext, args: CreateControlSurfaceArgs) {
  return guardTd(
    async () => {
      const script = buildSurfaceScript({
        comp: args.comp_path,
        name: args.name,
        align: args.align,
        faders: args.faders,
        cue_buttons: args.cue_buttons,
        morph_hook: MORPH_HOOK,
        button_cb: SURFACE_BUTTON_CB,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<SurfaceReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return jsonResult(`Could not build control surface: ${report.fatal}`, report);
      }
      const summary = `Built control surface ${report.surface} with ${report.faders.length} fader(s) and ${report.cue_buttons.length} cue button(s)${
        report.warnings.length ? `, ${report.warnings.length} warning(s)` : ""
      }.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerCreateControlSurface: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_control_surface",
    {
      title: "Create control surface",
      description:
        "Build a playable performance panel (a Container COMP of visual widgets) for live use, beyond the parameter dialog: vertical faders that drive parameters, and buttons that recall or morph to named cues (from manage_cue). Open the container in Perform/Panel mode for a touchable surface — faders move their parameters, cue buttons fire scenes (instantly or with a crossfade).",
      inputSchema: createControlSurfaceSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createControlSurfaceImpl(ctx, args),
  );
};
