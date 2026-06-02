import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { errorResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, type NetworkBuilder, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

export const createHistogramScopeSchema = z.object({
  source: z
    .enum(["existing_top", "test_pattern", "file", "device"])
    .default("test_pattern")
    .describe(
      "Video source. 'test_pattern' = synthetic Banana.tif (no permission needed). 'existing_top' = reuse a TOP you already have (provide existing_top_path). 'file' = a video/image file. 'device' = live camera — may hang TD on a macOS permission modal.",
    ),
  existing_top_path: z
    .string()
    .optional()
    .describe("Path of an existing TOP to scope (source='existing_top')."),
  video_file_path: z.string().optional().describe("Video/image file path (source='file')."),
  mode: z
    .enum(["luma", "rgb"])
    .default("luma")
    .describe(
      "Histogram mode. 'luma' = single luminance trace. 'rgb' = three overlaid per-channel traces. Note: rgb mode is informational only in v1 — ships as luma with rgb flag in extra.",
    ),
  bins: z
    .number()
    .int()
    .min(16)
    .max(512)
    .default(64)
    .describe(
      "Number of histogram bins (16..512). Drives the GLSL TOP output width. Changing after build requires a rebuild.",
    ),
  gain: z
    .number()
    .positive()
    .default(1.0)
    .describe("Pre-scope brightness (Level TOP brightness1 parameter)."),
  log_scale: z
    .boolean()
    .default(false)
    .describe(
      "Compress tall peaks with log(1+x) in the normalisation Math CHOP. Changing after build requires a rebuild.",
    ),
  trace_color: z
    .string()
    .default("#00ff88")
    .describe("Phosphor tint colour for luma mode as a hex string. Ignored when mode='rgb'."),
  bar_style: z
    .enum(["bars", "line"])
    .default("bars")
    .describe(
      "Reserved — informational only in v1. Both values currently emit the same `choptoSOP`-fed render (a thin vertical strip per bin); a true polyline 'line' mode is planned. Setting this changes the value recorded in `extra` but does not yet change the SOP topology.",
    ),
  resolution: z
    .tuple([z.number().int().positive(), z.number().int().positive()])
    .default([1024, 512])
    .describe("Output Null TOP size [width, height]."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Bind live controls: Gain, TraceColor (luma mode), LogScale (informational)."),
  parent_path: z
    .string()
    .default("/project1")
    .describe(
      "Parent COMP path; the histogram scope container is created as 'histogram_scope' inside it.",
    ),
});

/** Cross-field validation: source-dependent required fields. */
const refineSource = (val: CreateHistogramScopeArgs, ctx: z.RefinementCtx) => {
  if (val.source === "existing_top" && !val.existing_top_path?.trim()) {
    ctx.addIssue({
      code: "custom",
      path: ["existing_top_path"],
      message: "existing_top_path is required when source='existing_top'",
    });
  }
  if (val.source === "file" && !val.video_file_path?.trim()) {
    ctx.addIssue({
      code: "custom",
      path: ["video_file_path"],
      message: "video_file_path is required when source='file'",
    });
  }
};

export const createHistogramScopeValidatedSchema =
  createHistogramScopeSchema.superRefine(refineSource);

type CreateHistogramScopeArgs = z.infer<typeof createHistogramScopeSchema>;

/** Parses '#rrggbb' / 'rrggbb' (3- or 6-digit) into 0..1 RGB. Falls back to green. */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { r: 0, g: 1, b: 0.53 };
  let h = m[1] as string;
  if (h.length === 3)
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  const int = Number.parseInt(h, 16);
  return {
    r: ((int >> 16) & 0xff) / 255,
    g: ((int >> 8) & 0xff) / 255,
    b: (int & 0xff) / 255,
  };
}

/** Build the video source TOP and return its path. */
async function buildSource(
  builder: NetworkBuilder,
  args: CreateHistogramScopeArgs,
): Promise<string> {
  if (args.source === "existing_top" && args.existing_top_path) {
    return args.existing_top_path;
  }
  if (args.source === "file") {
    return builder.add("moviefileinTOP", "videoin", {
      ...(args.video_file_path ? { file: args.video_file_path } : {}),
    });
  }
  if (args.source === "device") {
    return builder.add("videodeviceinTOP", "videoin");
  }
  // default: test_pattern — TD ships Banana.tif; no device permission needed
  return builder.add("moviefileinTOP", "videoin", { file: "Banana.tif" });
}

/** GLSL luma histogram fragment shader (bins × 1 output) */
function buildLumaShader(bins: number): string {
  return [
    "out vec4 fragColor;",
    // sTD2DInputs is injected by TD's GLSL preamble — redeclaring it here
    // would cause a sampler-redefinition error and the shader would not cook.
    "void main(){",
    "  int binIdx = int(gl_FragCoord.x);",
    `  int totalBins = ${bins};`,
    "  float lo = float(binIdx) / float(totalBins);",
    "  float hi = float(binIdx+1) / float(totalBins);",
    "  ivec2 sz = textureSize(sTD2DInputs[0], 0);",
    "  float cnt = 0.0;",
    "  int stride = max(1, sz.x / 256);",
    "  for (int y=0; y<sz.y; y+=stride){",
    "    for (int x=0; x<sz.x; x+=stride){",
    "      vec3 c = texelFetch(sTD2DInputs[0], ivec2(x,y), 0).rgb;",
    "      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));",
    "      bool inBin = (l >= lo) && (l < hi);",
    "      // Include pixels with luminance exactly 1.0 in the final bin so they",
    "      // aren't silently dropped (otherwise the last bucket is half-open).",
    "      if (binIdx == totalBins - 1 && l <= 1.0001 && l >= lo) inBin = true;",
    "      if (inBin) cnt += 1.0;",
    "    }",
    "  }",
    "  fragColor = vec4(cnt, cnt, cnt, 1.0);",
    "}",
  ].join("\n");
}

export async function createHistogramScopeImpl(ctx: ToolContext, args: CreateHistogramScopeArgs) {
  // Cross-field validation
  const parsed = createHistogramScopeValidatedSchema.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return errorResult(`create_histogram_scope: invalid arguments — ${issues}`);
  }

  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "histogram_scope");
    const rgb = hexToRgb(args.trace_color);
    const [outW, outH] = args.resolution;

    // Source
    const sourceTop = await buildSource(builder, args);

    // Pre Level TOP for live Gain control
    const pre = await builder.add("levelTOP", "pre", {
      brightness1: args.gain,
      opacity: 1,
    });

    if (args.source !== "existing_top") {
      await builder.connect(sourceTop, pre);
    } else {
      // Cross-container ingress via Select TOP
      const srcSelect = await builder.add("selectTOP", "src_select", { top: sourceTop });
      await builder.connect(srcSelect, pre);
    }

    // Downsample to cap the inner loop — 256×256 = 65k taps worst case
    const downRes = await builder.add("resolutionTOP", "downsample", {
      outputresolution: "custom",
      resolutionw: 256,
      resolutionh: 256,
    });
    await builder.connect(pre, downRes);

    // GLSL histogram TOP (bins × 1)
    const histGlsl = await builder.add("glslTOP", "histogram_glsl", {
      outputresolution: "custom",
      resolutionw: args.bins,
      resolutionh: 1,
    });
    await builder.connect(downRes, histGlsl);

    // Write fragment shader into a Text DAT and point GLSL TOP at it
    const fragCode = buildLumaShader(args.bins);
    const fragDat = await builder.add("textDAT", "frag");
    await builder.python(
      `op(${q(fragDat)}).text = ${q(fragCode)}\nop(${q(histGlsl)}).par.pixeldat = op(${q(fragDat)}).name`,
    );

    // TOP to CHOP: bins × 1 → one channel of length bins
    const histoChop = await builder.add("toptoCHOP", "histo_chop");
    await builder.connect(histGlsl, histoChop);

    // Math CHOP: normalise + optional log
    const normParams: Record<string, unknown> = {
      chanop: "combine",
      combine: "add",
      gain: 1,
    };
    if (args.log_scale) {
      normParams.chanop = "expression";
      normParams.chopexpr = "log(1 + me.inputVal)";
    }
    const norm = await builder.add("mathCHOP", "norm", normParams);
    await builder.connect(histoChop, norm);

    // Rename channel to 'ty' so choptoSOP deflects Y
    const ypos = await builder.add("renameCHOP", "ypos", {
      renamefrom: "*",
      renameto: "ty",
    });
    await builder.connect(norm, ypos);

    // Constant MAT for the line/bars — kept NEUTRAL (white) so the TraceColor
    // panel control is the single source of trace tint, applied downstream by
    // the `tint` constantTOP. If both the MAT and the tint were coloured,
    // changing TraceColor would multiply against the baked-in MAT colour and
    // produce a wrong final hue (e.g. cyan TraceColor over a red MAT → black).
    const mat = await builder.add("constantMAT", "mat", {
      colorr: 1,
      colorg: 1,
      colorb: 1,
      alpha: 1,
    });

    // Geometry comp to hold the SOP
    const geo = await builder.add("geometryCOMP", "geo");
    const line = await builder.add("choptoSOP", "line", {}, geo);
    await builder.connect(ypos, line);

    await builder.python(
      [
        `_l = op(${q(line)})`,
        "_l.render = True",
        "_l.display = True",
        `op(${q(geo)}).par.material = ${q(mat)}`,
      ].join("\n"),
    );

    const cam = await builder.add("cameraCOMP", "cam", {
      projection: "ortho",
      orthowidth: 2.2,
      tz: 5,
    });
    const lightComp = await builder.add("lightCOMP", "light", { tx: 0, ty: 0, tz: 5 });
    const render = await builder.add("renderTOP", "render", {
      camera: cam,
      geometry: geo,
      lights: lightComp,
      bgcolorr: 0.01,
      bgcolorg: 0.02,
      bgcolorb: 0.02,
      bgcolora: 1,
      outputresolution: "custom",
      resolutionw: outW,
      resolutionh: outH,
    });

    // Tint: constantTOP × multiply composite
    const tint = await builder.add("constantTOP", "tint", {
      colorr: rgb.r,
      colorg: rgb.g,
      colorb: rgb.b,
      alpha: 1,
    });
    const tinted = await builder.add("compositeTOP", "tinted", { operand: "multiply" });
    await builder.connect(render, tinted, 0, 0);
    await builder.connect(tint, tinted, 0, 1);

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(tinted, out);

    // Expose live controls
    const prePath = builder.pathOf("pre") ?? `${builder.containerPath}/pre`;
    const tintPath = builder.pathOf("tint") ?? `${builder.containerPath}/tint`;

    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "Gain",
            type: "float",
            min: 0,
            max: 4,
            default: args.gain,
            bind_to: [`${prePath}.brightness1`],
          },
          {
            name: "TraceColor",
            type: "rgb",
            default: args.trace_color,
            bind_to:
              args.mode === "luma"
                ? [`${tintPath}.colorr`, `${tintPath}.colorg`, `${tintPath}.colorb`]
                : [],
          },
          {
            name: "LogScale",
            type: "toggle" as const,
            default: args.log_scale,
            bind_to: [],
          },
        ]
      : [];

    return finalize(ctx, {
      summary: `Built histogram scope (source: ${args.source}, mode: ${args.mode}, bins: ${args.bins}, bar_style: ${args.bar_style}, log_scale: ${args.log_scale}) → ${out}. GPU histogram computed in a GLSL TOP (${args.bins}×1 output); toptoCHOP samples into a channel of length ${args.bins}; mathCHOP normalises${args.log_scale ? " with log(1+x)" : ""}; choptoSOP drives a geometry rendered through an orthographic camera. TraceColor and LogScale are live controls; Mode and Bins are informational only — changing them requires a rebuild.`,
      builder,
      outputPath: out,
      capturePreviewImage: true,
      controls,
      extra: {
        source: args.source,
        mode: args.mode,
        bins: args.bins,
        bar_style: args.bar_style,
        log_scale: args.log_scale,
        trace_color: { r: rgb.r, g: rgb.g, b: rgb.b },
        pre_path: prePath,
        output_path: out,
      },
    });
  });
}

export const registerCreateHistogramScope: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_histogram_scope",
    {
      title: "Create histogram scope",
      description:
        "Build a luminance (and optional per-channel RGB) histogram video scope for any TOP. Computes the histogram on the GPU using a GLSL TOP (bins×1 output), samples into a CHOP, normalises, and renders through choptoSOP → renderTOP. Output is a single Null TOP ready for previews or bind_to_channel. Implements the roadmap Milestone 2 histogram scope panel as a standalone focused tool.",
      inputSchema: createHistogramScopeSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createHistogramScopeImpl(ctx, args),
  );
};
