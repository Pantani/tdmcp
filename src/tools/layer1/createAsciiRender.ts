import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import {
  createSystemContainer,
  finalize,
  type NetworkBuilder,
  runBuild,
} from "../layer2/orchestration.js";
import { errorResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

/**
 * ASCII render fragment shader for TouchDesigner's GLSL TOP.
 *
 * Inputs:
 *   sTD2DInputs[0] = cells (resolutionTOP — one texel per character cell)
 *   sTD2DInputs[1] = atlas (textTOP strip — white glyphs on transparent black)
 *
 * Color modes (uColorMode):
 *   0 = mono          — fixed fg/bg
 *   1 = source-color  — per-cell color tint, fixed bg
 *   2 = two-color     — lerp(bg, fg) by luminance
 *
 * GLSL gotchas:
 *   - Declares `out vec4 fragColor;`, writes via TDOutputSwizzle().
 *   - No built-in uTime.
 *   - uTDOutputInfo.res.zw = output resolution in pixels.
 *   - Two inputs require both wires to be connected before cooking.
 */
const ASCII_SHADER = `out vec4 fragColor;
uniform float uColorMode;
uniform float uCharsetLen;
uniform float uMix;
uniform vec3  uFg;
uniform vec3  uBg;
uniform float uCellSize;

void main() {
    vec2 uv = vUV.st;

    // sTD2DInputs[0] = downsampled cell grid (1 texel per cell).
    vec4 cell = texture(sTD2DInputs[0], uv);
    float lum = dot(cell.rgb, vec3(0.299, 0.587, 0.114));

    // Map luminance -> charset index (clamped, integer).
    float idx = floor(clamp(lum, 0.0, 0.999) * uCharsetLen);

    // Local UV inside the current cell.
    vec2 cellsXY = uTDOutputInfo.res.zw / max(uCellSize, 1.0);
    vec2 localUV = fract(uv * cellsXY);

    // Atlas UV: glyph idx occupies horizontal slot [idx/N, (idx+1)/N].
    vec2 atlasUV = vec2((idx + localUV.x) / uCharsetLen, localUV.y);
    float glyph = texture(sTD2DInputs[1], atlasUV).r;

    // Colour mix.
    vec3 fg, bg;
    int mode = int(uColorMode);
    if (mode == 0) {
        fg = uFg; bg = uBg;
    } else if (mode == 1) {
        fg = cell.rgb; bg = uBg;
    } else {
        fg = mix(uBg, uFg, lum); bg = uBg;
    }
    vec3 styled = mix(bg, fg, glyph);

    fragColor = TDOutputSwizzle(mix(texture(sTD2DInputs[0], uv), vec4(styled, 1.0), uMix));
}
`;

export const createAsciiRenderSchema = z.object({
  name: z.string().default("ascii").describe("Base name for the created container."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path the ASCII render container is created inside."),
  source: z
    .string()
    .optional()
    .describe(
      "Absolute path of an existing TOP to render as ASCII (e.g. '/project1/movie1'). If omitted, a self-contained animated colour-noise source is used (no device permissions).",
    ),
  charset: z
    .string()
    .default("  .:-=+*#%@")
    .describe("Dark→light glyph ramp. Min 2 chars, max 32. Leading spaces add more 'black' room."),
  cell_size: z
    .number()
    .int()
    .min(4)
    .max(64)
    .default(16)
    .describe("Pixel size of each character cell. min 4, max 64."),
  color_mode: z
    .enum(["mono", "source-color", "two-color"])
    .default("source-color")
    .describe(
      "mono: fixed fg on bg; source-color: per-cell average tint; two-color: lerp(bg,fg) by luminance.",
    ),
  fg_color: z
    .tuple([z.number(), z.number(), z.number()])
    .default([0.85, 0.95, 0.8])
    .describe(
      "Foreground glyph colour [r,g,b] 0–1. Phosphor-green default. Used in mono/two-color.",
    ),
  bg_color: z
    .tuple([z.number(), z.number(), z.number()])
    .default([0.02, 0.03, 0.04])
    .describe("Background colour [r,g,b] 0–1. Used in all modes."),
  font: z.string().default("Courier New").describe("Monospace font fed to the atlas textTOP."),
  mix: z
    .number()
    .min(0)
    .max(1)
    .default(1)
    .describe("Blend between original (0) and ASCII output (1). Live-tweakable."),
  resolution: z
    .tuple([z.number(), z.number()])
    .default([1280, 720])
    .describe("Output resolution [width, height] in pixels."),
});

type CreateAsciiRenderArgs = z.infer<typeof createAsciiRenderSchema>;

const COLOR_MODE_INT: Record<string, number> = {
  mono: 0,
  "source-color": 1,
  "two-color": 2,
};

async function buildSource(builder: NetworkBuilder, args: CreateAsciiRenderArgs): Promise<string> {
  if (args.source) {
    const select = await builder.add("selectTOP", "source");
    await builder.setParams(select, { top: args.source });
    return select;
  }
  const src = await builder.add("noiseTOP", "source", { monochrome: 0, period: 3 });
  await builder.python(
    `_p = op(${q(src)}).par.tz\n_PM = type(_p.mode)\n_p.expr = ${q("absTime.seconds * 0.1")}\n_p.mode = _PM.EXPRESSION`,
  );
  return src;
}

export async function createAsciiRenderImpl(ctx: ToolContext, args: CreateAsciiRenderArgs) {
  const charsetLen = args.charset.length;
  if (charsetLen < 2 || charsetLen > 32) {
    return errorResult(`charset must be 2–32 characters (got ${charsetLen})`);
  }

  return runBuild(async () => {
    const [resW, resH] = args.resolution;
    const cellsW = Math.floor(resW / args.cell_size);
    const cellsH = Math.floor(resH / args.cell_size);
    const atlasW = args.cell_size * charsetLen;
    const atlasH = args.cell_size;

    const builder = await createSystemContainer(ctx, args.parent_path, args.name);

    const source = await buildSource(builder, args);

    // Cell-grid downsample
    const cells = await builder.add("resolutionTOP", "cells", {
      outputresolution: "custom",
      resolutionw: cellsW,
      resolutionh: cellsH,
      filter: "box",
    });
    await builder.connect(source, cells);

    // Character atlas
    const atlas = await builder.add("textTOP", "atlas", {
      outputresolution: "custom",
      resolutionw: atlasW,
      resolutionh: atlasH,
    });
    await builder.python(
      [
        `_a = op(${q(atlas)})`,
        `_a.par.text = ${q(args.charset)}`,
        `_a.par.font = ${q(args.font)}`,
        `_a.par.alignx = 'left'`,
        `_a.par.aligny = 'middle'`,
        `try:\n    _a.par.bgcolora = 0\nexcept (AttributeError, Exception):\n    pass`,
        `_a.par.fontcolorr = 1`,
        `_a.par.fontcolorg = 1`,
        `_a.par.fontcolorb = 1`,
      ].join("\n"),
    );

    // GLSL renderer
    const glsl = await builder.add("glslTOP", "ascii_glsl", {
      outputresolution: "custom",
      resolutionw: resW,
      resolutionh: resH,
    });
    const frag = await builder.add("textDAT", "ascii_frag");

    await builder.python(
      `op(${q(frag)}).text = ${q(ASCII_SHADER)}\nop(${q(glsl)}).par.pixeldat = op(${q(frag)}).name`,
    );

    // Wire cells → input 0, atlas → input 1
    await builder.connect(cells, glsl, 0, 0);
    await builder.connect(atlas, glsl, 0, 1);

    const colorModeInt = COLOR_MODE_INT[args.color_mode] ?? 1;
    const [fgr, fgg, fgb] = args.fg_color;
    const [bgr, bgg, bgb] = args.bg_color;

    await builder.python(
      [
        `_g = op(${q(glsl)})`,
        `_g.seq.vec.numBlocks = max(_g.seq.vec.numBlocks, 6)`,
        // vec0: uColorMode — build-time constant
        `_g.par.vec0name = 'uColorMode'`,
        `_g.par.vec0valuex = ${colorModeInt}`,
        // vec1: uCharsetLen — build-time constant
        `_g.par.vec1name = 'uCharsetLen'`,
        `_g.par.vec1valuex = ${charsetLen}`,
        // vec2: uMix — live control
        `_g.par.vec2name = 'uMix'`,
        `_g.par.vec2valuex.expr = ${q(`(parent().par.Mix.eval() if hasattr(parent().par, 'Mix') else ${args.mix})`)}`,
        `_g.par.vec2valuex.mode = type(_g.par.vec2valuex.mode).EXPRESSION`,
        // vec3: uFg (rgb) — static
        `_g.par.vec3name = 'uFg'`,
        `_g.par.vec3valuex = ${fgr}`,
        `_g.par.vec3valuey = ${fgg}`,
        `_g.par.vec3valuez = ${fgb}`,
        // vec4: uBg (rgb) — static
        `_g.par.vec4name = 'uBg'`,
        `_g.par.vec4valuex = ${bgr}`,
        `_g.par.vec4valuey = ${bgg}`,
        `_g.par.vec4valuez = ${bgb}`,
        // vec5: uCellSize — build-time constant
        `_g.par.vec5name = 'uCellSize'`,
        `_g.par.vec5valuex = ${args.cell_size}`,
      ].join("\n"),
    );

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(glsl, out);

    const controls: ControlSpec[] = [
      { name: "Mix", type: "float", min: 0, max: 1, default: args.mix, bind_to: [] },
      {
        name: "CellSize",
        type: "float",
        min: 4,
        max: 64,
        default: args.cell_size,
        bind_to: [],
      },
      { name: "Charset", type: "string", default: args.charset, bind_to: [] },
    ];

    const containerPath = builder.containerPath;

    return finalize(ctx, {
      summary: `Created an ascii_render system (${args.source ? `source: ${args.source}` : "self-contained noise source"}, charset "${args.charset}", cell_size ${args.cell_size}, ${args.color_mode}) → ${out}. GLSL compile UNVERIFIED (TD offline at build time).`,
      builder,
      outputPath: out,
      capturePreviewImage: true,
      controls,
      extra: {
        container_path: containerPath,
        output_top_path: out,
        atlas_top_path: atlas,
        cells_top_path: cells,
        output_path: out,
        charset: args.charset,
        charset_len: charsetLen,
        cell_size: args.cell_size,
        color_mode: args.color_mode,
        resolution: args.resolution,
        source: args.source ?? "noise",
        glsl_compile_verified: false,
      },
    });
  });
}

export const registerCreateAsciiRender: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_ascii_render",
    {
      title: "Create ASCII render",
      description:
        "Turn any TOP into a character-grid ASCII render: quantise input luminance into a (W/cell × H/cell) grid, then look up each glyph from a monospace character atlas. Supports mono, source-color (per-cell tint), and two-color (lerp by luminance) modes. Phosphor-green default for the Severance / CRT terminal look. Creates a resolutionTOP (cells), textTOP (atlas), glslTOP, and nullTOP output inside a new baseCOMP. Exposes Mix, CellSize, and Charset controls.",
      inputSchema: createAsciiRenderSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createAsciiRenderImpl(ctx, args),
  );
};
