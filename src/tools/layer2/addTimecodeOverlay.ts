import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { hexToRgbTuple } from "../util/color.js";

export const addTimecodeOverlaySchema = z.object({
  source_top: z
    .string()
    .describe(
      "Path of the input TOP to overlay the timecode onto (e.g. '/project1/moviefilein1'). REQUIRED.",
    ),
  mode: z
    .enum(["clock", "count_up", "count_down"])
    .default("count_up")
    .describe(
      "clock: show total show time (since project start) as HH:MM:SS:FF. count_up: elapsed time since this overlay was built, from 00:00:00:00. count_down: counts down from `target_seconds` to 00:00:00:00 and clamps there.",
    ),
  target_seconds: z.coerce
    .number()
    .min(0)
    .default(60)
    .describe("count_down only: seconds to count down from. Ignored in clock/count_up modes."),
  font_size: z.coerce.number().positive().default(48).describe("Timecode font size in pixels."),
  color: z
    .string()
    .default("#ffffff")
    .describe("Timecode text color as a hex string, e.g. '#ff3366'."),
  position: z
    .enum(["top_left", "top_center", "top_right", "bottom_left", "bottom_center", "bottom_right"])
    .default("bottom_left")
    .describe("Where the timecode text is anchored over the source frame."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Where to build the overlay chain (a COMP path, e.g. '/project1')."),
  name: z
    .string()
    .default("timecode_overlay")
    .describe("Base name for the container COMP that holds the chain."),
});

type AddTimecodeOverlayArgs = z.infer<typeof addTimecodeOverlaySchema>;

const ALIGN_MAP: Record<AddTimecodeOverlayArgs["position"], { alignx: string; aligny: string }> = {
  top_left: { alignx: "left", aligny: "top" },
  top_center: { alignx: "center", aligny: "top" },
  top_right: { alignx: "right", aligny: "top" },
  bottom_left: { alignx: "left", aligny: "bottom" },
  bottom_center: { alignx: "center", aligny: "bottom" },
  bottom_right: { alignx: "right", aligny: "bottom" },
};

interface TimecodeOverlayReport {
  container: string;
  output_top: string;
  source_select: string;
  text_top: string;
  mode: string;
  fps: number;
  fps_source: string;
  warnings: string[];
  fatal?: string;
}

// Build a live timecode overlay inside a container COMP.
//
// Topology:
//   sel (selectTOP, par.top = source_top — references the external source by
//        absolute path, no cross-container wire) →
//   fmt (textDAT "fmt") — a small Python module defining tc(mode, fps, target,
//        startframe) that formats HH:MM:SS:FF from absTime.frame. Kept as DAT text
//        (not a TS-side string eval) so it re-cooks live inside TD's own exec scope;
//        all TD globals (absTime, project) stay INSIDE the DAT text.
//   tc  (textTOP) — .par.text.expr calls mod('fmt').tc(...) every frame (a live
//        expression, not a static string), transparent background, font/color/
//        alignment from the schema.
//   comp (compositeTOP, operand "over") — input0 = tc (text, top layer),
//        input1 = sel (source, bottom layer). Forces the source resolution.
//   out (nullTOP).
//
// fps is PROBED at build time in this order: me.time.rate, then
// project.cookRate, then a 60 fallback — whichever works is recorded in
// report.fps_source (a fallback is flagged as a warning, UNVERIFIED across TD
// builds/timeline configs).
//
// fatal ONLY when source_top is missing or the parent COMP cannot be found/created.
const TIMECODE_OVERLAY_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
    "container": "",
    "output_top": "",
    "source_select": "",
    "text_top": "",
    "mode": _p["mode"],
    "fps": 0,
    "fps_source": "",
    "warnings": [],
}
try:
    _src = _p["source_top"]
    _srcop = op(_src)
    if _srcop is None:
        report["fatal"] = "Source TOP not found: " + str(_src)
    else:
        _parent = op(_p["parent_path"])
        if _parent is None:
            report["fatal"] = "Parent COMP not found: " + str(_p["parent_path"])
        else:
            def _place(_o, _x, _y):
                # nodeX/nodeY are attributes, not params — set them so the chain reads
                # left->right instead of stacking at the default drop point.
                if _o is None:
                    return
                try:
                    _o.nodeX = _x
                    _o.nodeY = _y
                except Exception:
                    pass

            def _free_x(_y, _start=0.0, _step=260.0):
                # Free X slot at row _y among _parent's existing children so repeat runs
                # under the same parent don't stack containers. Probe BEFORE creating so
                # the new container doesn't occupy slot 0 itself.
                try:
                    _occupied = set()
                    for _ch in _parent.children:
                        try:
                            if abs(float(_ch.nodeY) - float(_y)) < 1.0:
                                _occupied.add(round(float(_ch.nodeX) / _step) * _step)
                        except Exception:
                            continue
                    _x = float(_start)
                    while round(_x / _step) * _step in _occupied:
                        _x += _step
                    return _x
                except Exception:
                    return float(_start)

            _cx = _free_x(0)
            try:
                _cont = _parent.create(baseCOMP, _p["name"])
            except Exception as _e:
                report["fatal"] = "Could not create container: " + str(_e)
                _cont = None
            if _cont is not None:
                report["container"] = _cont.path
                # Place the container at the pre-probed free slot so repeated runs don't
                # stack the containers at the parent's default drop point.
                _place(_cont, _cx, 0)

                def _setpar(_o, _name, _val, _label):
                    # Set a parameter defensively; record a warning (not a throw) if absent.
                    try:
                        _par = getattr(_o.par, _name, None)
                        if _par is None:
                            report["warnings"].append(
                                "%s: par '%s' not found on %s (UNVERIFIED TD build)."
                                % (_label, _name, _o.type)
                            )
                            return False
                        _par.val = _val
                        return True
                    except Exception as _e:
                        report["warnings"].append("%s: could not set '%s' (%s)." % (_label, _name, _e))
                        return False

                # --- Probe FPS: me.time.rate -> project.cookRate -> 60 fallback ---
                _fps = None
                _fps_source = ""
                try:
                    _fps = float(me.time.rate)
                    _fps_source = "me.time.rate"
                except Exception:
                    _fps = None
                if not _fps:
                    try:
                        _fps = float(project.cookRate)
                        _fps_source = "project.cookRate"
                    except Exception:
                        _fps = None
                if not _fps:
                    _fps = 60.0
                    _fps_source = "fallback(60)"
                    report["warnings"].append(
                        "Could not probe me.time.rate or project.cookRate; using 60 fps "
                        "fallback (UNVERIFIED — check your project's actual frame rate)."
                    )
                report["fps"] = _fps
                report["fps_source"] = _fps_source

                # --- Select the source by absolute path (no cross-container wire) ---
                _sel = None
                try:
                    _sel = _cont.create(selectTOP, "sel")
                    _place(_sel, 0, -140)
                    _setpar(_sel, "top", _src, "source select")
                    report["source_select"] = _sel.path
                except Exception as _e:
                    report["warnings"].append("Source select TOP failed: " + str(_e))
                    _sel = None

                # --- Timecode formatter module (textDAT) ---
                _fmt = None
                try:
                    _fmt = _cont.create(textDAT, "fmt")
                    _place(_fmt, 0, 140)
                    _fmt.text = '''
def tc(mode, fps, target, startframe):
    fps = max(1.0, float(fps))
    now_frame = absTime.frame
    if mode == "count_down":
        target_frames = float(target) * fps
        elapsed = now_frame - startframe
        remaining = target_frames - elapsed
        if remaining < 0:
            remaining = 0
        frames_total = remaining
    elif mode == "clock":
        frames_total = now_frame
    else:
        # count_up
        frames_total = max(0.0, now_frame - startframe)

    total_seconds = int(frames_total // fps)
    ff = int(frames_total % fps)
    hh = total_seconds // 3600
    mm = (total_seconds % 3600) // 60
    ss = total_seconds % 60
    return "%02d:%02d:%02d:%02d" % (hh, mm, ss, ff)
'''
                except Exception as _e:
                    report["warnings"].append("Formatter DAT (fmt) failed: " + str(_e))
                    _fmt = None

                # --- Timecode text TOP (live expression, ticks every frame) ---
                _tc = None
                try:
                    _tc = _cont.create(textTOP, "tc")
                    _place(_tc, 200, 0)
                    _startframe = absTime.frame
                    _expr = (
                        "mod('fmt').tc(%r, %r, %r, %r)"
                        % (_p["mode"], _fps, _p["target_seconds"], _startframe)
                    )
                    _text_par = getattr(_tc.par, "text", None)
                    if _text_par is not None:
                        _text_par.expr = _expr
                    else:
                        report["warnings"].append(
                            "textTOP has no 'text' par (UNVERIFIED TD build); timecode expression not set."
                        )
                    _setpar(_tc, "fontsizex", _p["font_size"], "font size")
                    _setpar(_tc, "fontsizey", _p["font_size"], "font size")
                    _fcr, _fcg, _fcb = _p["color_rgb"]
                    _setpar(_tc, "fontcolorr", _fcr, "font color")
                    _setpar(_tc, "fontcolorg", _fcg, "font color")
                    _setpar(_tc, "fontcolorb", _fcb, "font color")
                    _setpar(_tc, "fontalpha", 1, "font alpha")
                    _setpar(_tc, "bgalpha", 0, "transparent bg")
                    _setpar(_tc, "bgcolora", 0, "transparent bg (alt par)")
                    _setpar(_tc, "alignx", _p["alignx"], "horizontal align")
                    _setpar(_tc, "aligny", _p["aligny"], "vertical align")
                    report["text_top"] = _tc.path
                except Exception as _e:
                    report["warnings"].append("Timecode textTOP failed: " + str(_e))
                    _tc = None

                # --- Composite the timecode over the source ---
                _comp = None
                try:
                    _comp = _cont.create(compositeTOP, "comp")
                    _place(_comp, 400, 0)
                    _setpar(_comp, "operand", "over", "composite operand")
                    if _tc is not None:
                        _comp.inputConnectors[0].connect(_tc)
                    if _sel is not None:
                        _comp.inputConnectors[1].connect(_sel)
                except Exception as _e:
                    report["warnings"].append("compositeTOP failed: " + str(_e))
                    _comp = None

                _out_src = _comp if _comp is not None else (_tc if _tc is not None else _sel)

                # --- Output null ---
                try:
                    _null = _cont.create(nullTOP, "out")
                    _place(_null, 600, 0)
                    if _out_src is not None:
                        _null.inputConnectors[0].connect(_out_src)
                    report["output_top"] = _null.path
                except Exception as _e:
                    report["output_top"] = _out_src.path if _out_src is not None else report["source_select"]
                    report["warnings"].append("Output null TOP failed: " + str(_e))
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildTimecodeOverlayScript(payload: object): string {
  return buildPayloadScript(TIMECODE_OVERLAY_SCRIPT, payload);
}

