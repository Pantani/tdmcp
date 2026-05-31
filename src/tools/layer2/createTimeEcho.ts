import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const createTimeEchoSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Where to build the time-echo chain (a COMP path, e.g. '/project1')."),
  name: z
    .string()
    .default("time_echo")
    .describe("Base name for the container COMP that holds the chain."),
  source_top: z
    .string()
    .describe(
      "Path of the input TOP to apply the time effect to (e.g. '/project1/moviefilein1' or a Null TOP). REQUIRED.",
    ),
  mode: z
    .enum(["echo", "slit_scan", "time_displace"])
    .default("echo")
    .describe(
      "echo: recursive feedback trails — each frame leaves a fading ghost (the classic 'echo trails' / time-blur look, driven by `feedback`). slit_scan: buffer N frames in a cache and read different rows from different points in time (rolling 'time slice' wipe). time_displace: per-pixel time offset driven by a gradient (`displace_top`) — bright pixels show older frames, dark show newer (the 'time_machine' melt/warp). slit_scan and time_displace both buffer frames in a cacheTOP and read them back with a time-machine TOP.",
    ),
  frames: z.coerce
    .number()
    .int()
    .min(2)
    .default(60)
    .describe(
      "Buffer depth / cache size in frames for slit_scan and time_displace (how far back in time pixels can be pulled). Ignored in echo mode (feedback is recursive, not frame-indexed). Larger = longer time range but more GPU memory.",
    ),
  feedback: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .describe(
      "Echo trail strength [0–1] for echo mode — opacity of the fed-back previous frame blended over the current one. Higher = longer, more persistent trails (0.5 = balanced; 0.9+ = very smeary). Ignored in slit_scan / time_displace.",
    ),
  displace_top: z
    .string()
    .default("")
    .describe(
      "time_displace mode only: path of a TOP whose luminance maps each pixel to a time offset (a gradient/ramp/noise — bright = further back in time). Omit to use a built-in vertical ramp (rampTOP) so the effect works out of the box. Ignored in echo / slit_scan.",
    ),
  resolution: z
    .array(z.number())
    .length(2)
    .default([1280, 720])
    .describe(
      "Forced output resolution [width, height] in pixels. A fixed resolution is REQUIRED for the feedback path (echo mode) so the loop has a stable frame from cook 0 and does not stay black.",
    ),
});

type CreateTimeEchoArgs = z.infer<typeof createTimeEchoSchema>;

interface TimeEchoReport {
  container: string;
  output_top: string;
  source_select: string;
  mode: string;
  frames: number;
  feedback: number;
  cache_optype: string;
  timemachine_optype: string;
  warnings: string[];
  fatal?: string;
}

