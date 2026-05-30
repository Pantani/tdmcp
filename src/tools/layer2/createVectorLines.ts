import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const createVectorLinesSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Where to build the line-art container (a COMP path, e.g. '/project1')."),
  name: z
    .string()
    .default("vector_lines")
    .describe("Base name for the container COMP that holds the line-art chain."),
  source_top: z
    .string()
    .describe(
      "Absolute path of the input image/video TOP to convert to line-art (e.g. '/project1/moviein1' or a Null TOP). Brought in via a Select TOP by path — no cross-container wire.",
    ),
  style: z
    .enum(["contour", "trace", "plotter"])
    .default("contour")
    .describe(
      "contour: keep it a TOP look — edges colorized to line_color over bg_color (cheap, real-time on video). trace: vectorize the edges into geometry with a Trace SOP and render them as crisp lines (COSTLY on live video — see warnings). plotter: same vectorization but thin single-weight strokes for a pen-plotter aesthetic.",
    ),
  threshold: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.3)
    .describe(
      "Edge sensitivity [0–1]. Lower = more lines (picks up faint edges), higher = only strong contours. Feeds the Edge TOP strength and the trace threshold.",
    ),
  line_width: z.coerce
    .number()
    .default(2)
    .describe(
      "Stroke thickness in pixels. For contour style this scales the edge bloom; for trace/plotter it sets the line width of the rendered geometry.",
    ),
  line_color: z
    .array(z.number())
    .length(3)
    .default([1, 1, 1])
    .describe("RGB color of the lines (0–1 per channel). Default white [1,1,1]."),
  bg_color: z
    .array(z.number())
    .length(3)
    .default([0, 0, 0])
    .describe("RGB background color behind the lines (0–1 per channel). Default black [0,0,0]."),
  animate: z
    .boolean()
    .default(true)
    .describe(
      "When true (default), the lines draw on / march over time (a moving dashed reveal driven by me.time.seconds baked into the contour shader). When false the line-art is static.",
    ),
  resolution: z
    .array(z.number())
    .length(2)
    .default([1280, 720])
    .describe("Output resolution [width, height] in pixels. Default [1280, 720]."),
});
type CreateVectorLinesArgs = z.infer<typeof createVectorLinesSchema>;

interface VectorLinesReport {
  container: string;
  output_top: string;
  edge_top: string;
  trace_sop: string;
  style: string;
  edge_par_used: string;
  trace_optype_used: string;
  warnings: string[];
  fatal?: string;
}

