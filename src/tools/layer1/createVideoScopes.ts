import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { errorResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, type NetworkBuilder, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

export const createVideoScopesSchema = z.object({
  source: z
    .enum(["existing_top", "test_pattern", "file", "device"])
    .default("test_pattern")
    .describe(
      "Video source. 'test_pattern' = synthetic Banana.tif (no permission needed). 'existing_top' = reuse a TOP you already have (provide existing_top_path). 'file' = a video/image file. 'device' = live camera (videodeviceinTOP) — may hang TD on a macOS permission modal.",
    ),
  existing_top_path: z
    .string()
    .optional()
    .describe("Path of an existing TOP to scope (source='existing_top')."),
  video_file_path: z.string().optional().describe("Video/image file path (source='file')."),
  enable_waveform: z.boolean().default(true).describe("Show the luminance waveform panel."),
  enable_parade: z.boolean().default(true).describe("Show the RGB parade panel."),
  enable_vectorscope: z.boolean().default(true).describe("Show the UV vectorscope panel."),
  enable_histogram: z
    .boolean()
    .default(false)
    .describe(
      "Show the luma histogram panel. Currently unsupported — TD 099 has no histogramCHOP (only histogramPOP). Pass true is accepted but the panel is silently skipped; re-enable once analyzeTOP histogram mode is confirmed.",
    ),
  layout: z
    .enum(["grid_2x2", "row", "column"])
    .default("grid_2x2")
    .describe("How enabled panels arrange in the output composite."),
  panel_resolution: z
    .number()
    .int()
    .positive()
    .default(512)
    .describe("Each scope panel's square side in pixels."),
  output_resolution: z
    .tuple([z.number().int().positive(), z.number().int().positive()])
    .default([1024, 1024])
    .describe("Final composited TOP [width, height]."),
  trace_color: z
    .string()
    .default("#00ff88")
    .describe("Phosphor colour for scope lines as a hex string."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Bind live controls: Gain, TraceColor, panel-enable toggles."),
  gain: z
    .number()
    .positive()
    .default(1.0)
    .describe("Pre-scope luma gain — zooms the trace vertically (Level TOP brightness1)."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path; the scopes container is created as 'video_scopes' inside it."),
});

/** Cross-field validation: source-dependent required fields. */
const refineSource = (val: CreateVideoScopesArgs, ctx: z.RefinementCtx) => {
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

/** Refined schema used for cross-field validation in the impl. */
export const createVideoScopesValidatedSchema = createVideoScopesSchema.superRefine(refineSource);

type CreateVideoScopesArgs = z.infer<typeof createVideoScopesSchema>;

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
async function buildSource(builder: NetworkBuilder, args: CreateVideoScopesArgs): Promise<string> {
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

/** Build a single waveform panel (luma scope line). Returns the Null TOP output path. */
async function buildWaveformPanel(
  builder: NetworkBuilder,
  scopeInput: string,
  panelRes: number,
  rgb: { r: number; g: number; b: number },
): Promise<string> {
  // extract luma
  const lum = await builder.add("monochromeTOP", "wave_lum");
  await builder.connect(scopeInput, lum);

  // average along rows → 1×N column averages; Analyze TOP func="average", axis="x"
  const an = await builder.add("analyzeTOP", "wave_an", { function: "average" });
  await builder.connect(lum, an);

  // sample to CHOP
  const chop = await builder.add("toptoCHOP", "wave_chop");
  await builder.connect(an, chop);

  // rename channel to 'ty' so choptoSOP deflects Y
  const ypos = await builder.add("renameCHOP", "wave_ypos", {
    renamefrom: "*",
    renameto: "ty",
  });
  await builder.connect(chop, ypos);

  // constant white MAT for the line
  const mat = await builder.add("constantMAT", "wave_mat", {
    colorr: 1,
    colorg: 1,
    colorb: 1,
    alpha: 1,
  });

  // geometry comp to hold the SOP line
  const geo = await builder.add("geometryCOMP", "wave_geo");
  const line = await builder.add("choptoSOP", "wave_line", {}, geo);
  await builder.connect(ypos, line);

  await builder.python(
    [
      `_l = op(${q(line)})`,
      "_l.render = True",
      "_l.display = True",
      `op(${q(geo)}).par.material = ${q(mat)}`,
    ].join("\n"),
  );

  const cam = await builder.add("cameraCOMP", "wave_cam", {
    projection: "ortho",
    orthowidth: 2.2,
    tz: 5,
  });
  const lightComp = await builder.add("lightCOMP", "wave_light", { tx: 0, ty: 0, tz: 5 });
  const render = await builder.add("renderTOP", "wave_render", {
    camera: cam,
    geometry: geo,
    lights: lightComp,
    bgcolorr: 0.01,
    bgcolorg: 0.02,
    bgcolorb: 0.02,
    bgcolora: 1,
    outputresolution: "custom",
    resolutionw: panelRes,
    resolutionh: panelRes,
  });

  // tint: constantTOP × multiply composite
  const tintColor = await builder.add("constantTOP", "wave_tint", {
    colorr: rgb.r,
    colorg: rgb.g,
    colorb: rgb.b,
    alpha: 1,
  });
  const tinted = await builder.add("compositeTOP", "wave_tinted", { operand: "multiply" });
  await builder.connect(render, tinted, 0, 0);
  await builder.connect(tintColor, tinted, 0, 1);

  const out = await builder.add("nullTOP", "wave_out");
  await builder.connect(tinted, out);
  return out;
}

/** Build a single RGB parade panel. Returns the Null TOP output path. */
async function buildParadePanel(
  builder: NetworkBuilder,
  scopeInput: string,
  panelRes: number,
): Promise<string> {
  // Three channels — use levelTOP per-channel isolation:
  // set only the target channel's gain to 1, others to 0 via colorr/g/b params.
  // Simpler: use monochromeTOP with monoMethod for each channel.

  const channelSetups: Array<{
    suffix: "r" | "g" | "b";
    colorr: number;
    colorg: number;
    colorb: number;
    matName: string;
    lumName: string;
    anName: string;
    chopName: string;
    yposName: string;
    lineName: string;
  }> = [
    {
      suffix: "r",
      colorr: 1,
      colorg: 0,
      colorb: 0,
      matName: "parade_mat_r",
      lumName: "parade_r",
      anName: "parade_an_r",
      chopName: "parade_chop_r",
      yposName: "parade_ypos_r",
      lineName: "parade_line_r",
    },
    {
      suffix: "g",
      colorr: 0,
      colorg: 1,
      colorb: 0,
      matName: "parade_mat_g",
      lumName: "parade_g",
      anName: "parade_an_g",
      chopName: "parade_chop_g",
      yposName: "parade_ypos_g",
      lineName: "parade_line_g",
    },
    {
      suffix: "b",
      colorr: 0,
      colorg: 0,
      colorb: 1,
      matName: "parade_mat_b",
      lumName: "parade_b",
      anName: "parade_an_b",
      chopName: "parade_chop_b",
      yposName: "parade_ypos_b",
      lineName: "parade_line_b",
    },
  ];

  // Per-channel geometryCOMP — geometryCOMP.par.material applies to the whole
  // geometry, so sharing one geo across R/G/B would let the last channel's
  // material overwrite the others. Each channel gets its own geo + its own
  // renderTOP, and the three channel renders are composited side-by-side.
  const channelGeos: string[] = [];
  const channelRenders: string[] = [];
  const xOffsets = [-0.66, 0, 0.66];

  for (const [idx, ch] of channelSetups.entries()) {
    // isolate one channel via levelTOP (zeroing out the others, then monochrome)
    const lev = await builder.add("levelTOP", ch.lumName, {
      // Map the target channel to luma by multiplying non-target channels to 0.
      // We use the channel-scale approach: set individual channel gains.
      colorrr: ch.suffix === "r" ? 1 : 0,
      colorgg: ch.suffix === "g" ? 1 : 0,
      colorbb: ch.suffix === "b" ? 1 : 0,
    });
    await builder.connect(scopeInput, lev);

    const mono = await builder.add("monochromeTOP", `parade_mono_${ch.suffix}`);
    await builder.connect(lev, mono);

    const an = await builder.add("analyzeTOP", ch.anName, { function: "average" });
    await builder.connect(mono, an);

    const chop = await builder.add("toptoCHOP", ch.chopName);
    await builder.connect(an, chop);

    const ypos = await builder.add("renameCHOP", ch.yposName, {
      renamefrom: "*",
      renameto: "ty",
    });
    await builder.connect(chop, ypos);

    const mat = await builder.add("constantMAT", ch.matName, {
      colorr: ch.colorr,
      colorg: ch.colorg,
      colorb: ch.colorb,
      alpha: 1,
    });

    const geo = await builder.add("geometryCOMP", `parade_geo_${ch.suffix}`);
    channelGeos.push(geo);

    const line = await builder.add("choptoSOP", ch.lineName, {}, geo);
    await builder.connect(ypos, line);

    const xOff = xOffsets[idx] ?? 0;
    await builder.python(
      [
        `_l = op(${q(line)})`,
        "_l.render = True",
        "_l.display = True",
        `op(${q(geo)}).par.material = ${q(mat)}`,
        // offset each channel's geo in X so the three sit side-by-side
        `op(${q(geo)}).par.tx = ${xOff}`,
      ].join("\n"),
    );
  }

  const camera = await builder.add("cameraCOMP", "parade_cam", {
    projection: "ortho",
    orthowidth: 2.2,
    tz: 5,
  });
  const lightComp = await builder.add("lightCOMP", "parade_light", { tx: 0, ty: 0, tz: 5 });

  // Render each channel geo to its own renderTOP, then composite side-by-side
  for (const [idx, ch] of channelSetups.entries()) {
    const geo = channelGeos[idx];
    if (!geo) continue;
    const r = await builder.add("renderTOP", `parade_render_${ch.suffix}`, {
      camera: camera,
      geometry: geo,
      lights: lightComp,
      bgcolorr: 0.01,
      bgcolorg: 0.02,
      bgcolorb: 0.02,
      bgcolora: 1,
      outputresolution: "custom",
      resolutionw: panelRes,
      resolutionh: panelRes,
    });
    channelRenders.push(r);
  }

  // Composite the three channel renders into the parade panel
  const render = await builder.add("compositeTOP", "parade_render", { operand: "add" });
  for (const [i, r] of channelRenders.entries()) {
    await builder.connect(r, render, 0, i);
  }

  const out = await builder.add("nullTOP", "parade_out");
  await builder.connect(render, out);
  return out;
}

/** Build the vectorscope (UV scatter) panel. Returns the Null TOP output path. */
async function buildVectorscopePanel(
  builder: NetworkBuilder,
  scopeInput: string,
  panelRes: number,
): Promise<string> {
  // Downsample first so toptoCHOP stays manageable (128×128 = 16384 points)
  const resized = await builder.add("resolutionTOP", "vec_resize", {
    outputresolution: "custom",
    resolutionw: 128,
    resolutionh: 128,
  });
  await builder.connect(scopeInput, resized);

  // GLSL TOP: extract U and V from RGB via approximate YUV matrix
  // U ≈ -0.147R - 0.289G + 0.436B + 0.5
  // V ≈  0.615R - 0.515G - 0.100B + 0.5
  // Output as vec4(U, V, 0, 1) so toptoCHOP channels r=U, g=V
  const yuv = await builder.add("glslTOP", "vec_yuv", {
    outputresolution: "custom",
    resolutionw: 128,
    resolutionh: 128,
  });
  await builder.connect(resized, yuv);

  // embed the GLSL fragment
  const fragCode = [
    "out vec4 fragColor;",
    "void main(){",
    "  vec4 c = texture(sTD2DInputs[0], vUV.st);",
    "  float u = -0.147*c.r - 0.289*c.g + 0.436*c.b + 0.5;",
    "  float v =  0.615*c.r - 0.515*c.g - 0.100*c.b + 0.5;",
    "  fragColor = vec4(u, v, 0.0, 1.0);",
    "}",
  ].join("\n");

  await builder.python(`op(${q(yuv)}).par.pixeldat = op(${q(yuv)}).name`);
  // Write the fragment code into a Text DAT and point the GLSL TOP at it
  const fragDat = await builder.add("textDAT", "vec_frag");
  await builder.python(
    `op(${q(fragDat)}).text = ${q(fragCode)}\nop(${q(yuv)}).par.pixeldat = op(${q(fragDat)}).name`,
  );

  const chop = await builder.add("toptoCHOP", "vec_chop");
  await builder.connect(yuv, chop);

  // rename channels: r→tx, g→ty so choptoSOP positions points in 2D
  const ren = await builder.add("renameCHOP", "vec_rename", {
    renamefrom: "r g",
    renameto: "tx ty",
  });
  await builder.connect(chop, ren);

  const mat = await builder.add("constantMAT", "vec_mat", {
    colorr: 0,
    colorg: 1,
    colorb: 0.53,
    alpha: 1,
  });

  const geo = await builder.add("geometryCOMP", "vec_geo");
  const pts = await builder.add("choptoSOP", "vec_pts", {}, geo);
  await builder.connect(ren, pts);

  await builder.python(
    [
      `_l = op(${q(pts)})`,
      "_l.render = True",
      "_l.display = True",
      `op(${q(geo)}).par.material = ${q(mat)}`,
    ].join("\n"),
  );

  const cam = await builder.add("cameraCOMP", "vec_cam", {
    projection: "ortho",
    orthowidth: 1.2,
    tz: 5,
  });
  const lightComp = await builder.add("lightCOMP", "vec_light", { tx: 0, ty: 0, tz: 5 });
  const render = await builder.add("renderTOP", "vec_render", {
    camera: cam,
    geometry: geo,
    lights: lightComp,
    bgcolorr: 0.01,
    bgcolorg: 0.02,
    bgcolorb: 0.02,
    bgcolora: 1,
    outputresolution: "custom",
    resolutionw: panelRes,
    resolutionh: panelRes,
  });

  const out = await builder.add("nullTOP", "vec_out");
  await builder.connect(render, out);
  return out;
}

// TODO histogram panel — needs analyzeTOP histogram mode rebuild for TD 099.
// histogramCHOP does not exist in TD 099 (only histogramPOP, a particle operator).
// enable_histogram=true is accepted by the schema but silently skipped at build time.

export async function createVideoScopesImpl(ctx: ToolContext, args: CreateVideoScopesArgs) {
  // Cross-field validation: source-dependent required fields.
  const parsed = createVideoScopesValidatedSchema.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return errorResult(`create_video_scopes: invalid arguments — ${issues}`);
  }
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "video_scopes");
    const rgb = hexToRgb(args.trace_color);

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
      // existing_top: cross-container ingress — Level TOP has no `top` param, so route through
      // a Select TOP whose .par.top points at the external path, then wire into pre.
      const srcSelect = await builder.add("selectTOP", "src_select", { top: sourceTop });
      await builder.connect(srcSelect, pre);
    }

    // Build enabled panels
    const panelPaths: string[] = [];
    const panelNames: string[] = [];

    if (args.enable_waveform) {
      const p = await buildWaveformPanel(builder, pre, args.panel_resolution, rgb);
      panelPaths.push(p);
      panelNames.push("waveform");
    }
    if (args.enable_parade) {
      const p = await buildParadePanel(builder, pre, args.panel_resolution);
      panelPaths.push(p);
      panelNames.push("parade");
    }
    if (args.enable_vectorscope) {
      const p = await buildVectorscopePanel(builder, pre, args.panel_resolution);
      panelPaths.push(p);
      panelNames.push("vectorscope");
    }
    // enable_histogram: histogramCHOP absent in TD 099 — panel silently skipped.
    // TODO: rebuild once analyzeTOP histogram mode is confirmed (see comment above).

    // Composite layout — honour requested output_resolution at the composite stage.
    const [outW, outH] = args.output_resolution;
    let layoutTop: string;
    if (panelPaths.length === 0) {
      // No panels — just a black constant at the requested resolution
      layoutTop = await builder.add("constantTOP", "panels", {
        colorr: 0,
        colorg: 0,
        colorb: 0,
        alpha: 1,
        outputresolution: "custom",
        resolutionw: outW,
        resolutionh: outH,
      });
    } else if (panelPaths.length === 1) {
      // Single panel — wrap in a resolutionTOP so the output honours the requested size.
      const resize = await builder.add("resolutionTOP", "panels", {
        outputresolution: "custom",
        resolutionw: outW,
        resolutionh: outH,
      });
      await builder.connect(panelPaths[0] as string, resize);
      layoutTop = resize;
    } else {
      const alignParam =
        args.layout === "row" ? "horizontal" : args.layout === "column" ? "vertical" : "grid";
      const cols = args.layout === "grid_2x2" ? 2 : args.layout === "row" ? panelPaths.length : 1;
      layoutTop = await builder.add("layoutTOP", "panels", {
        align: alignParam,
        columns: cols,
        outputresolution: "custom",
        resolutionw: outW,
        resolutionh: outH,
      });
      for (const [i, p] of panelPaths.entries()) {
        await builder.connect(p, layoutTop, 0, i);
      }
    }

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(layoutTop, out);

    // Expose live controls
    const tintColorPaths: string[] = [];
    // Collect tint node paths for waveform panel only (histogram panel dropped in TD 099)
    const waveTint = builder.pathOf("wave_tint");
    if (waveTint) tintColorPaths.push(waveTint);

    const prePath = builder.pathOf("pre") ?? `${builder.containerPath}/pre`;

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
            bind_to: [
              ...tintColorPaths.map((p) => `${p}.colorr`),
              ...tintColorPaths.map((p) => `${p}.colorg`),
              ...tintColorPaths.map((p) => `${p}.colorb`),
            ],
          },
          {
            name: "ShowWaveform",
            type: "toggle" as const,
            default: args.enable_waveform,
            bind_to: [],
          },
          {
            name: "ShowParade",
            type: "toggle" as const,
            default: args.enable_parade,
            bind_to: [],
          },
          {
            name: "ShowVectorscope",
            type: "toggle" as const,
            default: args.enable_vectorscope,
            bind_to: [],
          },
        ]
      : [];

    return finalize(ctx, {
      summary: `Built video scopes monitor (source: ${args.source}, panels: ${panelNames.join(", ") || "none"}, layout: ${args.layout}) → ${out}. Each enabled panel (waveform, parade, vectorscope) runs through a Level TOP gain stage, per-panel analysis chain (monochromeTOP → analyzeTOP → toptoCHOP → renameCHOP → choptoSOP → renderTOP), and a layoutTOP composites them. ShowWaveform/Parade/Vectorscope toggles are informational only — panel enable/disable requires a rebuild. Histogram panel is unsupported in TD 099 (no histogramCHOP).`,
      builder,
      outputPath: out,
      capturePreviewImage: true,
      controls,
      extra: {
        source: args.source,
        panels: panelNames,
        layout: args.layout,
        panel_resolution: args.panel_resolution,
        trace_color: { r: rgb.r, g: rgb.g, b: rgb.b },
        pre_path: prePath,
        output_path: out,
      },
    });
  });
}

export const registerCreateVideoScopes: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_video_scopes",
    {
      title: "Create video scopes monitor",
      description:
        "Build a broadcast-style video engineering monitor with up to four scope panels: waveform (luma trace), RGB parade (per-channel traces), vectorscope (UV chrominance scatter), and histogram (luma distribution). Each panel renders as a CHOP-to-SOP scope line through an orthographic camera and Render TOP, composited into a single output TOP via layoutTOP. Companion to create_waveform (audio) and create_spectrum (audio frequency). Default source is a synthetic test pattern (no device permission needed); 'device' is opt-in for live camera.",
      inputSchema: createVideoScopesSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createVideoScopesImpl(ctx, args),
  );
};