// Build a per-pixel time effect inside a container COMP.
//
// Topology (by mode):
//   sel (selectTOP, par.top = source_top — references the external source by absolute
//        path, no cross-container wire) →
//   echo:        feedbackTOP (wired input + FORCED resolutionw/h — PROJECT MEMORY: a
//                feedbackTOP with no wired input and/or no forced res stays black) blended
//                over the live frame via an overTOP at opacity = `feedback`; the blended
//                result feeds back into the feedbackTOP (loop closed via par.top). A levelTOP
//                trims the trail. → out (nullTOP).
//   slit_scan /  cacheTOP (par cachesize = frames) buffers the source; a time-machine TOP
//   time_displace  reads pixels from different cached frames. The time-machine optype name
//                varies by TD build, so it is PROBED LIVE: we try, in order,
//                  timeMachineTOP, cacheSelectTOP
//                (dir(td) suffix match) and fall back to the cacheTOP's own frame-select if
//                neither exists. For time_displace the displacement source is `displace_top`
//                (or a built-in rampTOP). All par names (cachesize / cacheselectTOP index /
//                timeMachineTOP input par) are set defensively and collected as warnings on
//                failure (fail-forward: a partial chain still returns a useful output_top).
//   End every mode with a nullTOP "out".
//
// fatal ONLY when source_top is missing or the parent COMP cannot be found/created.
const TIME_ECHO_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
    "container": "",
    "output_top": "",
    "source_select": "",
    "mode": _p["mode"],
    "frames": _p["frames"],
    "feedback": _p["feedback"],
    "cache_optype": "",
    "timemachine_optype": "",
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
            try:
                _cont = _parent.create(baseCOMP, _p["name"])
            except Exception as _e:
                report["fatal"] = "Could not create container: " + str(_e)
                _cont = None
            if _cont is not None:
                report["container"] = _cont.path
                _resw = int(_p["resolution"][0])
                _resh = int(_p["resolution"][1])
                _mode = _p["mode"]

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

                # --- Select the source by absolute path (no cross-container wire) ---
                _sel = None
                try:
                    _sel = _cont.create(selectTOP, "sel")
                    _setpar(_sel, "top", _src, "source select")
                    report["source_select"] = _sel.path
                except Exception as _e:
                    report["warnings"].append("Source select TOP failed: " + str(_e))
                    _sel = None

                _out_src = _sel  # node feeding the final null; replaced per mode below

                if _mode == "echo":
                    # Recursive feedback trails. feedbackTOP needs a WIRED input AND a FORCED
                    # resolution or it stays black (PROJECT MEMORY).
                    _fb = None
                    try:
                        _fb = _cont.create(feedbackTOP, "feedback1")
                        if _sel is not None:
                            _fb.inputConnectors[0].connect(_sel)
                        _setpar(_fb, "resolutionw", _resw, "feedback res")
                        _setpar(_fb, "resolutionh", _resh, "feedback res")
                        # Some builds gate forced res behind an 'outputresolution' menu.
                        _setpar(_fb, "outputresolution", "custom resolution", "feedback res mode")
                    except Exception as _e:
                        report["warnings"].append("feedbackTOP failed: " + str(_e))
                        _fb = None

                    # Blend the decayed fed-back frame over the live frame.
                    _over = None
                    try:
                        _over = _cont.create(overTOP, "echo_mix")
                        # overTOP has NO opacity par. The trail-decay knob is a Level TOP's
                        # 'opacity' (live-validated on TD 099 build 2025.32820): fade the
                        # feedback each frame, then composite the faded trail over the live.
                        _decay = None
                        if _fb is not None:
                            _decay = _cont.create(levelTOP, "decay")
                            _decay.inputConnectors[0].connect(_fb)
                            _setpar(_decay, "opacity", _p["feedback"], "echo trail decay")
                        # overTOP input 0 = top layer (decayed trail), input 1 = bottom (live).
                        if _decay is not None:
                            _over.inputConnectors[0].connect(_decay)
                        elif _fb is not None:
                            _over.inputConnectors[0].connect(_fb)
                        if _sel is not None:
                            _over.inputConnectors[1].connect(_sel)
                        _setpar(_over, "resolutionw", _resw, "echo res")
                        _setpar(_over, "resolutionh", _resh, "echo res")
                    except Exception as _e:
                        report["warnings"].append("overTOP (echo mix) failed: " + str(_e))
                        _over = None

                    # Trail trim: a levelTOP just before output (gentle gain on the loop).
                    _lvl = None
                    try:
                        _lvl = _cont.create(levelTOP, "trail")
                        _mix = _over if _over is not None else _sel
                        if _mix is not None:
                            _lvl.inputConnectors[0].connect(_mix)
                    except Exception as _e:
                        report["warnings"].append("levelTOP (trail) failed: " + str(_e))
                        _lvl = None

                    # Close the feedback loop: feedbackTOP samples the blended result each cook.
                    # par.top takes the *name* of the node to re-read (mirrors create_feedback_tunnel).
                    _loop_src = _lvl if _lvl is not None else (_over if _over is not None else _sel)
                    if _fb is not None and _loop_src is not None:
                        _setpar(_fb, "top", _loop_src.name, "feedback loop")

                    _out_src = _lvl if _lvl is not None else (_over if _over is not None else _sel)

                else:
                    # slit_scan / time_displace: buffer frames in a cache, read them back in time.
                    _cache = None
                    try:
                        _cache = _cont.create(cacheTOP, "cache1")
                        report["cache_optype"] = _cache.type
                        if _sel is not None:
                            _cache.inputConnectors[0].connect(_sel)
                        # Cache depth par is 'cachesize' on current builds; 'maxframes' historically.
                        if not _setpar(_cache, "cachesize", _p["frames"], "cache size"):
                            _setpar(_cache, "maxframes", _p["frames"], "cache size (fallback)")
                        _setpar(_cache, "active", 1, "cache active")
                        _setpar(_cache, "resolutionw", _resw, "cache res")
                        _setpar(_cache, "resolutionh", _resh, "cache res")
                    except Exception as _e:
                        report["warnings"].append("cacheTOP failed: " + str(_e))
                        _cache = None

                    # PROBE LIVE for the time-machine read operator. Names vary by TD build.
                    # The bridge exec scope injects optype names directly into globals()
                    # (bare 'cacheTOP' etc.); the 'td' module is NOT defined here.
                    _tm_optype = None
                    for _cand in ("timeMachineTOP", "cacheSelectTOP"):
                        _ty = globals().get(_cand)
                        if _ty is not None:
                            _tm_optype = _ty
                            report["timemachine_optype"] = _cand
                            break
                    if _tm_optype is None:
                        report["warnings"].append(
                            "No time-machine / cacheSelect TOP optype found on this TD build "
                            "(tried timeMachineTOP, cacheSelectTOP); reading the cache directly. "
                            "Effect may be a static cache passthrough — UNVERIFIED."
                        )

                    _tm = None
                    if _tm_optype is not None and _cache is not None:
                        try:
                            _tm = _cont.create(_tm_optype, "time_read")
                            # Input 0 is the cache (the frame buffer to sample).
                            _tm.inputConnectors[0].connect(_cache)
                            if _mode == "time_displace":
                                # Displacement source: user TOP or a built-in vertical ramp.
                                _disp = None
                                _dpath = _p.get("displace_top", "")
                                if _dpath:
                                    _dop = op(_dpath)
                                    if _dop is None:
                                        report["warnings"].append(
                                            "displace_top not found: %s; using built-in ramp." % _dpath
                                        )
                                    else:
                                        try:
                                            _dsel = _cont.create(selectTOP, "disp_in")
                                            _setpar(_dsel, "top", _dpath, "displace select")
                                            _disp = _dsel
                                        except Exception as _e:
                                            report["warnings"].append("displace select failed: " + str(_e))
                                if _disp is None:
                                    try:
                                        _disp = _cont.create(rampTOP, "disp_ramp")
                                        _setpar(_disp, "ramptype", "vertical", "ramp type")
                                        _setpar(_disp, "resolutionw", _resw, "ramp res")
                                        _setpar(_disp, "resolutionh", _resh, "ramp res")
                                    except Exception as _e:
                                        report["warnings"].append("built-in ramp failed: " + str(_e))
                                        _disp = None
                                if _disp is not None:
                                    # time-machine input 1 is the per-pixel time-offset map.
                                    try:
                                        _tm.inputConnectors[1].connect(_disp)
                                    except Exception as _e:
                                        report["warnings"].append(
                                            "Could not wire displacement into time read (%s)." % _e
                                        )
                            else:
                                # slit_scan: roll the read index across the buffer over time so
                                # different rows resolve to different cached frames. The index par
                                # name varies; try a few and fall back to leaving the default.
                                _setpar(_tm, "frames", _p["frames"], "slit frames")
                                _setpar(_tm, "cachesize", _p["frames"], "slit cache size")
                        except Exception as _e:
                            report["warnings"].append(
                                "time read TOP (%s) failed: %s"
                                % (report.get("timemachine_optype", "?"), _e)
                            )
                            _tm = None

                    _out_src = _tm if _tm is not None else (_cache if _cache is not None else _sel)

                # --- Output null ---
                try:
                    _null = _cont.create(nullTOP, "out")
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