// Build a line-art / contour / plotter look inside a container COMP:
//   source_top (external, read by absolute path via a Select TOP — no cross-container wire) →
//   Edge TOP (extract contours). PROBE-LIVE: the Edge TOP's strength/threshold par names vary by
//     TD build, so we try a list of common names, record which one took in report["edge_par_used"],
//     and turn a miss into a warning (fail-forward — the chain still builds on Edge defaults).
//   Then by style:
//     contour: a generated GLSL TOP maps edge luminance → line_color over bg_color, with an optional
//       animated marching-dash reveal. The shader BAKES me.time.seconds into a Vectors-block
//       expression (NOT a named custom-uniform par), per the house GLSL rules. Ends in a Null TOP.
//     trace / plotter: a Trace SOP vectorizes the edge image into geometry, rendered via a Geometry
//       COMP + Camera + Render TOP. PROBE-LIVE: the Trace SOP optype + its threshold/source-TOP par
//       names vary by build, so we probe and record report["trace_optype_used"]. This stage is
//       COOK-COSTLY on live video — we FLAG it as a warning. plotter differs only in line_width.
//   Per-op failures are collected as warnings; report["fatal"] only when the source TOP or the
//   parent COMP is missing. Never throws.
const VECTOR_LINES_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
    "container": "",
    "output_top": "",
    "edge_top": "",
    "trace_sop": "",
    "style": _p["style"],
    "edge_par_used": "",
    "trace_optype_used": "",
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
                _thr = float(_p["threshold"])
                _lw = float(_p["line_width"])
                _lc = _p["line_color"]
                _bg = _p["bg_color"]
                _style = _p["style"]
                _animate = bool(_p["animate"])

                # --- Select TOP: bring in the source by absolute path ---
                _sel = None
                try:
                    _sel = _cont.create(selectTOP, "source")
                    _sel.par.top = _src
                except Exception as _e:
                    report["warnings"].append("Select TOP failed: " + str(_e))
                    _sel = None

                # --- Edge TOP: extract contours. PROBE par name across TD builds. ---
                _edge = None
                try:
                    _edge = _cont.create(edgeTOP, "edge")
                    if _sel is not None:
                        try:
                            _edge.inputConnectors[0].connect(_sel)
                        except Exception as _e:
                            report["warnings"].append("Could not wire source into Edge TOP: " + str(_e))
                    _strength = max(0.1, 1.0 + _thr * 4.0)
                    _edge_par_names = ["strength", "strengthr", "edgecolor", "intensity"]
                    _set_one = False
                    for _pn in _edge_par_names:
                        _par = getattr(_edge.par, _pn, None)
                        if _par is not None:
                            try:
                                _par.val = _strength
                                report["edge_par_used"] = _pn
                                _set_one = True
                                break
                            except Exception:
                                report["warnings"].append("edgeTOP par '%s' present but not settable." % _pn)
                    if not _set_one:
                        report["warnings"].append(
                            "edgeTOP strength par not found among %s (UNVERIFIED TD build); using Edge defaults. Available: %s"
                            % (_edge_par_names, [pp.name for pp in _edge.pars()][:40])
                        )
                    report["edge_top"] = _edge.path
                except Exception as _e:
                    report["warnings"].append("Edge TOP failed: " + str(_e))
                    _edge = None

                _out = None  # final node before the Null

                if _style == "contour":
                    # --- GLSL TOP: edge luminance -> line_color over bg_color, optional marching dash ---
                    # GLSL rules: declare 'out vec4 fragColor', sample vUV.st, no built-in uTime — the
                    # animation phase is BAKED as an expression on a Vectors block (me.time.seconds),
                    # not a named custom-uniform par. Lowercase locals only (no F1/F2 #define clash).
                    _shader = (
                        "out vec4 fragColor;\\n"
                        "uniform vec3 uLineColor;\\n"
                        "uniform vec3 uBgColor;\\n"
                        "uniform float uThreshold;\\n"
                        "uniform float uWidth;\\n"
                        "uniform float uAnim;\\n"
                        "uniform float uMarch;\\n"
                        "void main(){\\n"
                        "    vec4 src = texture(sTD2DInputs[0], vUV.st);\\n"
                        "    float edge = max(src.r, max(src.g, src.b));\\n"
                        "    float w = max(uWidth, 0.5) * 0.04;\\n"
                        "    float line = smoothstep(uThreshold, uThreshold + w, edge);\\n"
                        "    if (uMarch > 0.5) {\\n"
                        "        float dash = 0.5 + 0.5 * sin((vUV.s + vUV.t) * 40.0 - uAnim * 4.0);\\n"
                        "        line *= dash;\\n"
                        "    }\\n"
                        "    vec3 col = mix(uBgColor, uLineColor, line);\\n"
                        "    fragColor = TDOutputSwizzle(vec4(col, 1.0));\\n"
                        "}\\n"
                    )
                    try:
                        _glsl = _cont.create(glslTOP, "contour")
                        try:
                            _glsl.par.outputresolution = "custom"
                            _glsl.par.resolutionw = _resw
                            _glsl.par.resolutionh = _resh
                        except Exception:
                            report["warnings"].append("Could not set GLSL output resolution.")
                        if _edge is not None:
                            try:
                                _glsl.inputConnectors[0].connect(_edge)
                            except Exception as _e:
                                report["warnings"].append("Could not wire Edge into GLSL: " + str(_e))
                        _frag = _cont.create(textDAT, "contour_frag")
                        _frag.text = _shader
                        try:
                            _glsl.par.pixeldat = _frag.name
                        except Exception as _e:
                            report["warnings"].append("Could not bind pixeldat: " + str(_e))
                        # Bind uniforms on the GLSL Vectors sequence. A scalar fills valuex; a vec3
                        # fills valuex/y/z. numBlocks has no structured setter — raise it first.
                        try:
                            _glsl.seq.vec.numBlocks = max(_glsl.seq.vec.numBlocks, 6)
                            _glsl.par.vec0name = "uLineColor"
                            _glsl.par.vec0valuex = float(_lc[0])
                            _glsl.par.vec0valuey = float(_lc[1])
                            _glsl.par.vec0valuez = float(_lc[2])
                            _glsl.par.vec1name = "uBgColor"
                            _glsl.par.vec1valuex = float(_bg[0])
                            _glsl.par.vec1valuey = float(_bg[1])
                            _glsl.par.vec1valuez = float(_bg[2])
                            _glsl.par.vec2name = "uThreshold"
                            _glsl.par.vec2valuex = _thr
                            _glsl.par.vec3name = "uWidth"
                            _glsl.par.vec3valuex = _lw
                            _glsl.par.vec4name = "uMarch"
                            _glsl.par.vec4valuex = 1.0 if _animate else 0.0
                            _glsl.par.vec5name = "uAnim"
                            if _animate:
                                _glsl.par.vec5valuex.expr = "me.time.seconds"
                            else:
                                _glsl.par.vec5valuex = 0.0
                        except Exception as _e:
                            report["warnings"].append("Could not bind GLSL uniforms: " + str(_e))
                        _out = _glsl
                    except Exception as _e:
                        report["warnings"].append(
                            "Contour GLSL stage failed (%s); falling back to the raw Edge TOP." % str(_e)
                        )
                        _out = _edge

                else:
                    # --- trace / plotter: vectorize edges -> geometry -> render. ---
                    report["warnings"].append(
                        "style '%s' vectorizes the edge image into geometry every frame; this is COOK-COSTLY on live video. For real-time use prefer style='contour'." % _style
                    )
                    # A Geometry COMP renders the SOP(s) that live INSIDE it with the
                    # render flag set — its input connectors are 3D OBJ inputs, not SOP
                    # inputs (connecting a SOP raises "Cannot connect a SOP to a OBJ").
                    # So create the geo first and build the Trace SOP as its child; the
                    # trace reads its source TOP via a path parameter, not a wire, so it
                    # works fine inside the geo.
                    _geo = None
                    try:
                        _geo = _cont.create(geometryCOMP, "geo")
                    except Exception as _e:
                        report["warnings"].append("Geometry COMP create failed: " + str(_e))
                        _geo = None
                    _trace_parent = _geo if _geo is not None else _cont
                    # Trace SOP: PROBE the optype + threshold par.
                    _trace = None
                    try:
                        _trace = _trace_parent.create(traceSOP, "trace")
                        report["trace_optype_used"] = "traceSOP"
                    except Exception as _e1:
                        try:
                            _tt = globals().get("traceSOP")
                            if _tt is not None:
                                _trace = _trace_parent.create(_tt, "trace")
                                report["trace_optype_used"] = "traceSOP(via td)"
                            else:
                                report["warnings"].append("traceSOP optype not found (UNVERIFIED TD build): " + str(_e1))
                        except Exception as _e2:
                            report["warnings"].append("Could not create Trace SOP: " + str(_e2))
                            _trace = None
                    # Make the geo render this SOP: set its render + display flags.
                    if _trace is not None and _geo is not None:
                        for _flag in ("render", "display"):
                            try:
                                setattr(_trace, _flag, True)
                            except Exception:
                                pass
                    if _trace is not None:
                        report["trace_sop"] = _trace.path
                        if _edge is not None:
                            _set_top = False
                            for _pn in ["top", "sourcetop", "image"]:
                                _par = getattr(_trace.par, _pn, None)
                                if _par is not None:
                                    try:
                                        _par.val = _edge.path
                                        _set_top = True
                                        break
                                    except Exception:
                                        report["warnings"].append("traceSOP par '%s' present but not settable." % _pn)
                            if not _set_top:
                                report["warnings"].append(
                                    "traceSOP source-TOP par not found (UNVERIFIED); set the Trace SOP image manually. Pars: %s"
                                    % ([pp.name for pp in _trace.pars()][:40])
                                )
                        _set_thr = False
                        for _pn in ["threshold", "edgethreshold", "steps"]:
                            _par = getattr(_trace.par, _pn, None)
                            if _par is not None:
                                try:
                                    _par.val = _thr
                                    _set_thr = True
                                    break
                                except Exception:
                                    report["warnings"].append("traceSOP par '%s' present but not settable." % _pn)
                        if not _set_thr:
                            report["warnings"].append(
                                "traceSOP threshold par not found among ['threshold','edgethreshold','steps'] (UNVERIFIED TD build)."
                            )
                    # Render the traced SOP (built inside _geo above) via Camera + Render TOP.
                    _rtop = None
                    try:
                        if _geo is None:
                            _geo = _cont.create(geometryCOMP, "geo")
                        try:
                            _mat = _cont.create(constantMAT, "line_mat")
                            _mat.par.colorr = float(_lc[0])
                            _mat.par.colorg = float(_lc[1])
                            _mat.par.colorb = float(_lc[2])
                            try:
                                _geo.par.material = _mat.name
                            except Exception:
                                report["warnings"].append("Could not assign material to geo.")
                        except Exception as _e:
                            report["warnings"].append("Constant MAT failed: " + str(_e))
                        _cam = _cont.create(cameraCOMP, "cam")
                        _rtop = _cont.create(renderTOP, "render")
                        try:
                            _rtop.par.outputresolution = "custom"
                            _rtop.par.resolutionw = _resw
                            _rtop.par.resolutionh = _resh
                        except Exception:
                            report["warnings"].append("Could not set Render TOP resolution.")
                        try:
                            _rtop.par.camera = _cam.path
                            _rtop.par.geometry = _geo.path
                        except Exception as _e:
                            report["warnings"].append("Could not bind camera/geometry on Render TOP: " + str(_e))
                        try:
                            _rtop.par.bgalpha = 1
                            _rtop.par.bgcolorr = float(_bg[0])
                            _rtop.par.bgcolorg = float(_bg[1])
                            _rtop.par.bgcolorb = float(_bg[2])
                        except Exception:
                            report["warnings"].append("Could not set Render TOP background color.")
                        _out = _rtop
                    except Exception as _e:
                        report["warnings"].append(
                            "Render stage failed (%s); falling back to the raw Edge TOP." % str(_e)
                        )
                        _out = _edge

                # --- Null TOP: stable output handle ---
                try:
                    _null = _cont.create(nullTOP, "out")
                    if _out is not None:
                        try:
                            _null.inputConnectors[0].connect(_out)
                        except Exception as _e:
                            report["warnings"].append("Could not wire output into Null TOP: " + str(_e))
                    report["output_top"] = _null.path
                except Exception as _e:
                    report["output_top"] = _out.path if _out is not None else report.get("edge_top", "")
                    report["warnings"].append("Null TOP failed: " + str(_e))
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildVectorLinesScript(payload: object): string {
  return buildPayloadScript(VECTOR_LINES_SCRIPT, payload);
}

