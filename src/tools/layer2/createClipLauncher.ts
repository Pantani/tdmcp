import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { MORPH_HOOK } from "./manageCue.js";

export const createClipLauncherSchema = z.object({
  comp_path: z
    .string()
    .default("/project1")
    .describe(
      "Control COMP that holds the cues (manage_cue) and custom params. The launcher panel is built inside it and its buttons fire that COMP's cues.",
    ),
  name: z.string().default("launcher").describe("Name of the launcher panel container to build."),
  cues: z
    .array(z.string())
    .min(1)
    .describe(
      "Cue names (stored with manage_cue) to lay out in the grid, in order. Each becomes a clip button labelled with its cue name.",
    ),
  rows: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe("Grid row count. Defaults so rows*cols covers all cues (derived from cues length)."),
  cols: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Grid column count. Defaults to ceil(sqrt(cues)) when omitted (derived from cues length).",
    ),
  morph_time: z.coerce
    .number()
    .min(0)
    .default(0)
    .describe(
      "0 = each button jumps instantly to its cue; >0 = every button crossfades to its cue over this many seconds (eased morph, same engine as manage_cue).",
    ),
});
type CreateClipLauncherArgs = z.infer<typeof createClipLauncherSchema>;

interface LauncherReport {
  comp: string;
  launcher?: string;
  rows?: number;
  cols?: number;
  morph_time?: number;
  buttons: Array<{ button: string; cue: string }>;
  warnings: string[];
  fatal?: string;
}

// Fixed callback for the single Panel Execute DAT that watches every clip button. On a press
// it looks the button up in the launcher's stored button→cue map and either snaps the cue's
// values onto the control COMP or, when a morph time is set, writes a transition record and
// kicks the cue_morph hook (the same engine manage_cue's recall/morph uses).
const LAUNCHER_BUTTON_CB = `import td

def onOffToOn(panelValue):
    btn = panelValue.owner
    surf = btn.parent()
    cmap = surf.fetch('tdmcp_launcher_cues', {})
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

const LAUNCHER_SCRIPT = `
import json, base64, traceback
import td
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"comp": _p["comp"], "warnings": [], "buttons": []}
_c = op(_p["comp"])
try:
    if _c is None:
        report["fatal"] = "COMP not found: " + _p["comp"]
    elif not hasattr(_c, "create"):
        report["fatal"] = _p["comp"] + " is not a COMP."
    else:
        _cues = _p.get("cues", [])
        _cols = int(_p["cols"]); _rows = int(_p["rows"]); _dur = float(_p.get("morph_time") or 0)
        _surf = _c.op(_p["name"]) or _c.create(td.containerCOMP, _p["name"])
        try:
            # Wrap the buttons into a grid of fixed column count, top-to-bottom rows.
            _surf.par.align = "gridcols"
            if hasattr(_surf.par, "fixedcols"):
                _surf.par.fixedcols = _cols
            if hasattr(_surf.par, "w"):
                _surf.par.w = _cols * 130
            if hasattr(_surf.par, "h"):
                _surf.par.h = _rows * 130
        except Exception:
            pass
        report["launcher"] = _surf.path; report["rows"] = _rows; report["cols"] = _cols; report["morph_time"] = _dur
        # A morph time needs the cue_morph Execute DAT (the manage_cue engine) running on the
        # control COMP so the per-frame transition can be animated.
        if _dur > 0:
            _hook = _c.op("cue_morph") or _c.create(td.executeDAT, "cue_morph")
            _hook.text = _p["morph_hook"]
            if hasattr(_hook.par, "framestart"):
                _hook.par.framestart = True
            _hook.par.active = True
        _cmap = {}
        _btn_paths = []
        for _cue in _cues:
            try:
                _bt = _surf.create(td.buttonCOMP)
                try:
                    _bt.par.w = 120; _bt.par.h = 120
                    _bt.par.label = _cue
                    if hasattr(_bt.par, "buttontype"):
                        _bt.par.buttontype = "momentary"
                except Exception:
                    pass
                _cmap[_bt.path] = {"comp": _c.path, "cue": _cue, "dur": _dur}
                _btn_paths.append(_bt.path)
                report["buttons"].append({"button": _bt.path, "cue": _cue})
            except Exception:
                report["warnings"].append("Clip button failed: " + traceback.format_exc().splitlines()[-1])
        if _btn_paths:
            _surf.store("tdmcp_launcher_cues", _cmap)
            _pe = _surf.op("clip_dispatch") or _surf.create(td.panelexecuteDAT, "clip_dispatch")
            _pe.text = _p["button_cb"]
            try:
                _pe.par.panels = " ".join(_btn_paths)
                if hasattr(_pe.par, "offtoon"):
                    _pe.par.offtoon = True
                _pe.par.active = True
            except Exception:
                report["warnings"].append("Could not wire the clip dispatcher.")
        else:
            report["warnings"].append("No clip buttons were created.")
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildLauncherScript(payload: object): string {
  return buildPayloadScript(LAUNCHER_SCRIPT, payload);
}

/** Resolves the grid dimensions from explicit rows/cols or derives a near-square grid. */
function resolveGrid(count: number, rows?: number, cols?: number): { rows: number; cols: number } {
  if (cols && rows) return { rows, cols };
  if (cols) return { cols, rows: Math.ceil(count / cols) };
  if (rows) return { rows, cols: Math.ceil(count / rows) };
  const c = Math.ceil(Math.sqrt(count));
  return { cols: c, rows: Math.ceil(count / c) };
}

export async function createClipLauncherImpl(ctx: ToolContext, args: CreateClipLauncherArgs) {
  const { rows, cols } = resolveGrid(args.cues.length, args.rows, args.cols);
  return guardTd(
    async () => {
      const script = buildLauncherScript({
        comp: args.comp_path,
        name: args.name,
        cues: args.cues,
        rows,
        cols,
        morph_time: args.morph_time,
        morph_hook: MORPH_HOOK,
        button_cb: LAUNCHER_BUTTON_CB,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<LauncherReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not build clip launcher: ${report.fatal}`, report);
      }
      const mode =
        (report.morph_time ?? 0) > 0 ? `morphing over ${report.morph_time}s` : "instant recall";
      const summary = `Built clip launcher ${report.launcher} — ${report.buttons.length} clip(s) in a ${report.rows}×${report.cols} grid (${mode})${
        report.warnings.length ? `, ${report.warnings.length} warning(s)` : ""
      }.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerCreateClipLauncher: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_clip_launcher",
    {
      title: "Create clip launcher",
      description:
        "Build an Ableton-style clip launcher: a grid panel (Container COMP) of clip buttons, one per named cue (from manage_cue), for fast hands-on scene switching during a live set. Open the container in Perform/Panel mode and tap a clip to fire its cue — instantly, or (with morph_time) crossfading to it over N seconds (eased, the same engine manage_cue uses). Store the cues with manage_cue / create_control_panel first.",
      inputSchema: createClipLauncherSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createClipLauncherImpl(ctx, args),
  );
};
