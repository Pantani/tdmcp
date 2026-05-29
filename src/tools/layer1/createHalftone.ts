import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, type NetworkBuilder, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

/**
 * Halftone / print-look fragment shader for TouchDesigner's GLSL TOP.
 *
 * Implements four print/comic styles selected by the uStyle int uniform:
 *   0 = dots    — monochrome halftone dots on a rotated grid
 *   1 = cmyk    — 4-colour halftone separation (C/M/Y/K channels at staggered angles)
 *   2 = dither  — 4×4 ordered (Bayer) dithering → pixelated retro look
 *   3 = posterize — stepped colour + luminance outline
 *
 * GLSL gotchas observed in this codebase:
 *   - Must declare `out vec4 fragColor;` and write through TDOutputSwizzle().
 *   - Input texture is sTD2DInputs[0]; UV coord is vUV.st.
 *   - There is NO built-in uTime; we bind it ourselves via the vec sequence.
 *   - Avoid preamble macro collisions — use lowercase local variable names only;
 *     never name anything F1, F2, etc. (reserved in TD's GLSL preamble).
 *   - TDTexInfo.res = (1/width, 1/height, width, height); uTDOutputInfo.res.xy is already texel size.
 *   - uStyle must be float (TD vec slot) — cast to int inside the shader.
 */
const HALFTONE_SHADER = `out vec4 fragColor;

uniform float uStyle;
uniform float uDotSize;
uniform float uAngle;
uniform float uMix;

// Rotate a UV coord by angle radians around 0.5
vec2 rotateUV(vec2 uv, float angle) {
    vec2 c = uv - 0.5;
    float co = cos(angle);
    float si = sin(angle);
    return vec2(co * c.x - si * c.y, si * c.x + co * c.y) + 0.5;
}

// Dot-grid halftone: returns 0 (dot) or 1 (paper) for a single channel value
float dotCell(vec2 uv, float val, float cellPx, float angle) {
    // res.xy = (1/width, 1/height) per TDTexInfo layout — already texel size
    vec2 px = uTDOutputInfo.res.xy;
    vec2 uvr = rotateUV(uv, angle);
    vec2 cell = fract(uvr / (cellPx * px)) - 0.5;
    float dist = length(cell);
    // radius proportional to channel luminance; brighter = larger dot
    float radius = sqrt(1.0 - clamp(val, 0.0, 1.0)) * 0.5;
    return step(radius, dist);
}

// 4×4 Bayer ordered dither threshold matrix (normalised 0..1)
float bayer4(vec2 pos) {
    int bayer[16];
    bayer[0]  =  0; bayer[1]  =  8; bayer[2]  =  2; bayer[3]  = 10;
    bayer[4]  = 12; bayer[5]  =  4; bayer[6]  = 14; bayer[7]  =  6;
    bayer[8]  =  3; bayer[9]  = 11; bayer[10] =  1; bayer[11] =  9;
    bayer[12] = 15; bayer[13] =  7; bayer[14] = 13; bayer[15] =  5;
    ivec2 ip = ivec2(mod(pos, 4.0));
    int idx = ip.y * 4 + ip.x;
    return float(bayer[idx]) / 16.0;
}

void main() {
    vec2 uv = vUV.st;
    vec4 orig = texture(sTD2DInputs[0], uv);
    int style = int(uStyle);

    vec4 styled;

    if (style == 0) {
        // ---- DOTS: monochrome halftone ----
        float lum = dot(orig.rgb, vec3(0.299, 0.587, 0.114));
        float angleRad = uAngle * 3.14159265 / 180.0;
        float paper = dotCell(uv, lum, uDotSize, angleRad);
        styled = vec4(vec3(paper), orig.a);

    } else if (style == 1) {
        // ---- CMYK: 4-colour halftone separation ----
        // Convert RGB → CMY; K = min component
        float k = 1.0 - max(max(orig.r, orig.g), orig.b);
        float ck = (1.0 - orig.r - k) / max(1.0 - k, 0.001);
        float mk = (1.0 - orig.g - k) / max(1.0 - k, 0.001);
        float yk = (1.0 - orig.b - k) / max(1.0 - k, 0.001);
        float ar = uAngle * 3.14159265 / 180.0;
        float cDot = dotCell(uv, ck, uDotSize, ar);
        float mDot = dotCell(uv, mk, uDotSize, ar + 0.2618); // +15 deg
        float yDot = dotCell(uv, yk, uDotSize, ar + 0.5236); // +30 deg
        float kDot = dotCell(uv, k,  uDotSize, ar + 0.7854); // +45 deg
        // Composite: subtract each ink from white
        vec3 col = vec3(1.0);
        col -= (1.0 - cDot) * vec3(0.0, 1.0, 1.0);  // cyan ink
        col -= (1.0 - mDot) * vec3(1.0, 0.0, 1.0);  // magenta ink
        col -= (1.0 - yDot) * vec3(1.0, 1.0, 0.0);  // yellow ink
        col -= (1.0 - kDot) * vec3(1.0, 1.0, 1.0);  // black ink
        styled = vec4(clamp(col, 0.0, 1.0), orig.a);

    } else if (style == 2) {
        // ---- DITHER: 4×4 Bayer ordered dither ----
        vec2 px = uTDOutputInfo.res.xy;
        vec2 screenPos = uv / px;
        float thresh = bayer4(screenPos);
        // Quantise each channel against the dither threshold
        float levels = 4.0;
        vec3 quant = floor(orig.rgb * levels) / levels;
        vec3 next  = quant + 1.0 / levels;
        vec3 frac  = orig.rgb * levels - floor(orig.rgb * levels);
        vec3 dith  = mix(quant, next, step(thresh, frac));
        styled = vec4(clamp(dith, 0.0, 1.0), orig.a);

    } else {
        // ---- POSTERIZE: stepped colour + luminance outline ----
        float levels = 6.0;
        vec3 post = floor(orig.rgb * levels) / levels;
        // Edge detect via luminance gradient (centre-difference, 1-pixel step)
        vec2 px = uTDOutputInfo.res.xy;
        float lc = dot(orig.rgb,                                    vec3(0.299, 0.587, 0.114));
        float lr = dot(texture(sTD2DInputs[0], uv + vec2(px.x, 0.0)).rgb, vec3(0.299, 0.587, 0.114));
        float lu = dot(texture(sTD2DInputs[0], uv + vec2(0.0, px.y)).rgb, vec3(0.299, 0.587, 0.114));
        float edge = clamp(abs(lc - lr) + abs(lc - lu), 0.0, 1.0) * 12.0;
        vec3 col = post * (1.0 - clamp(edge, 0.0, 1.0));
        styled = vec4(clamp(col, 0.0, 1.0), orig.a);
    }

    fragColor = TDOutputSwizzle(mix(orig, styled, uMix));
}
`;