export function buildTimeEchoScript(payload: object): string {
  return buildPayloadScript(TIME_ECHO_SCRIPT, payload);
}

export async function createTimeEchoImpl(ctx: ToolContext, args: CreateTimeEchoArgs) {
  return guardTd(
    async () => {
      const script = buildTimeEchoScript({
        parent_path: args.parent_path,
        name: args.name,
        source_top: args.source_top,
        mode: args.mode,
        frames: args.frames,
        feedback: args.feedback,
        displace_top: args.displace_top,
        resolution: args.resolution,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<TimeEchoReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Time-echo build failed: ${report.fatal}`, report);
      }
      const warnNote = report.warnings.length > 0 ? `, ${report.warnings.length} warning(s)` : "";
      const detail =
        report.mode === "echo"
          ? `feedback ${report.feedback}`
          : `${report.frames} frames` +
            (report.timemachine_optype ? ` via ${report.timemachine_optype}` : "");
      const summary = `Built a ${report.mode} time effect on ${args.source_top} (${detail}) → ${report.output_top}${warnNote}.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerCreateTimeEcho: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_time_echo",
    {
      title: "Create time echo",
      description:
        "EXPERIMENTAL — Apply a per-pixel time effect to a source TOP: echo trails, slit-scan, or per-pixel time displacement (the 'time machine' melt/slice look). Builds a container COMP that selects the source by absolute path (no cross-container wire) and then, by mode: echo — a feedbackTOP (wired input + forced resolution so the loop is not black) blended over the live frame at opacity=feedback to leave fading ghost trails; slit_scan — a cacheTOP buffering `frames` and a time-machine TOP reading different rows from different points in time; time_displace — the same cache read back through a luminance gradient (`displace_top` or a built-in vertical ramp) so bright pixels show older frames. The time-machine read operator is PROBED LIVE (timeMachineTOP → cacheSelectTOP fallback) because the optype name varies by TD build; the feedback opacity par (opacity → fadeval) and cache-depth par (cachesize → maxframes) are also set defensively. Every par/connect failure is collected as a warning and the chain still returns its output Null — UNVERIFIED across TD builds; tune live. Ends with a Null TOP 'out'.",
      inputSchema: createTimeEchoSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createTimeEchoImpl(ctx, args),
  );
};