export async function addTimecodeOverlayImpl(ctx: ToolContext, args: AddTimecodeOverlayArgs) {
  return guardTd(
    async () => {
      const colorRgb = hexToRgbTuple(args.color, [1, 1, 1]);
      const align = ALIGN_MAP[args.position];
      const script = buildTimecodeOverlayScript({
        parent_path: args.parent_path,
        name: args.name,
        source_top: args.source_top,
        mode: args.mode,
        target_seconds: args.target_seconds,
        font_size: args.font_size,
        color_rgb: colorRgb,
        alignx: align.alignx,
        aligny: align.aligny,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<TimecodeOverlayReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Timecode overlay build failed: ${report.fatal}`, report);
      }
      const warnNote = report.warnings.length > 0 ? `, ${report.warnings.length} warning(s)` : "";
      const modeNote =
        report.mode === "clock"
          ? "showing show-time-since-project-start (not the OS wall clock)"
          : report.mode === "count_down"
            ? `counting down from ${args.target_seconds}s`
            : "counting up since it was built";
      const summary =
        `Built a ${report.mode} timecode overlay on ${args.source_top} (${modeNote}, ` +
        `${report.fps} fps via ${report.fps_source}) → ${report.output_top}. ` +
        `The timecode ticks live over the source every frame${warnNote}.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerAddTimecodeOverlay: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "add_timecode_overlay",
    {
      title: "Add timecode overlay",
      description:
        "Overlay a running HH:MM:SS:FF timecode (or a countdown) onto an input TOP as VISUAL pixels — a Text TOP whose text expression re-evaluates every frame, composited 'over' the source with a Composite TOP. Modes: clock (show time since project start — NOT the OS wall clock — as HH:MM:SS:FF), count_up (elapsed time since this overlay was built, from zero), count_down (counts down from `target_seconds` to 00:00:00:00 and clamps there). The formatter lives in a Text DAT module (mod('fmt').tc(...)) so it re-cooks live inside TD. FPS is probed live (me.time.rate -> project.cookRate -> 60 fallback) and reported. Distinct from sync_timecode, which syncs a CLOCK SIGNAL (no pixels) — this tool draws the timecode into the image. Ends with a Null TOP 'out'.",
      inputSchema: addTimecodeOverlaySchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => addTimecodeOverlayImpl(ctx, args),
  );
};