export const createHalftoneSchema = z.object({
  name: z.string().default("halftone").describe("Base name for the created container."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path the halftone container is created inside."),
  source: z
    .string()
    .optional()
    .describe(
      "Absolute path of an existing TOP to stylise (e.g. '/project1/render1'). Pulled in via a Select TOP. If omitted, a self-contained animated colour-noise source is used (no device permissions).",
    ),
  style: z
    .enum(["dots", "cmyk", "dither", "posterize"])
    .default("dots")
    .describe(
      "Print look to apply. dots: monochrome halftone dot grid; cmyk: 4-colour print separation with staggered screen angles; dither: 4×4 Bayer ordered dithering; posterize: stepped colour + luminance outline.",
    ),
  dot_size: z.coerce
    .number()
    .min(1)
    .default(6)
    .describe(
      "Halftone cell size in pixels — sets the dot spacing for 'dots' and 'cmyk' styles. Larger = coarser, more visible dots.",
    ),
  angle: z.coerce
    .number()
    .default(15)
    .describe(
      "Screen angle in degrees for the dot grid ('dots'/'cmyk'). Classic print uses 15–45°.",
    ),
  mix: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(1)
    .describe(
      "Blend between the original image (0) and the fully stylised output (1). Exposed as a knob for live tweaking.",
    ),
  resolution: z
    .tuple([z.number(), z.number()])
    .default([1280, 720])
    .describe("Output resolution [width, height] in pixels."),
});
type CreateHalftoneArgs = z.infer<typeof createHalftoneSchema>;

async function buildSource(builder: NetworkBuilder, args: CreateHalftoneArgs): Promise<string> {
  if (args.source) {
    const select = await builder.add("selectTOP", "source");
    await builder.setParams(select, { top: args.source });
    return select;
  }
  // Coloured noise: gives the dot patterns something with hue and structure to work on.
  const src = await builder.add("noiseTOP", "source", { monochrome: 0, period: 3 });
  await builder.python(
    `_p = op(${q(src)}).par.tz\n_PM = type(_p.mode)\n_p.expr = ${q("absTime.seconds * 0.1")}\n_p.mode = _PM.EXPRESSION`,
  );
  return src;
}

// Map style enum → uStyle int for the GLSL uniform
const STYLE_INT: Record<CreateHalftoneArgs["style"], number> = {
  dots: 0,
  cmyk: 1,
  dither: 2,
  posterize: 3,
};

export async function createHalftoneImpl(ctx: ToolContext, args: CreateHalftoneArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);

    const source = await buildSource(builder, args);

    // Create the GLSL TOP and its companion Text DAT holding the shader.
    // This mirrors the exact pattern used in createGlitch and applyPostProcessing.
    const glsl = await builder.add("glslTOP", "halftone_glsl", {
      outputresolution: "custom",
      resolutionw: args.resolution[0],
      resolutionh: args.resolution[1],
    });
    const frag = await builder.add("textDAT", "halftone_frag");

    // Set shader text and wire pixeldat — same two-liner as createGlitch's rgbshift setup.
    await builder.python(
      `op(${q(frag)}).text = ${q(HALFTONE_SHADER)}\nop(${q(glsl)}).par.pixeldat = op(${q(frag)}).name`,
    );
    await builder.connect(source, glsl);

    // Bind uniforms via the GLSL TOP's `vec` sequence (the only way to pass float/int
    // uniforms to a GLSL TOP in TD — same mechanism as createGlitch).
    // Block layout:
    //   vec0: uStyle   (int passed as float x; GLSL reads it as int)
    //   vec1: uDotSize
    //   vec2: uAngle
    //   vec3: uMix     (expression refs parent().par.Mix so the knob drives it live)
    const styleInt = STYLE_INT[args.style];
    await builder.python(
      [
        `_g = op(${q(glsl)})`,
        `_g.seq.vec.numBlocks = max(_g.seq.vec.numBlocks, 4)`,
        // uStyle — static int; no expression needed (style is set at build time)
        `_g.par.vec0name = 'uStyle'`,
        `_g.par.vec0valuex = ${styleInt}`,
        // uDotSize — bind to DotSize custom par (defensive fallback to build-time constant)
        `_g.par.vec1name = 'uDotSize'`,
        `_g.par.vec1valuex.expr = ${q(`(parent().par.Dotsize.eval() if hasattr(parent().par, 'Dotsize') else ${args.dot_size})`)}`,
        `_g.par.vec1valuex.mode = type(_g.par.vec1valuex.mode).EXPRESSION`,
        // uAngle — bind to Angle custom par
        `_g.par.vec2name = 'uAngle'`,
        `_g.par.vec2valuex.expr = ${q(`(parent().par.Angle.eval() if hasattr(parent().par, 'Angle') else ${args.angle})`)}`,
        `_g.par.vec2valuex.mode = type(_g.par.vec2valuex.mode).EXPRESSION`,
        // uMix — bind to Mix custom par (primary live-tweaking target)
        `_g.par.vec3name = 'uMix'`,
        `_g.par.vec3valuex.expr = ${q(`(parent().par.Mix.eval() if hasattr(parent().par, 'Mix') else ${args.mix})`)}`,
        `_g.par.vec3valuex.mode = type(_g.par.vec3valuex.mode).EXPRESSION`,
      ].join("\n"),
    );

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(glsl, out);

    // Controls: DotSize and Angle are relevant only for dot/cmyk styles, but exposing
    // them always keeps the panel consistent (they simply have no effect for dither/posterize).
    const controls: ControlSpec[] = [
      { name: "Mix", type: "float", min: 0, max: 1, default: args.mix, bind_to: [] },
      { name: "DotSize", type: "float", min: 1, max: 32, default: args.dot_size, bind_to: [] },
      { name: "Angle", type: "float", min: 0, max: 360, default: args.angle, bind_to: [] },
    ];

    return finalize(ctx, {
      summary: `Created a halftone/${args.style} print-look system (${args.source ? `source: ${args.source}` : "self-contained noise source"}, dot_size ${args.dot_size}px, angle ${args.angle}°, mix ${args.mix}) → ${out}. GLSL compile UNVERIFIED (TD offline at build time).`,
      builder,
      outputPath: out,
      capturePreviewImage: true,
      controls,
      extra: {
        style: args.style,
        dot_size: args.dot_size,
        angle: args.angle,
        mix: args.mix,
        resolution: args.resolution,
        source: args.source ?? "noise",
        output_path: out,
        glsl_compile_verified: false,
      },
    });
  });
}

export const registerCreateHalftone: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_halftone",
    {
      title: "Create halftone",
      description:
        "Build a print/comic print-look effect: halftone dots, CMYK colour separation, ordered dithering, or posterized stepped colour — classic retro aesthetics in one GLSL pass. Creates a new baseCOMP under `parent_path` holding the source (or a self-contained noise source), a GLSL TOP with an inline shader implementing the chosen style, and a Null output. With `source` it stylises an existing TOP (pulled in via a Select TOP); without it uses a self-contained animated colour-noise source (no device permissions). Exposes Mix (blend original vs stylised), DotSize, and Angle knobs. Returns a summary plus a JSON block with the container path, created node paths, the output path, exposed controls, any node errors, warnings, and an inline preview image.",
      inputSchema: createHalftoneSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createHalftoneImpl(ctx, args),
  );
};