export async function createVectorLinesImpl(ctx: ToolContext, args: CreateVectorLinesArgs) {
  return guardTd(
    async () => {
      const script = buildVectorLinesScript({
        parent_path: args.parent_path,
        name: args.name,
        source_top: args.source_top,
        style: args.style,
        threshold: args.threshold,
        line_width: args.line_width,
        line_color: args.line_color,
        bg_color: args.bg_color,
        animate: args.animate,
        resolution: args.resolution,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<VectorLinesReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Vector-lines build failed: ${report.fatal}`, report);
      }
      const warnNote = report.warnings.length > 0 ? `, ${report.warnings.length} warning(s)` : "";
      const animNote = args.animate && args.style === "contour" ? " (marching/animated)" : "";
      const summary = `Built ${report.style} line-art from ${args.source_top}${animNote} → ${report.output_top}${warnNote}.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerCreateVectorLines: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_vector_lines",
    {
      title: "Create vector lines",
      description:
        "Turn an image or video TOP into an animated line-art / contour / plotter look via edge-trace. Creates a new baseCOMP under `parent_path` holding: a Select TOP pulling in the source by absolute path (no cross-container wire), an Edge TOP extracting contours, then — by style — a contour shader (cheap, real-time: maps edges to line_color over bg_color with an optional marching draw-on) or a Trace SOP vectorizing the edges into rendered geometry (trace/plotter — crisp lines, but COOK-COSTLY on live video). Ends in a Null TOP output. The Edge TOP strength par and the Trace SOP optype/threshold par names vary by TouchDesigner build, so the bridge probes them and reports which it used; missing pars become warnings (the chain still builds). Returns a summary plus a JSON block with the container path, edge/trace/output paths, the probed par/optype names, and warnings.",
      inputSchema: createVectorLinesSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createVectorLinesImpl(ctx, args),
  );
};
