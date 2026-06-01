import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, type NetworkBuilder, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

/**
 * Dither effect fragment shader for TouchDesigner's GLSL TOP.
 *
 * Implements six dither patterns selected by uPattern (float → int):
 *   0 = bayer2  — 2×2 ordered Bayer matrix
 *   1 = bayer4  — 4×4 ordered Bayer matrix
 *   2 = bayer8  — 8×8 ordered Bayer matrix
 *   3 = checker — alternating checker threshold
 *   4 = noise   — pseudo-random hash threshold
 *   5 = error_diffusion — single-pass 3×3 neighbourhood approximation
 *
 * Palette modes (uPaletteMode):
 *   0 = mono    — luminance → two-colour palette (low/high)
 *   1 = duotone — same + subtle hue tint from source
 *   2 = rgb     — per-channel quantisation (ignores low/high)
 *
 * GLSL gotchas:
 *   - Declares `out vec4 fragColor;`, writes via TDOutputSwizzle().
 *   - Input texture is sTD2DInputs[0]; UV is vUV.st.
 *   - No uTime built-in; uTDOutputInfo.res.xy = texel size.
 *   - Uniform floats cast to int inside the shader.
 */
const DITHER_SHADER = `out vec4 fragColor;

uniform float uPattern;      // 0=bayer2 1=bayer4 2=bayer8 3=checker 4=noise 5=error_diffusion
uniform float uBits;         // 1 | 2 | 4  → levels = 2^bits
uniform float uPaletteMode;  // 0=mono 1=duotone 2=rgb
uniform float uThreshold;
uniform float uScale;
uniform float uMix;
uniform vec3  uLow;
uniform vec3  uHigh;

float bayer2(vec2 p) {
    int m[4];
    m[0]=0; m[1]=2; m[2]=3; m[3]=1;
    ivec2 ip = ivec2(mod(p, 2.0));
    return (float(m[ip.y*2 + ip.x]) + 0.5) / 4.0;
}

float bayer4(vec2 p) {
    int b[16];
    b[0]=0;  b[1]=8;  b[2]=2;  b[3]=10;
    b[4]=12; b[5]=4;  b[6]=14; b[7]=6;
    b[8]=3;  b[9]=11; b[10]=1; b[11]=9;
    b[12]=15;b[13]=7; b[14]=13;b[15]=5;
    ivec2 ip = ivec2(mod(p, 4.0));
    int idx = ip.y*4 + ip.x;
    return (float(b[idx]) + 0.5) / 16.0;
}

float bayer8(vec2 p) {
    int b[64];
    b[0]=0;  b[1]=32; b[2]=8;  b[3]=40; b[4]=2;  b[5]=34; b[6]=10; b[7]=42;
    b[8]=48; b[9]=16; b[10]=56;b[11]=24;b[12]=50;b[13]=18;b[14]=58;b[15]=26;
    b[16]=12;b[17]=44;b[18]=4; b[19]=36;b[20]=14;b[21]=46;b[22]=6; b[23]=38;
    b[24]=60;b[25]=28;b[26]=52;b[27]=20;b[28]=62;b[29]=30;b[30]=54;b[31]=22;
    b[32]=3; b[33]=35;b[34]=11;b[35]=43;b[36]=1; b[37]=33;b[38]=9; b[39]=41;
    b[40]=51;b[41]=19;b[42]=59;b[43]=27;b[44]=49;b[45]=17;b[46]=57;b[47]=25;
    b[48]=15;b[49]=47;b[50]=7; b[51]=39;b[52]=13;b[53]=45;b[54]=5; b[55]=37;
    b[56]=63;b[57]=31;b[58]=55;b[59]=23;b[60]=61;b[61]=29;b[62]=53;b[63]=21;
    ivec2 ip = ivec2(mod(p, 8.0));
    int idx = ip.y*8 + ip.x;
    return (float(b[idx]) + 0.5) / 64.0;
}

float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float errorDiff(vec2 uv, vec2 px, float v) {
    float n  = texture(sTD2DInputs[0], uv - vec2(px.x, 0.0)).r;
    float nw = texture(sTD2DInputs[0], uv - px).r;
    float nu = texture(sTD2DInputs[0], uv - vec2(0.0, px.y)).r;
    return 0.5 + 0.5 * (v - (n*0.4375 + nw*0.1875 + nu*0.3125));
}

float pickThreshold(vec2 screenPx, vec2 uv, float v) {
    int p = int(uPattern);
    vec2 sp = floor(screenPx / max(uScale, 1.0));
    if (p == 0) return bayer2(sp);
    if (p == 1) return bayer4(sp);
    if (p == 2) return bayer8(sp);
    if (p == 3) return mod(sp.x + sp.y, 2.0) < 0.5 ? 0.25 : 0.75;
    if (p == 4) return hash(sp);
    return errorDiff(uv, uTDOutputInfo.res.xy, v);
}

void main() {
    vec2 uv = vUV.st;
    vec4 orig = texture(sTD2DInputs[0], uv);
    vec2 screenPx = uv / uTDOutputInfo.res.xy;
    float levels = pow(2.0, uBits);

    vec3 outCol;
    int mode = int(uPaletteMode);

    if (mode == 2) {
        vec3 thr = vec3(
            pickThreshold(screenPx, uv, orig.r),
            pickThreshold(screenPx, uv, orig.g),
            pickThreshold(screenPx, uv, orig.b)
        );
        vec3 biased = orig.rgb + (thr - 0.5) * (1.0 / levels) + (uThreshold - 0.5) * (1.0 / levels);
        outCol = floor(biased * levels) / max(levels - 1.0, 1.0);
    } else {
        float lum = dot(orig.rgb, vec3(0.299, 0.587, 0.114));
        float t = pickThreshold(screenPx, uv, lum);
        float biased = lum + (t - 0.5) * (1.0 / levels) + (uThreshold - 0.5) * (1.0 / levels);
        float q = floor(biased * levels) / max(levels - 1.0, 1.0);
        outCol = mix(uLow, uHigh, clamp(q, 0.0, 1.0));
        if (mode == 1) outCol = mix(outCol, outCol * (0.5 + 0.5 * orig.rgb), 0.35);
    }

    fragColor = TDOutputSwizzle(mix(orig, vec4(outCol, orig.a), uMix));
}
`;

