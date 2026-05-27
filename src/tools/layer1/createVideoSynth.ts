import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, type NetworkBuilder, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

/**
 * Analog video-synthesizer style generators: oscillator / interference looks reminiscent of
 * Lissajous figures, Rutt-Etra fringes and scanline-modulated CRT fields. Deliberately
 * distinct from create_shader_lib (tunnel / raymarch / fractal / metaballs): this set is
 * built from two sine oscillators on X/Y, moving sine interference and scanline modulation —
 * no raymarching, no fractal iteration.
 *
 * Each shader is written for a TouchDesigner GLSL TOP and follows the rules verified in
 * createGenerativeArt.ts / createShaderLib.ts:
 *   - declares its own `out vec4 fragColor` and writes through `TDOutputSwizzle(...)`,
 *   - reads animation time from a `uniform float uTime` (bound to absTime via the Vectors
 *     sequence — there is NO built-in uTime in TD),
 *   - reads `uniform float uFreqX`, `uniform float uFreqY`, `uniform float uScale` and a
 *     `uniform vec3 uColor` (also bound via the sequences),
 *   - uses only lowercase descriptive identifiers (short UPPERCASE names like F1/F2 collide
 *     with macros in TD's auto-prepended GLSL preamble),
 *   - samples nothing external (generative — no input TOP).
 * The fragment-local UV comes from the GLSL TOP built-in `vUV.st` (same idiom the repo's
 * working voronoi/fbm/shader-lib shaders use). Math is kept to sin/cos/length/smoothstep so
 * the compile risk per mode stays low.
 */

// Two sine oscillators trace an X/Y path (classic oscilloscope Lissajous figure). uFreqX /
// uFreqY are the per-axis oscillator frequencies; the glowing curve is drawn by measuring the
// distance from each pixel to the swept point along the time-parameterised path.
const LISSAJOUS_SHADER = `out vec4 fragColor;
uniform float uTime;
uniform float uScale;
uniform float uFreqX;
uniform float uFreqY;
uniform vec3 uColor;
void main(){
  vec2 uv = (vUV.st - 0.5) * 2.0 * max(uScale, 0.0001);
  float glow = 0.0;
  for(int i = 0; i < 96; i++){
    float phase = float(i) / 96.0 * 6.2831853;
    vec2 point = vec2(sin(phase * uFreqX + uTime), sin(phase * uFreqY + uTime * 0.7)) * 0.8;
    float dist = length(uv - point);
    glow += 0.006 / (dist * dist + 0.0008);
  }
  vec3 col = uColor * glow;
  col += uColor * 0.04;
  fragColor = TDOutputSwizzle(vec4(col, 1.0));
}
`;

// Two travelling sine wave fields beat against each other to form moving interference fringes
// (Rutt-Etra / moire flavour). uFreqX / uFreqY set the spatial frequency of each field; the
// product of the two wave trains gives the fringe pattern, animated by uTime.
const INTERFERENCE_SHADER = `out vec4 fragColor;
uniform float uTime;
uniform float uScale;
uniform float uFreqX;
uniform float uFreqY;
uniform vec3 uColor;
void main(){
  vec2 uv = (vUV.st - 0.5) * 2.0;
  float scale = max(uScale, 0.0001);
  float waveA = sin(uv.x * uFreqX * 6.2831853 * scale + uTime);
  float waveB = sin(uv.y * uFreqY * 6.2831853 * scale - uTime * 0.8);
  float radial = sin(length(uv) * (uFreqX + uFreqY) * 3.1415927 * scale - uTime * 1.3);
  float fringe = (waveA * waveB + radial) * 0.5;
  float shade = 0.5 + 0.5 * fringe;
  vec3 col = uColor * shade;
  col += uColor * smoothstep(0.96, 1.0, shade) * 0.4;
  fragColor = TDOutputSwizzle(vec4(col, 1.0));
}
`;

// Horizontal scanlines modulated by a vertical sine oscillator, with a slow rolling sweep —
// an analog CRT / signal-bar look. uFreqY sets the scanline density, uFreqX the horizontal
// modulation, and the bright bar rolls with uTime.
const SCANLINES_SHADER = `out vec4 fragColor;
uniform float uTime;
uniform float uScale;
uniform float uFreqX;
uniform float uFreqY;
uniform vec3 uColor;
void main(){
  vec2 uv = vUV.st;
  float scale = max(uScale, 0.0001);
  float lines = 0.5 + 0.5 * sin(uv.y * uFreqY * 120.0 * scale);
  float modulation = 0.5 + 0.5 * sin(uv.x * uFreqX * 6.2831853 + uTime);
  float roll = fract(uv.y - uTime * 0.1);
  float bar = smoothstep(0.0, 0.15, roll) * smoothstep(0.4, 0.15, roll);
  float shade = lines * modulation + bar * 0.5;
  vec3 col = uColor * shade;
  fragColor = TDOutputSwizzle(vec4(col, 1.0));
}
`;

