import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { errorResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, type NetworkBuilder, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

const vectorLineSourceSchema = z.enum(["synthetic", "camera", "file", "existing_top"]);
const vectorLineModeSchema = z.enum(["hybrid_foreground", "foreground_mask", "full_frame"]);
const overlayModeSchema = z.enum(["over", "add", "screen", "multiply"]);

export const createVectorLinesSchema = z
  .object({
    name: z.string().default("vector_lines").describe("Name for the vector-line system COMP."),
    parent_path: z
      .string()
      .default("/project1")
      .describe("Parent COMP where the system container is created."),
    source: vectorLineSourceSchema
      .default("synthetic")
      .describe(
        "Image source. 'synthetic' is the safe default; 'camera' is opt-in; 'file' reads movie_file_path; 'existing_top' pulls existing_top_path through a Select TOP.",
      ),
    existing_top_path: z
      .string()
      .optional()
      .describe("Existing TOP path used when source='existing_top'."),
    movie_file_path: z.string().optional().describe("Movie/image path used when source='file'."),
    camera_device: z
      .string()
      .optional()
      .describe("Optional camera device name for source='camera'."),
    mode: vectorLineModeSchema
      .default("hybrid_foreground")
      .describe(
        "Prep mode: foreground-oriented mask, mask-only, or full_frame edge/detail tracing.",
      ),
    analysis_resolution: z
      .tuple([z.coerce.number().int().positive(), z.coerce.number().int().positive()])
      .default([640, 360])
      .describe("Capture/trace resolution [width, height] that bounds vectorization cost."),
    threshold: z.coerce
      .number()
      .min(0)
      .max(1)
      .default(0.45)
      .describe("Brightness/mask cutoff for the prep image and Trace SOP."),
    pre_blur: z.coerce
      .number()
      .min(0)
      .default(2)
      .describe("Blur amount before thresholding/tracing to remove camera noise."),
    invert: z.boolean().default(false).describe("Invert the prepared mask before tracing."),
    remove_borders: z
      .boolean()
      .default(true)
      .describe("Remove dirty image borders in Trace SOP when supported."),
    resample: z
      .boolean()
      .default(true)
      .describe("Resample Trace SOP shapes to reduce excessive point density."),
    step_size: z.coerce
      .number()
      .positive()
      .default(4)
      .describe("Trace SOP resample step / simplification amount."),
    smooth_shapes: z
      .boolean()
      .default(true)
      .describe("Smooth traced shapes to reduce sharp camera-noise corners."),
    fit_curves: z
      .boolean()
      .default(false)
      .describe("Fit Trace SOP output to Bezier curves; off by default until live-probed."),
    line_color: z.string().default("#49dcb2").describe("Vector material color as '#rrggbb'."),
    line_width: z.coerce
      .number()
      .positive()
      .default(2)
      .describe("Wireframe line width where supported by the material."),
    opacity: z.coerce
      .number()
      .min(0)
      .max(1)
      .default(0.9)
      .describe("Opacity of the rendered vector overlay."),
    overlay_mode: overlayModeSchema
      .default("over")
      .describe("Composite TOP operand when show_source=true."),
    show_source: z
      .boolean()
      .default(true)
      .describe("Composite the source image under the vector layer when true."),
    expose_controls: z
      .boolean()
      .default(true)
      .describe("Expose the Vectorize pulse plus prep/look/calibration controls."),
  })
  .superRefine((args, ctx) => {
    if (args.source === "existing_top" && !args.existing_top_path) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["existing_top_path"],
        message: "existing_top_path is required when source='existing_top'.",
      });
    }
    if (args.source === "file" && !args.movie_file_path) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["movie_file_path"],
        message: "movie_file_path is required when source='file'.",
      });
    }
  });