export const createDitherSchema = z.object({
  name: z.string().default("dither").describe("Base name for the created container."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path the dither container is created inside."),
  source: z
    .string()
    .optional()
    .describe(
      "Absolute path of an existing TOP to dither (e.g. '/project1/movie1'). Pulled in via a Select TOP. If omitted, a self-contained animated colour-noise source is used (no device permissions).",
    ),
  pattern: z
    .enum(["bayer2", "bayer4", "bayer8", "checker", "noise", "error_diffusion"])
    .default("bayer4")
    .describe(
      "Threshold pattern. bayer2/4/8: ordered Bayer matrices (2×2/4×4/8×8); checker: alternating grid; noise: pseudo-random hash; error_diffusion: single-pass 3×3 neighbourhood approximation.",
    ),
  bits: z
    .enum(["1", "2", "4"])
    .default("1")
    .transform(Number)
    .describe("Bit depth per channel: 1=2 levels, 2=4 levels, 4=16 levels."),
  palette_mode: z
    .enum(["mono", "duotone", "rgb"])
    .default("duotone")
    .describe(
      "mono: luminance → low/high colour. duotone: same with hue tint. rgb: quantise each channel independently using bits.",
    ),
  low_color: z
    .tuple([z.number(), z.number(), z.number()])
    .default([0.05, 0.06, 0.1])
    .describe("Off/dark palette colour [r,g,b] 0–1. Used in mono and duotone modes."),
  high_color: z
    .tuple([z.number(), z.number(), z.number()])
    .default([0.85, 0.95, 0.8])
    .describe("On/light palette colour [r,g,b] 0–1. Game-Boy-green default."),
  threshold: z
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .describe("Threshold bias applied on top of the pattern."),
  scale: z
    .number()
    .min(1)
    .default(1)
    .describe("Pattern scale in pixels — larger = chunkier dither."),
  mix: z
    .number()
    .min(0)
    .max(1)
    .default(1)
    .describe("Blend between original (0) and dithered output (1). Live-tweakable."),
  resolution: z
    .tuple([z.number(), z.number()])
    .default([1280, 720])
    .describe("Output resolution [width, height] in pixels."),
});
type CreateDitherArgs = z.infer<typeof createDitherSchema>;

const PATTERN_INT: Record<string, number> = {
  bayer2: 0,
  bayer4: 1,
  bayer8: 2,
  checker: 3,
  noise: 4,
  error_diffusion: 5,
};

const PALETTE_INT: Record<string, number> = {
  mono: 0,
  duotone: 1,
  rgb: 2,
};

async function buildSource(builder: NetworkBuilder, args: CreateDitherArgs): Promise<string> {
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

export async function createDitherImpl(ctx: ToolContext, args: CreateDitherArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);

    const source = await buildSource(builder, args);

    const glsl = await builder.add("glslTOP", "dither_glsl", {
      outputresolution: "custom",
      resolutionw: args.resolution[0],
      resolutionh: args.resolution[1],
    });
    const frag = await builder.add("textDAT", "dither_frag");

    await builder.python(
      `op(${q(frag)}).text = ${q(DITHER_SHADER)}\nop(${q(glsl)}).par.pixeldat = op(${q(frag)}).name`,
    );
    await builder.connect(source, glsl);

    const patternInt = PATTERN_INT[args.pattern] ?? 1;
    const paletteInt = PALETTE_INT[args.palette_mode] ?? 1;
    const [lr, lg, lb] = args.low_color;
    const [hr, hg, hb] = args.high_color;

    await builder.python(
      [
        `_g = op(${q(glsl)})`,
        `_g.seq.vec.numBlocks = max(_g.seq.vec.numBlocks, 8)`,
        // vec0: uPattern — build-time constant
        `_g.par.vec0name = 'uPattern'`,
        `_g.par.vec0valuex = ${patternInt}`,
        // vec1: uBits — build-time constant
        `_g.par.vec1name = 'uBits'`,
        `_g.par.vec1valuex = ${args.bits}`,
        // vec2: uPaletteMode — build-time constant
        `_g.par.vec2name = 'uPaletteMode'`,
        `_g.par.vec2valuex = ${paletteInt}`,
        // vec3: uThreshold — live control
        `_g.par.vec3name = 'uThreshold'`,
        `_g.par.vec3valuex.expr = ${q(`(parent().par.Threshold.eval() if hasattr(parent().par, 'Threshold') else ${args.threshold})`)}`,
        `_g.par.vec3valuex.mode = type(_g.par.vec3valuex.mode).EXPRESSION`,
        // vec4: uScale — live control
        `_g.par.vec4name = 'uScale'`,
        `_g.par.vec4valuex.expr = ${q(`(parent().par.Scale.eval() if hasattr(parent().par, 'Scale') else ${args.scale})`)}`,
        `_g.par.vec4valuex.mode = type(_g.par.vec4valuex.mode).EXPRESSION`,
        // vec5: uMix — live control
        `_g.par.vec5name = 'uMix'`,
        `_g.par.vec5valuex.expr = ${q(`(parent().par.Mix.eval() if hasattr(parent().par, 'Mix') else ${args.mix})`)}`,
        `_g.par.vec5valuex.mode = type(_g.par.vec5valuex.mode).EXPRESSION`,
        // vec6: uLow (rgb) — static
        `_g.par.vec6name = 'uLow'`,
        `_g.par.vec6valuex = ${lr}`,
        `_g.par.vec6valuey = ${lg}`,
        `_g.par.vec6valuez = ${lb}`,
        // vec7: uHigh (rgb) — static
        `_g.par.vec7name = 'uHigh'`,
        `_g.par.vec7valuex = ${hr}`,
        `_g.par.vec7valuey = ${hg}`,
        `_g.par.vec7valuez = ${hb}`,
      ].join("\n"),
    );

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(glsl, out);

    const controls: ControlSpec[] = [
      { name: "Mix", type: "float", min: 0, max: 1, default: args.mix, bind_to: [] },
      { name: "Threshold", type: "float", min: 0, max: 1, default: args.threshold, bind_to: [] },
      { name: "Scale", type: "float", min: 1, max: 32, default: args.scale, bind_to: [] },
    ];

    return finalize(ctx, {
      summary: `Created a dither/${args.pattern} system (${args.source ? `source: ${args.source}` : "self-contained noise source"}, bits ${args.bits}, palette ${args.palette_mode}, mix ${args.mix}) → ${out}. GLSL compile UNVERIFIED (TD offline at build time).`,
      builder,
      outputPath: out,
      capturePreviewImage: true,
      controls,
      extra: {
        output_path: out,
        controls: ["Mix", "Threshold", "Scale"],
        pattern: args.pattern,
        bits: args.bits,
        palette_mode: args.palette_mode,
        glsl_compile_verified: false,
      },
    });
  });
}

export const registerCreateDither: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_dither",
    {
      title: "Create dither",
      description:
        "Build a retro dither effect: ordered Bayer (2×2/4×4/8×8), checker, noise, or single-pass error-diffusion — quantising to a 2/4/16-colour palette. Supports mono, duotone (Game-Boy-green default), or RGB quantisation mode. Creates a new baseCOMP under `parent_path` holding the source (or a self-contained noise source), a GLSL TOP with an inline shader, and a Null output. Exposes Mix, Threshold, and Scale knobs for live tweaking. Returns a summary, node paths, exposed controls, and an inline preview image.",
      inputSchema: createDitherSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createDitherImpl(ctx, args),
  );
};
