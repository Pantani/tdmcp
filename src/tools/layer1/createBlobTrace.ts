import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import {
  createSystemContainer,
  finalize,
  type NetworkBuilder,
  runBuild,
} from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

/**
 * Blob contour tracer. Turns a blob/silhouette into a vector OUTLINE: source → monochrome →
 * blur → threshold (the blob mask) → optional edge → Trace SOP (mask-to-polyline) → wireframe
 * render as clean contour line art. This is the CONTOUR-TRACE complement to create_vector_lines
 * (full image vectoriser) and export_sop_to_svg, and is distinct from create_blob_reactive
 * (which tracks blob position/reactivity — it does not draw the outline).
 */

const rgb = z.coerce.number().min(0).max(1);

export const createBlobTraceSchema = z.object({
  source: z
    .enum(["camera", "file", "synthetic", "existing_top"])
    .default("synthetic")
    .describe(
      "Blob source. 'camera' = live webcam (may prompt for macOS camera permission). 'file' = a movie file (movie_file_path). 'synthetic' = an animated noise blob so the trace is testable with no device (the default). 'existing_top' = trace a TOP you already have (existing_top_path).",
    ),
  movie_file_path: z
    .string()
    .optional()
    .describe("Path to a movie file to trace; used only when source='file'."),
  existing_top_path: z
    .string()
    .optional()
    .describe("Path of an existing TOP to trace; used only when source='existing_top'."),
  threshold: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.45)
    .describe(
      "Luminance cutoff that separates blob (foreground) from background. Live 'Threshold'.",
    ),
  invert: z
    .boolean()
    .default(false)
    .describe("Invert the mask so dark regions become the traced blob instead of bright ones."),
  pre_blur: z.coerce
    .number()
    .min(0)
    .max(64)
    .default(4)
    .describe(
      "Gaussian blur (pixels) before thresholding — smooths noisy edges into clean contours. Live 'Blur'.",
    ),
  edge_only: z
    .boolean()
    .default(false)
    .describe(
      "Run an Edge TOP before tracing so only the blob's boundary band is traced (hollow outline).",
    ),
  line_width: z.coerce
    .number()
    .positive()
    .default(2)
    .describe("Contour line width for the wireframe material."),
  line_color: z
    .tuple([rgb, rgb, rgb])
    .default([0.1, 1.0, 0.6])
    .describe("Contour line colour (RGB 0..1)."),
  background: z
    .tuple([rgb, rgb, rgb])
    .default([0.02, 0.02, 0.03])
    .describe("Background colour behind the traced contour (RGB 0..1)."),
  resolution: z
    .tuple([z.coerce.number().int().positive(), z.coerce.number().int().positive()])
    .default([1280, 720])
    .describe("Output resolution [width, height]."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("When true (default), expose live Threshold, Blur, and LineWidth controls."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent network where the blob-trace container is created (default '/project1')."),
});
type CreateBlobTraceArgs = z.infer<typeof createBlobTraceSchema>;

/**
 * Builds the blob source TOP (mirrors create_depth_displacement's buildSource): camera → Video
 * Device In, file → Movie File In (playing), synthetic → an animated Noise (a tz expression
 * scrolls it so the blob moves), existing_top → the given path.
 */
async function buildSource(builder: NetworkBuilder, args: CreateBlobTraceArgs): Promise<string> {
  if (args.source === "existing_top" && args.existing_top_path) {
    return args.existing_top_path;
  }
  if (args.source === "file") {
    return builder.add("moviefileinTOP", "videoin", {
      ...(args.movie_file_path ? { file: args.movie_file_path } : {}),
      play: 1,
    });
  }
  if (args.source === "synthetic") {
    const noise = await builder.add("noiseTOP", "videoin", { period: 3 });
    await builder.python(`op(${q(noise)}).par.tz.expr = "absTime.seconds * 0.3"`);
    return noise;
  }
  return builder.add("videodeviceinTOP", "videoin");
}

/** Defensive Trace SOP + geometry/material wiring (probes par names live). */
function buildTraceSetupScript(options: {
  trace: string;
  maskTop: string;
  geo: string;
  traceSelect: string;
  wire: string;
  lineWidth: number;
  color: [number, number, number];
}): string {
  const [cr, cg, cb] = options.color;
  return `def _set_par(node, names, value, warnings):
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
_geo = op(${q(options.geo)})
_sel = op(${q(options.traceSelect)})
_wire = op(${q(options.wire)})

if _trace is not None:
    # Trace SOP reads its image from a TOP-name parameter (spelling varies by build).
    _set_par(_trace, ["top", "topname", "topname1", "image", "source", "file"], ${q(options.maskTop)}, _warnings)

if _sel is not None:
    _set_par(_sel, ["sop", "soppath", "input"], ${q(options.trace)}, _warnings)
    try:
        _sel.render = True
        _sel.display = True
    except Exception:
        pass

if _wire is not None:
    for _name, _value in (("colorr", ${cr}), ("colorg", ${cg}), ("colorb", ${cb}),
                          ("alpha", 1), ("blending", 1), ("linewidth", ${options.lineWidth}),
                          ("wireframe", 1)):
        _set_par(_wire, [_name], _value, _warnings)

if _geo is not None:
    _set_par(_geo, ["material", "mat"], ${q(options.wire)}, _warnings)
    try:
        _geo.render = True
        _geo.display = True
    except Exception:
        pass

print(_warnings)
`;
}

export async function createBlobTraceImpl(ctx: ToolContext, args: CreateBlobTraceArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "blob_trace");
    const [width, height] = args.resolution;
    const [bgr, bgg, bgb] = args.background;

    // ── Blob mask pipeline ────────────────────────────────────────────────────
    const source = await buildSource(builder, args);
    const fit = await builder.add("fitTOP", "fit", { resolutionw: width, resolutionh: height });
    await builder.connect(source, fit);

    const mono = await builder.add("monochromeTOP", "monochrome");
    await builder.connect(fit, mono);

    const blur = await builder.add("blurTOP", "pre_blur", { size: args.pre_blur });
    await builder.connect(mono, blur);

    const mask = await builder.add("thresholdTOP", "mask", {
      threshold: args.threshold,
      comparator: "greater",
    });
    await builder.connect(blur, mask);

    // Invert the mask if requested (dark blob on bright bg).
    const level = await builder.add("levelTOP", "invert", {
      invert: args.invert ? 1 : 0,
    });
    await builder.connect(mask, level);

    // Optional edge pass: trace only the boundary band (hollow outline) instead of the filled blob.
    let traceInput = level;
    if (args.edge_only) {
      const edge = await builder.add("edgeTOP", "edges");
      await builder.connect(level, edge);
      traceInput = edge;
    }
    const maskOut = await builder.add("nullTOP", "mask_out");
    await builder.connect(traceInput, maskOut);

    // ── Trace SOP → geometry → contour render ─────────────────────────────────
    const trace = await builder.add("traceSOP", "trace1");
    const geo = await builder.add("geometryCOMP", "contour_geo");
    const traceSelect = await builder.add("selectSOP", "trace_select", undefined, geo);
    const wire = await builder.add("wireframeMAT", "wire");
    await builder.python(
      buildTraceSetupScript({
        trace,
        maskTop: maskOut,
        geo,
        traceSelect,
        wire,
        lineWidth: args.line_width,
        color: args.line_color,
      }),
    );

    // Ortho camera looking straight on so the contour reads as flat 2D line art.
    const cam = await builder.add("cameraCOMP", "cam", { tz: 3, projection: "ortho" });
    const light = await builder.add("lightCOMP", "light", { tz: 4 });
    const render = await builder.add("renderTOP", "render", {
      outputresolution: "custom",
      resolutionw: width,
      resolutionh: height,
      geometry: geo,
      camera: cam,
      lights: light,
      bgcolorr: bgr,
      bgcolorg: bgg,
      bgcolorb: bgb,
      bgcolora: 1,
    });
    const out = await builder.add("nullTOP", "out1");
    await builder.connect(render, out);

    // Keep-alive: a still source leaves the mask cold; force-cook the output each frame so
    // the contour stays live (mirrors create_depth_displacement's cooker idiom).
    const cooker = await builder.add("executeDAT", "cooker");
    await builder.python(
      `_c = op(${q(cooker)})\n_c.text = "def onFrameStart(frame):\\n\\tparent().op('out1').cook(force=True)\\n\\treturn\\n"\n_c.par.framestart = True\n_c.par.active = True`,
    );

    builder.warnings.push(
      "Trace SOP source-TOP parameter spelling varies by TD build; it is probed defensively (top/topname/image/…) and any miss is folded into the render callback's warnings rather than failing the build.",
    );
    if (args.source === "camera") {
      builder.warnings.push(
        "Camera source is opt-in and may wait on an OS permission dialog in TouchDesigner.",
      );
    }

    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "Threshold",
            type: "float",
            min: 0,
            max: 1,
            default: args.threshold,
            bind_to: [`${mask}.threshold`],
          },
          {
            name: "Blur",
            type: "float",
            min: 0,
            max: 64,
            default: args.pre_blur,
            bind_to: [`${blur}.size`],
          },
          {
            name: "LineWidth",
            type: "float",
            min: 0.5,
            max: 12,
            default: args.line_width,
            bind_to: [`${wire}.linewidth`],
          },
        ]
      : [];

    const modeNote = args.edge_only ? "boundary-band (hollow)" : "filled-blob";
    return finalize(ctx, {
      summary: `Built a blob contour trace (source: ${args.source}, ${modeNote} outline, threshold ${args.threshold}) rendered to ${out} — monochrome → blur → threshold mask → Trace SOP → wireframe render.`,
      builder,
      outputPath: out,
      capturePreviewImage: true,
      controls,
      extra: {
        source: args.source,
        threshold: args.threshold,
        invert: args.invert,
        pre_blur: args.pre_blur,
        edge_only: args.edge_only,
        line_width: args.line_width,
        mask_out: maskOut,
        trace_sop: trace,
        output_path: out,
      },
    });
  });
}

export const registerCreateBlobTrace: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_blob_trace",
    {
      title: "Create blob trace",
      description:
        "Trace the contour/outline of a blob or silhouette into vector line art: source → monochrome → blur → threshold (the blob mask, optionally inverted) → optional Edge (boundary-band only) → Trace SOP (mask-to-polyline) → wireframe render. This is the CONTOUR-TRACE complement to create_vector_lines (full image vectoriser) and export_sop_to_svg, and is distinct from create_blob_reactive (which tracks blob position/reactivity — it does not draw the outline). Source can be the live camera (may prompt for macOS permission), a movie file, an animated synthetic blob (testable without a camera), or an existing TOP. Creates a new baseCOMP under `parent_path`. Exposes Threshold, Blur, and LineWidth controls. Returns a summary plus a JSON block with the container path, created node paths, output path, exposed controls, node errors, warnings, and an inline preview image.",
      inputSchema: createBlobTraceSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createBlobTraceImpl(ctx, args),
  );
};