type CreateVectorLinesArgs = z.infer<typeof createVectorLinesSchema>;

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function hexToRgb(hex: string): Rgb {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return { r: 0.286, g: 0.862, b: 0.698 };
  let value = match[1] as string;
  if (value.length === 3) {
    value = value
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const int = Number.parseInt(value, 16);
  return {
    r: ((int >> 16) & 0xff) / 255,
    g: ((int >> 8) & 0xff) / 255,
    b: (int & 0xff) / 255,
  };
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join(".") || "args";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function pyValue(value: string | number | boolean): string {
  if (typeof value === "string") return q(value);
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

function pyDict(entries: Array<[string, string | number | boolean]>): string {
  return `{${entries.map(([key, value]) => `'${key}': ${pyValue(value)}`).join(", ")}}`;
}

function syntheticSourceShader(): string {
  return `out vec4 fragColor;

float circle_sdf(vec2 p, vec2 c, float r) {
    return length(p - c) - r;
}

float box_sdf(vec2 p, vec2 c, vec2 b) {
    vec2 d = abs(p - c) - b;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

float fill_shape(float d) {
    return 1.0 - smoothstep(0.0, 0.006, d);
}

float stroke_shape(float d, float w) {
    return 1.0 - smoothstep(w, w + 0.006, abs(d));
}

void main() {
    vec2 uv = vUV.st;
    vec2 p = uv - 0.5;
    p.x *= 16.0 / 9.0;

    float shape = 0.0;
    shape = max(shape, stroke_shape(circle_sdf(p, vec2(-0.42, 0.08), 0.22), 0.018));
    shape = max(shape, fill_shape(circle_sdf(p, vec2(0.42, 0.16), 0.13)));
    shape = max(shape, fill_shape(box_sdf(p, vec2(0.0, -0.16), vec2(0.22, 0.11))));
    shape = max(shape, stroke_shape(box_sdf(p, vec2(0.0, -0.16), vec2(0.34, 0.2)), 0.014));

    vec2 q = mat2(0.866, -0.5, 0.5, 0.866) * (p - vec2(0.25, -0.18));
    shape = max(shape, fill_shape(box_sdf(q, vec2(0.0), vec2(0.36, 0.035))));

    float grid_x = 1.0 - smoothstep(0.006, 0.011, abs(fract(uv.x * 8.0) - 0.5));
    float grid_y = 1.0 - smoothstep(0.006, 0.011, abs(fract(uv.y * 5.0) - 0.5));
    float grid = 0.22 * max(grid_x, grid_y);

    float value = max(shape, grid);
    vec3 bg = vec3(0.02, 0.025, 0.03);
    vec3 fg = vec3(0.95, 0.97, 1.0);
    // static contour source card: crisp synthetic shapes for first-run vector tracing.
    fragColor = TDOutputSwizzle(vec4(mix(bg, fg, value), 1.0));
}`;
}

function lineArtShader(): string {
  return `out vec4 fragColor;
uniform vec3 uLineColor;
uniform float uWidth;

void main() {
    vec2 uv = vUV.st;
    vec2 px = uTD2DInfos[0].res.xy * max(uWidth, 1.0);
    float c = texture(sTD2DInputs[0], uv).r;
    float r = texture(sTD2DInputs[0], uv + vec2(px.x, 0.0)).r;
    float l = texture(sTD2DInputs[0], uv - vec2(px.x, 0.0)).r;
    float u = texture(sTD2DInputs[0], uv + vec2(0.0, px.y)).r;
    float d = texture(sTD2DInputs[0], uv - vec2(0.0, px.y)).r;
    float edge = max(max(abs(c - r), abs(c - l)), max(abs(c - u), abs(c - d)));
    float alpha = smoothstep(0.05, 0.22, edge);
    float margin = max(px.x, px.y) * 1.5;
    float inside = step(margin, uv.x) * step(margin, uv.y) * step(uv.x, 1.0 - margin) * step(uv.y, 1.0 - margin);
    alpha *= inside;
    fragColor = TDOutputSwizzle(vec4(uLineColor * alpha, alpha));
}`;
}

async function buildSource(builder: NetworkBuilder, args: CreateVectorLinesArgs): Promise<string> {
  if (args.source === "existing_top") {
    const select = await builder.add("selectTOP", "source_select");
    await builder.setParams(select, { top: args.existing_top_path });
    return select;
  }

  if (args.source === "file") {
    return builder.add("moviefileinTOP", "source_file", {
      file: args.movie_file_path,
      play: 0,
    });
  }

  if (args.source === "camera") {
    const camera = await builder.add("videodeviceinTOP", "source_camera");
    if (args.camera_device) {
      await builder.python(
        `_n = op(${q(camera)})\n_device = ${q(args.camera_device)}\nfor _name in ["device", "devicename", "inputdevice"]:\n    try:\n        _par = getattr(_n.par, _name, None)\n        if _par is not None:\n            _par.val = _device\n            break\n    except Exception:\n        pass`,
      );
    }
    return camera;
  }

  const card = await builder.add("glslTOP", "source_card");
  await builder.setParams(card, {
    outputresolution: "custom",
    resolutionw: args.analysis_resolution[0],
    resolutionh: args.analysis_resolution[1],
  });
  const frag = await builder.add("textDAT", "source_card_frag");
  await builder.python(
    `_g = op(${q(card)})\n_f = op(${q(frag)})\nif _f is not None:\n    _f.text = ${q(syntheticSourceShader())}\nif _g is not None and _f is not None:\n    try:\n        _g.par.pixeldat = _f.name\n    except Exception:\n        pass`,
  );
  return card;
}

function traceValues(args: CreateVectorLinesArgs): Array<[string, number]> {
  return [
    ["thresh", args.threshold],
    ["delborder", Number(args.remove_borders)],
    ["doresample", Number(args.resample)],
    ["step", args.step_size],
    ["dosmooth", Number(args.smooth_shapes)],
    ["fitcurve", Number(args.fit_curves)],
  ];
}

function buildTraceSetupScript(options: {
  trace: string;
  frozen: string;
  geo: string;
  traceSelect: string;
  wire: string;
  args: CreateVectorLinesArgs;
  rgb: Rgb;
}): string {
  const traceParams = pyDict(traceValues(options.args));
  const materialParams = pyDict([
    ["colorr", options.rgb.r],
    ["colorg", options.rgb.g],
    ["colorb", options.rgb.b],
    ["alpha", 1],
    ["blending", 1],
    ["linewidth", options.args.line_width],
    ["wireframe", 1],
  ]);

  return `TRACE_PARAM_VALUES = ${traceParams}
MATERIAL_PARAM_VALUES = ${materialParams}
LINE_COLOR_HEX = ${q(options.args.line_color)}
TRACE_SOURCE = ${q(options.frozen)}

def _set_par(node, names, value, warnings):
    if node is None:
        warnings.append("Missing node while setting parameter.")
        return False
    for name in names:
        try:
            par = getattr(node.par, name, None)
            if par is not None:
                par.val = value
                return True
        except Exception as exc:
            warnings.append("%s.%s rejected %r: %s" % (node.path, name, value, exc))
    warnings.append("%s has none of the parameters %s" % (node.path, ", ".join(names)))
    return False

_warnings = []
_trace = op(${q(options.trace)})
_frozen = op(${q(options.frozen)})
_geo = op(${q(options.geo)})
_sel = op(${q(options.traceSelect)})
_wire = op(${q(options.wire)})

if _trace is not None:
    _set_par(_trace, ["top", "topname", "topname1", "image", "source", "file"], TRACE_SOURCE, _warnings)
    for _name, _value in TRACE_PARAM_VALUES.items():
        _set_par(_trace, [_name], _value, _warnings)

if _sel is not None:
    _set_par(_sel, ["sop", "soppath", "input"], ${q(options.trace)}, _warnings)
    try:
        _sel.render = True
        _sel.display = True
    except Exception:
        pass

if _wire is not None:
    for _name, _value in MATERIAL_PARAM_VALUES.items():
        _set_par(_wire, [_name], _value, _warnings)

if _geo is not None:
    _set_par(_geo, ["material", "mat"], ${q(options.wire)}, _warnings)
    _set_par(_geo, ["sop", "soppath"], ${q(options.traceSelect)}, _warnings)
    try:
        _geo.render = True
        _geo.display = True
    except Exception:
        pass

if _warnings:
    print("create_vector_lines setup warnings: " + " | ".join(_warnings))
`;
}

function buildVectorizeCallback(options: {
  compName: string;
  prep: string;
  frozen: string;
  trace: string;
  render: string;
  output: string;
  status: string;
  wire: string;
  vectorsOpacity: string;
  overlay?: string;
  snapshotFileName: string;
  args: CreateVectorLinesArgs;
  rgb: Rgb;
}): string {
  const traceParams = pyDict(traceValues(options.args));
  const materialParams = pyDict([
    ["colorr", options.rgb.r],
    ["colorg", options.rgb.g],
    ["colorb", options.rgb.b],
    ["alpha", 1],
    ["blending", 1],
    ["linewidth", options.args.line_width],
    ["wireframe", 1],
  ]);

  return `import os
import tempfile
import traceback

PREP_OUT = ${q(options.prep)}
FROZEN_FRAME = ${q(options.frozen)}
TRACE_SOP = ${q(options.trace)}
RENDER_TOP = ${q(options.render)}
OUT_TOP = ${q(options.output)}
STATUS_DAT = ${q(options.status)}
WIRE_MAT = ${q(options.wire)}
VECTORS_OPACITY = ${q(options.vectorsOpacity)}
OVERLAY_TOP = ${q(options.overlay ?? "")}
SNAPSHOT_FILE_NAME = ${q(options.snapshotFileName)}
TRACE_PARAM_VALUES = ${traceParams}
MATERIAL_PARAM_VALUES = ${materialParams}
LINE_COLOR_HEX = ${q(options.args.line_color)}

def _status(rows):
    dat = op(STATUS_DAT)
    if dat is None:
        return
    try:
        dat.clear()
        dat.appendRow(["key", "value"])
        for key, value in rows:
            dat.appendRow([str(key), str(value)])
    except Exception:
        pass

def _project_folder():
    try:
        folder = project.folder
        if folder:
            return folder
    except Exception:
        pass
    return tempfile.gettempdir()

def _snapshot_path():
    folder = os.path.join(_project_folder(), "tdmcp_snapshots", "vector_lines")
    os.makedirs(folder, exist_ok=True)
    return os.path.join(folder, SNAPSHOT_FILE_NAME)

def _set_par(node, names, value, warnings):
    if node is None:
        warnings.append("Missing node while setting parameter.")
        return False
    for name in names:
        try:
            par = getattr(node.par, name, None)
            if par is not None:
                par.val = value
                return True
        except Exception as exc:
            warnings.append("%s.%s rejected %r: %s" % (node.path, name, value, exc))
    warnings.append("%s has none of the parameters %s" % (node.path, ", ".join(names)))
    return False

def _owner_par(owner, name, fallback):
    try:
        par = getattr(owner.par, name, None)
        if par is not None:
            return par.eval()
    except Exception:
        pass
    return fallback

def _clamp01(value):
    try:
        return max(0.0, min(1.0, float(value)))
    except Exception:
        return 0.0

def _sync_trace(owner, snapshot_path, warnings):
    trace = op(TRACE_SOP)
    values = dict(TRACE_PARAM_VALUES)
    values["thresh"] = float(_owner_par(owner, "Threshold", values["thresh"]))
    values["delborder"] = int(bool(_owner_par(owner, "Removeborders", values["delborder"])))
    values["doresample"] = int(bool(_owner_par(owner, "Resample", values["doresample"])))
    values["step"] = float(_owner_par(owner, "Stepsize", values["step"]))
    values["dosmooth"] = int(bool(_owner_par(owner, "Smoothshapes", values["dosmooth"])))
    values["fitcurve"] = int(bool(_owner_par(owner, "Fitcurves", values["fitcurve"])))
    _set_par(trace, ["top", "topname", "topname1", "image", "source", "file"], FROZEN_FRAME, warnings)
    for key, value in values.items():
        _set_par(trace, [key], value, warnings)

def _sync_look(owner, warnings):
    mat = op(WIRE_MAT)
    values = dict(MATERIAL_PARAM_VALUES)
    opacity = float(_owner_par(owner, "Opacity", ${options.args.opacity}))
    values["colorr"] = _clamp01(_owner_par(owner, "Linecolorr", values["colorr"]))
    values["colorg"] = _clamp01(_owner_par(owner, "Linecolorg", values["colorg"]))
    values["colorb"] = _clamp01(_owner_par(owner, "Linecolorb", values["colorb"]))
    values["linewidth"] = float(_owner_par(owner, "Linewidth", values["linewidth"]))
    for key, value in values.items():
        _set_par(mat, [key], value, warnings)
    level = op(VECTORS_OPACITY)
    _set_par(level, ["opacity"], opacity, warnings)
    overlay = op(OVERLAY_TOP) if OVERLAY_TOP else None
    if overlay is not None:
        _set_par(overlay, ["operand"], str(_owner_par(owner, "Overlaymode", ${q(options.args.overlay_mode)})), warnings)

def _pulse(node):
    if node is None:
        return
    for name in ["reload", "reloadpulse", "pulse", "cook"]:
        try:
            par = getattr(node.par, name, None)
            if par is not None and hasattr(par, "pulse"):
                par.pulse()
                return
        except Exception:
            pass

def onValueChange(par, prev):
    return

def onPulse(par):
    if par.name != "Vectorize":
        return
    owner = par.owner
    warnings = []
    try:
        prep = op(PREP_OUT)
        frozen = op(FROZEN_FRAME)
        if prep is None:
            raise Exception("prep_out not found: " + PREP_OUT)
        snapshot_path = _snapshot_path()
        prep.cook(force=True)
        prep.save(snapshot_path)
        _set_par(frozen, ["file", "file1"], snapshot_path, warnings)
        _pulse(frozen)
        _sync_trace(owner, snapshot_path, warnings)
        _sync_look(owner, warnings)
        for path in [TRACE_SOP, RENDER_TOP, OUT_TOP]:
            node = op(path)
            if node is not None:
                node.cook(force=True)
        trace = op(TRACE_SOP)
        point_count = getattr(trace, "numPoints", "")
        prim_count = getattr(trace, "numPrims", "")
        _status([
            ("status", "captured"),
            ("snapshot_path", snapshot_path),
            ("points", point_count),
            ("primitives", prim_count),
            ("warnings", " | ".join(warnings)),
        ])
    except Exception:
        _status([
            ("status", "trace failed"),
            ("error", traceback.format_exc().splitlines()[-1]),
            ("warnings", " | ".join(warnings)),
        ])
    return
`;
}

function installVectorizeCallbackScript(options: { engine: string; callback: string }): string {
  return `_e = op(${q(options.engine)})
_e.par.op = _e.parent().path
_e.par.pars = "*"
_e.par.custom = True
_e.par.builtin = False
_e.par.valuechange = False
_e.par.onpulse = True
_e.par.active = True
_e.text = ${q(options.callback)}
`;
}

function bindLineArtShaderScript(options: {
  lineArt: string;
  frag: string;
  args: CreateVectorLinesArgs;
  rgb: Rgb;
}) {
  return [
    `_g = op(${q(options.lineArt)})`,
    `_f = op(${q(options.frag)})`,
    `if _f is not None:`,
    `    _f.text = ${q(lineArtShader())}`,
    `if _g is not None and _f is not None:`,
    `    try:`,
    `        _g.par.pixeldat = _f.name`,
    `    except Exception:`,
    `        pass`,
    `    try:`,
    `        _g.seq.color.numBlocks = max(_g.seq.color.numBlocks, 1)`,
    `        _g.par.color0name = 'uLineColor'`,
    `        _g.par.color0rgbr.expr = ${q(`parent().par.Linecolorr.eval() if hasattr(parent().par, 'Linecolorr') else ${options.rgb.r}`)}`,
    `        _g.par.color0rgbg.expr = ${q(`parent().par.Linecolorg.eval() if hasattr(parent().par, 'Linecolorg') else ${options.rgb.g}`)}`,
    `        _g.par.color0rgbb.expr = ${q(`parent().par.Linecolorb.eval() if hasattr(parent().par, 'Linecolorb') else ${options.rgb.b}`)}`,
    `        _g.par.color0rgbr.mode = type(_g.par.color0rgbr.mode).EXPRESSION`,
    `        _g.par.color0rgbg.mode = type(_g.par.color0rgbg.mode).EXPRESSION`,
    `        _g.par.color0rgbb.mode = type(_g.par.color0rgbb.mode).EXPRESSION`,
    `    except Exception:`,
    `        pass`,
    `    try:`,
    `        _g.seq.vec.numBlocks = max(_g.seq.vec.numBlocks, 1)`,
    `        _g.par.vec0name = 'uWidth'`,
    `        _g.par.vec0valuex.expr = ${q(`parent().par.Linewidth.eval() if hasattr(parent().par, 'Linewidth') else ${options.args.line_width}`)}`,
    `        _g.par.vec0valuex.mode = type(_g.par.vec0valuex.mode).EXPRESSION`,
    `    except Exception:`,
    `        pass`,
  ].join("\n");
}

function controlsFor(args: CreateVectorLinesArgs, paths: Record<string, string>): ControlSpec[] {
  if (!args.expose_controls) return [];

  return [
    { name: "Vectorize", type: "pulse", bind_to: [] },
    {
      name: "Threshold",
      type: "float",
      min: 0,
      max: 1,
      default: args.threshold,
      bind_to: [`${paths.mask}.threshold`],
    },
    {
      name: "PreBlur",
      type: "float",
      min: 0,
      max: 32,
      default: args.pre_blur,
      bind_to: [`${paths.blur}.size`],
    },
    { name: "Invert", type: "toggle", default: args.invert, bind_to: [`${paths.invert}.invert`] },
    { name: "RemoveBorders", type: "toggle", default: args.remove_borders, bind_to: [] },
    { name: "Resample", type: "toggle", default: args.resample, bind_to: [] },
    { name: "StepSize", type: "float", min: 1, max: 32, default: args.step_size, bind_to: [] },
    { name: "SmoothShapes", type: "toggle", default: args.smooth_shapes, bind_to: [] },
    { name: "FitCurves", type: "toggle", default: args.fit_curves, bind_to: [] },
    { name: "LineColor", type: "rgb", default: args.line_color, bind_to: [] },
    {
      name: "LineWidth",
      type: "float",
      min: 0.25,
      max: 12,
      default: args.line_width,
      bind_to: [`${paths.wire}.linewidth`],
    },
    {
      name: "Opacity",
      type: "float",
      min: 0,
      max: 1,
      default: args.opacity,
      bind_to: [`${paths.vectorsOpacity}.opacity`],
    },
    {
      name: "OverlayMode",
      type: "menu",
      default: args.overlay_mode,
      menu_items: overlayModeSchema.options,
      bind_to: paths.overlay ? [`${paths.overlay}.operand`] : [],
    },
    {
      name: "Scale",
      type: "float",
      min: 0.1,
      max: 4,
      default: 1,
      bind_to: [`${paths.geo}.sx`, `${paths.geo}.sy`, `${paths.geo}.sz`],
    },
    { name: "OffsetX", type: "float", min: -1, max: 1, default: 0, bind_to: [`${paths.geo}.tx`] },
    { name: "OffsetY", type: "float", min: -1, max: 1, default: 0, bind_to: [`${paths.geo}.ty`] },
  ];
}

export async function createVectorLinesImpl(ctx: ToolContext, args: CreateVectorLinesArgs) {
  return runBuild(async () => {
    const [resW, resH] = args.analysis_resolution;
    const rgb = hexToRgb(args.line_color);
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);

    const source = await buildSource(builder, args);

    const fit = await builder.add("fitTOP", "fit_source");
    await builder.setParams(fit, {
      outputresolution: "custom",
      resolutionw: resW,
      resolutionh: resH,
    });
    await builder.connect(source, fit);

    const sourceDisplay = await builder.add("nullTOP", "source_display");
    await builder.connect(fit, sourceDisplay);

    const mono = await builder.add("monochromeTOP", "monochrome");
    await builder.connect(fit, mono);

    const blur = await builder.add("blurTOP", "pre_blur");
    await builder.setParams(blur, { size: args.pre_blur });
    await builder.connect(mono, blur);

    let prepInput = blur;
    if (args.mode === "full_frame") {
      const edges = await builder.add("edgeTOP", "full_frame_edges");
      await builder.connect(blur, edges);
      prepInput = edges;
    }

    const mask = await builder.add("thresholdTOP", "mask");
    await builder.setParams(mask, { threshold: args.threshold, comparator: "greater" });
    await builder.connect(prepInput, mask);

    const invert = await builder.add("levelTOP", "invert");
    await builder.setParams(invert, { invert: Number(args.invert), brightness1: 1 });
    await builder.connect(mask, invert);

    const prepOut = await builder.add("nullTOP", "prep_out");
    await builder.connect(invert, prepOut);

    const snapshotFileName = `${args.name}_latest.png`;
    const snapshotPath = `tdmcp_snapshots/vector_lines/${snapshotFileName}`;
    const frozen = await builder.add("moviefileinTOP", "frozen_frame", { play: 0 });

    const trace = await builder.add("traceSOP", "trace1");
    const geo = await builder.add("geometryCOMP", "vector_geo");
    const traceSelect = await builder.add("selectSOP", "trace_select", undefined, geo);
    const wire = await builder.add("wireframeMAT", "wire", {
      colorr: rgb.r,
      colorg: rgb.g,
      colorb: rgb.b,
      alpha: 1,
      blending: 1,
      linewidth: args.line_width,
      wireframe: 1,
    });
    await builder.python(
      buildTraceSetupScript({
        trace,
        frozen,
        geo,
        traceSelect,
        wire,
        args,
        rgb,
      }),
    );

    const cam = await builder.add("cameraCOMP", "cam", { tz: 3, projection: "ortho" });
    const light = await builder.add("lightCOMP", "light", { tz: 4 });
    const render = await builder.add("renderTOP", "render_vectors");
    await builder.setParams(render, {
      outputresolution: "custom",
      resolutionw: resW,
      resolutionh: resH,
      geometry: geo,
      camera: cam,
      lights: light,
    });

    const lineArt = await builder.add("glslTOP", "line_art");
    await builder.setParams(lineArt, {
      outputresolution: "custom",
      resolutionw: resW,
      resolutionh: resH,
    });
    await builder.connect(frozen, lineArt);
    const lineArtFrag = await builder.add("textDAT", "line_art_frag");
    await builder.python(bindLineArtShaderScript({ lineArt, frag: lineArtFrag, args, rgb }));

    const vectorsOpacity = await builder.add("levelTOP", "vectors_opacity");
    await builder.setParams(vectorsOpacity, { opacity: args.opacity });
    await builder.connect(lineArt, vectorsOpacity);

    const vectorsOut = await builder.add("nullTOP", "vectors_out");
    await builder.connect(vectorsOpacity, vectorsOut);

    let outputInput = vectorsOpacity;
    let overlay: string | undefined;
    if (args.show_source) {
      overlay = await builder.add("compositeTOP", "overlay");
      await builder.setParams(overlay, { operand: args.overlay_mode });
      await builder.connect(vectorsOpacity, overlay, 0, 0);
      await builder.connect(sourceDisplay, overlay, 0, 1);
      outputInput = overlay;
    }

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(outputInput, out);

    const status = await builder.add("tableDAT", "status");
    const engine = await builder.add("parameterexecuteDAT", "vectorize_engine");
    const callback = buildVectorizeCallback({
      compName: args.name,
      prep: prepOut,
      frozen,
      trace,
      render,
      output: out,
      status,
      wire,
      vectorsOpacity,
      overlay,
      snapshotFileName,
      args,
      rgb,
    });
    await builder.python(installVectorizeCallbackScript({ engine, callback }));

    builder.warnings.push(
      "Trace SOP source parameter is probed defensively at build/pulse time; live TD validation is still required for exact TOP Name parameter spelling.",
    );
    builder.warnings.push(
      "Snapshot path resolves at pulse time under project.folder or a temp fallback.",
    );
    if (args.source === "camera") {
      builder.warnings.push(
        "Camera source is opt-in and may wait on an OS permission dialog in TouchDesigner.",
      );
    }

    const controls = controlsFor(args, {
      mask,
      blur,
      invert,
      wire,
      vectorsOpacity,
      overlay: overlay ?? "",
      geo,
    });

    return finalize(ctx, {
      summary:
        `Built pulse-driven vector lines (${args.source}, ${args.mode}) at ${resW}x${resH}. ` +
        `Press the Vectorize pulse on ${builder.containerPath} to capture prep_out into ` +
        `${snapshotPath}, reload frozen_frame, update trace1, and composite vectors to ${out}.`,
      builder,
      outputPath: out,
      capturePreviewImage: true,
      controls,
      extra: {
        source: args.source,
        mode: args.mode,
        source_path: source,
        source_display: sourceDisplay,
        prep_path: prepOut,
        frozen_frame: frozen,
        snapshot_path: snapshotPath,
        trace_sop: trace,
        vector_geo: geo,
        vectors_output: vectorsOut,
        output_path: out,
        analysis_resolution: args.analysis_resolution,
        threshold: args.threshold,
        pre_blur: args.pre_blur,
        remove_borders: args.remove_borders,
        resample: args.resample,
        step_size: args.step_size,
        smooth_shapes: args.smooth_shapes,
        fit_curves: args.fit_curves,
        line_color: args.line_color,
        line_width: args.line_width,
        opacity: args.opacity,
        overlay_mode: args.overlay_mode,
        show_source: args.show_source,
        realtime: false,
        pulse_callback: engine,
      },
    });
  });
}

export const registerCreateVectorLines: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_vector_lines",
    {
      title: "Create vector lines",
      description:
        "Build a pulse-driven image-to-vector-lines system: capture a still frame from a synthetic, camera, file, or existing TOP source, prepare a monochrome mask, freeze it to a snapshot, trace it through a Trace SOP for editable vector geometry, generate a clean TOP line-art overlay, and composite it over the source. Phase 1 is intentionally not realtime: the artist presses the Vectorize pulse to update trace1/frozen_frame, keeping cook cost bounded. Source defaults to a static synthetic contour card so it previews without camera permissions or moving noise; camera is opt-in. Exposes Vectorize, Threshold, PreBlur, StepSize, Smooth/Fit/Border toggles, line color/width, opacity, overlay mode, and calibration knobs. Returns the container, source/prep/frozen/trace/vector/output paths, warnings for unverified Trace/snapshot details, and a preview.",
      inputSchema: createVectorLinesSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => {
      const parsed = createVectorLinesSchema.safeParse(args);
      if (!parsed.success) {
        return errorResult(
          `Invalid create_vector_lines arguments: ${formatZodIssues(parsed.error)}`,
        );
      }
      return createVectorLinesImpl(ctx, parsed.data);
    },
  );
};