const SHADERS: Record<string, string> = {
  lissajous: LISSAJOUS_SHADER,
  interference: INTERFERENCE_SHADER,
  scanlines: SCANLINES_SHADER,
};

const MODE_NAMES = ["lissajous", "interference", "scanlines"] as const;

const HEX_COLOR = /^#?([0-9a-fA-F]{6})$/;

const DEFAULT_COLOR: [number, number, number] = [0.2, 0.9, 1.0];

/** Parses "#rrggbb" (or "rrggbb") into 0..1 RGB; undefined for malformed input. */
function parseHexColor(hex: string): [number, number, number] | undefined {
  const match = HEX_COLOR.exec(hex.trim());
  const digits = match?.[1];
  if (!digits) return undefined;
  const int = Number.parseInt(digits, 16);
  return [((int >> 16) & 0xff) / 255, ((int >> 8) & 0xff) / 255, (int & 0xff) / 255];
}

export const createVideoSynthSchema = z.object({
  mode: z
    .enum(MODE_NAMES)
    .default(MODE_NAMES[0])
    .describe(
      "Oscillator look: 'lissajous' (two-oscillator X/Y curve), 'interference' (moving sine fringes), or 'scanlines' (analog CRT scanline modulation).",
    ),
  speed: z.coerce
    .number()
    .default(1)
    .describe("Animation speed multiplier (drives uTime). Exposed as a live 'Speed' control."),
  freq_x: z.coerce
    .number()
    .default(3)
    .describe("X-axis oscillator frequency (uFreqX). Exposed as a live 'FreqX' control."),
  freq_y: z.coerce
    .number()
    .default(2)
    .describe("Y-axis oscillator frequency (uFreqY). Exposed as a live 'FreqY' control."),
  scale: z.coerce
    .number()
    .positive()
    .default(1)
    .describe("Pattern scale/zoom multiplier (uScale). Exposed as a live 'Scale' control."),
  color: z
    .string()
    .optional()
    .describe("Base color as hex (e.g. '#33ccff'); parsed to 0..1 RGB and exposed as 'Color'."),
  resolution: z
    .tuple([z.coerce.number().int().positive(), z.coerce.number().int().positive()])
    .default([1280, 720])
    .describe("Output resolution [width, height] of the GLSL TOP."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe(
      "Expose live Speed / FreqX / FreqY / Scale / Color controls on the system container.",
    ),
  parent_path: z.string().default("/project1"),
});
type CreateVideoSynthArgs = z.infer<typeof createVideoSynthSchema>;

/**
 * Builds the GLSL TOP + Text DAT (fragment via pixeldat) → Null TOP network and binds the
 * uTime / uScale / uFreqX / uFreqY / uColor uniforms through the GLSL TOP's parameter
 * sequences, mirroring createShaderLib.buildShaderNetwork exactly.
 *
 * Binding strategy (matches the verified Speed idiom): every uniform expression reads its
 * matching custom parameter on the parent COMP with a defensive `hasattr` guard, falling back
 * to the build-time constant when no control is present — so the expression never errors
 * whether or not `expose_controls` ran. The Color control is an RGB swatch, which cannot use
 * `bind_to` (createControlPanel ignores it for rgb), so uColor reads the swatch's
 * Colorr/Colorg/Colorb components directly instead.
 */
async function buildSynthNetwork(
  ctx: ToolContext,
  parentPath: string,
  name: string,
  fragment: string,
  speed: number,
  freqX: number,
  freqY: number,
  scale: number,
  color: [number, number, number],
  resolution: [number, number],
): Promise<{ builder: NetworkBuilder; outputPath: string }> {
  const builder = await createSystemContainer(ctx, parentPath, name);
  const glsl = await builder.add("glslTOP", "glsl1", {
    resolutionw: resolution[0],
    resolutionh: resolution[1],
    outputresolution: "custom",
  });
  const frag = await builder.add("textDAT", "glsl1_frag");
  await builder.python(
    `op(${q(frag)}).text = ${q(fragment)}\nop(${q(glsl)}).par.pixeldat = op(${q(frag)}).name`,
  );

  // Uniforms live in the GLSL TOP's parameter sequences; the block count has no structured
  // setter, so raise it via numBlocks, then set each block's name + value expression. The
  // "Vectors" page (vec sequence) carries the float scalars uTime (block 0), uScale (block 1),
  // uFreqX (block 2) and uFreqY (block 3); the "Colors" page (color sequence) carries the
  // vec3 uColor (block 0).
  const speedExpr = `absTime.seconds * (parent().par.Speed.eval() if hasattr(parent().par, 'Speed') else ${speed})`;
  const scaleExpr = `parent().par.Scale.eval() if hasattr(parent().par, 'Scale') else ${scale}`;
  const freqXExpr = `parent().par.Freqx.eval() if hasattr(parent().par, 'Freqx') else ${freqX}`;
  const freqYExpr = `parent().par.Freqy.eval() if hasattr(parent().par, 'Freqy') else ${freqY}`;
  await builder.python(
    [
      `_g = op(${q(glsl)})`,
      `_g.seq.vec.numBlocks = max(_g.seq.vec.numBlocks, 4)`,
      `_g.par.vec0name = 'uTime'`,
      `_g.par.vec0valuex.expr = ${q(speedExpr)}`,
      `_g.par.vec1name = 'uScale'`,
      `_g.par.vec1valuex.expr = ${q(scaleExpr)}`,
      `_g.par.vec2name = 'uFreqX'`,
      `_g.par.vec2valuex.expr = ${q(freqXExpr)}`,
      `_g.par.vec3name = 'uFreqY'`,
      `_g.par.vec3valuex.expr = ${q(freqYExpr)}`,
      `_g.seq.color.numBlocks = max(_g.seq.color.numBlocks, 1)`,
      `_g.par.color0name = 'uColor'`,
      `_g.par.color0rgbr.expr = ${q(`parent().par.Colorr.eval() if hasattr(parent().par, 'Colorr') else ${color[0]}`)}`,
      `_g.par.color0rgbg.expr = ${q(`parent().par.Colorg.eval() if hasattr(parent().par, 'Colorg') else ${color[1]}`)}`,
      `_g.par.color0rgbb.expr = ${q(`parent().par.Colorb.eval() if hasattr(parent().par, 'Colorb') else ${color[2]}`)}`,
    ].join("\n"),
  );

  const out = await builder.add("nullTOP", "out1");
  await builder.connect(glsl, out);
  return { builder, outputPath: out };
}

export async function createVideoSynthImpl(ctx: ToolContext, args: CreateVideoSynthArgs) {
  return runBuild(async () => {
    const fragment = SHADERS[args.mode] ?? LISSAJOUS_SHADER;

    const color = parseHexColor(args.color ?? "") ?? DEFAULT_COLOR;
    const colorWarning =
      args.color !== undefined && parseHexColor(args.color) === undefined
        ? `Could not parse color "${args.color}" (expected hex like '#33ccff'); used the default.`
        : undefined;

    const { builder, outputPath } = await buildSynthNetwork(
      ctx,
      args.parent_path,
      `video_synth_${args.mode}`,
      fragment,
      args.speed,
      args.freq_x,
      args.freq_y,
      args.scale,
      color,
      args.resolution,
    );
    if (colorWarning) builder.warnings.push(colorWarning);

    // Live controls bound to the uniforms. Speed/FreqX/FreqY/Scale drive their uniform
    // expressions via the defensive parent() lookups above (referenced by their sanitized
    // custom-par names Speed/Freqx/Freqy/Scale); Color is an RGB swatch whose components those
    // expressions read directly (bind_to is unsupported for rgb).
    const controls: ControlSpec[] = args.expose_controls
      ? [
          { name: "Speed", type: "float", min: 0, max: 4, default: args.speed },
          { name: "FreqX", type: "float", min: 0, max: 16, default: args.freq_x },
          { name: "FreqY", type: "float", min: 0, max: 16, default: args.freq_y },
          { name: "Scale", type: "float", min: 0.1, max: 4, default: args.scale },
          // Seed the RGB swatch with the build-time colour (a swatch defaults to black, which
          // would make the uColor-driven pattern render black/dark).
          {
            name: "Color",
            type: "rgb",
            default: `#${color
              .map((c) =>
                Math.round(c * 255)
                  .toString(16)
                  .padStart(2, "0"),
              )
              .join("")}`,
          },
        ]
      : [];

    return finalize(ctx, {
      summary: `Created a "${args.mode}" analog video-synth pattern (GLSL).`,
      builder,
      outputPath,
      controls,
      capturePreviewImage: true,
      extra: {
        mode: args.mode,
        speed: args.speed,
        freq_x: args.freq_x,
        freq_y: args.freq_y,
        scale: args.scale,
        color,
        resolution: args.resolution,
      },
    });
  });
}

export const registerCreateVideoSynth: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_video_synth",
    {
      title: "Create video synth",
      description:
        "Instantiate an analog video-synthesizer pattern (lissajous oscillator curve, moving interference fringes, or CRT scanline modulation) into a GLSL TOP with live Speed / FreqX / FreqY / Scale / Color controls. An oscillator/interference generator for VJ work — distinct from create_shader_lib's tunnel/raymarch/fractal/metaball looks.",
      inputSchema: createVideoSynthSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createVideoSynthImpl(ctx, args),
  );
};
