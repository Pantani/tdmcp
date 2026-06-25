import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import {
  createSystemContainer,
  finalize,
  type NetworkBuilder,
  runBuild,
} from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { parseHexColor, rgbToHex } from "../util/color.js";

const q = (value: string): string => JSON.stringify(value);

/**
 * Jump Flooding Algorithm (JFA) Voronoi generator — a stained-glass / cell-pattern visual built
 * entirely from GLSL TOPs. A small RGBA32F seed texture (Nseeds×1) carries each seed's UV in
 * the RG channels and its packed index in the BA channels (BA = idx/N). A jfa_init pass seeds
 * the full-resolution texture; K = ceil(log2(max(w,h))) ping-pong GLSL passes propagate the
 * nearest seed by halving pixel steps; a final color_pass turns nearest-seed UV → cell colour
 * and draws thin borders by comparing neighbour seed UVs. All shaders follow the verified TD
 * GLSL TOP conventions (declare `out vec4 fragColor;`, write through `TDOutputSwizzle`, read
 * `vUV.st`, no built-in `uTime`).
 */

const PALETTE_MODES = ["random", "from_image", "duotone"] as const;
type PaletteMode = (typeof PALETTE_MODES)[number];
const PALETTE_MODE_CODE: Record<PaletteMode, number> = { random: 0, from_image: 1, duotone: 2 };

/** Next power-of-two ≥ n (and ≥ 4), bounded so the seed TOP width stays sane. */
function nextPow2(n: number): number {
  let p = 4;
  while (p < n) p <<= 1;
  return p;
}

// --- Shaders -----------------------------------------------------------------------------------

// `seeds_uv` (RGBA32F, NseedsW × 1): RG = seed UV, BA = (idx/N, 1). Drifts with uTime + jitter.
const SEEDS_UV_SHADER = `out vec4 fragColor;
uniform float uTime;
uniform float uJitter;
uniform float uSeedCount;
float hash11(float n){ return fract(sin(n*43758.5453)*1e4); }
vec2  hash21(float n){ return vec2(hash11(n), hash11(n+17.13)); }
void main(){
  float idx = floor(vUV.s * uSeedCount);
  if(idx >= uSeedCount){ fragColor = TDOutputSwizzle(vec4(-1.0, -1.0, 0.0, 0.0)); return; }
  vec2 anchor = hash21(idx + 1.0);
  vec2 drift  = vec2(sin(uTime + idx*1.7), cos(uTime*0.83 + idx*2.3)) * 0.5 + 0.5;
  vec2 seedUV = mix(anchor, drift, clamp(uJitter, 0.0, 1.0));
  float idxNorm = (idx + 0.5) / max(uSeedCount, 1.0);
  fragColor = TDOutputSwizzle(vec4(seedUV, idxNorm, 1.0));
}
`;

// `seeds_col` (RGBA32F, NseedsW × 1): per-seed colour. random = HSV cycle; duotone = mix(A,B);
// from_image = transparent (color_pass samples the palette image at seed UV instead).
const SEEDS_COL_SHADER = `out vec4 fragColor;
uniform float uSeedCount;
uniform int   uPaletteMode;
uniform vec3  uColorA;
uniform vec3  uColorB;
float hash11(float n){ return fract(sin(n*43758.5453)*1e4); }
vec3 hsv2rgb(vec3 c){
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0/3.0, 1.0/3.0))*6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p-1.0, 0.0, 1.0), c.y);
}
void main(){
  float idx = floor(vUV.s * uSeedCount);
  vec3 col;
  if(uPaletteMode == 2)      col = mix(uColorA, uColorB, hash11(idx + 0.5));
  else if(uPaletteMode == 1) col = vec3(0.0);
  else                       col = hsv2rgb(vec3(hash11(idx + 3.0), 0.7, 1.0));
  fragColor = TDOutputSwizzle(vec4(col, 1.0));
}
`;

// `jfa_init`: for each output pixel, scan all seeds; if any seed UV maps to this pixel, write
// (seedUV, idxNorm, 1); otherwise write the sentinel (-1, -1, 0, 0).
const JFA_INIT_SHADER = `out vec4 fragColor;
uniform float uSeedCount;
void main(){
  vec2 px = vUV.st;
  vec2 res = uTDOutputInfo.res.zw;
  vec2 bestUV = vec2(-1.0);
  float bestIdx = 0.0;
  float found = 0.0;
  for(int i = 0; i < 512; i++){
    if(float(i) >= uSeedCount) break;
    vec4 s = texelFetch(sTD2DInputs[0], ivec2(i, 0), 0);
    if(s.x < 0.0) continue;
    vec2 cell = abs(s.xy - px) * res;
    if(cell.x < 0.5 && cell.y < 0.5){ bestUV = s.xy; bestIdx = s.z; found = 1.0; break; }
  }
  fragColor = TDOutputSwizzle(vec4(bestUV, bestIdx, found));
}
`;

// One pass of JFA: sample the prior pass at 9 offsets (current ± uStep / res); keep the seed
// with the smallest distance to this fragment's UV. Carries the seed index in B.
const JFA_STEP_SHADER = `out vec4 fragColor;
uniform float uStep;
void main(){
  vec2 px = vUV.st;
  vec2 res = uTDOutputInfo.res.zw;
  vec2 bestUV = vec2(-1.0);
  float bestIdx = 0.0;
  float bestDist = 1e9;
  for(int dy = -1; dy <= 1; dy++){
    for(int dx = -1; dx <= 1; dx++){
      vec2 sUV = px + vec2(dx, dy) * (uStep / res);
      vec4 s = texture(sTD2DInputs[0], sUV);
      if(s.x < 0.0) continue;
      float d = distance(s.xy, px);
      if(d < bestDist){ bestDist = d; bestUV = s.xy; bestIdx = s.z; }
    }
  }
  fragColor = TDOutputSwizzle(vec4(bestUV, bestIdx, 1.0));
}
`;

// Final colour: nearest-seed UV → cell colour (seeds_col sampled by seed index), edges from
// comparing the seed UV against four neighbour seed UVs. from_image mode samples the palette
// image at the seed UV instead of the per-seed colour swatch.
const COLOR_SHADER = `out vec4 fragColor;
uniform float uSeedCount;
uniform float uEdgeThickness;
uniform vec3  uEdgeColor;
uniform int   uPaletteMode;
void main(){
  vec2 px = vUV.st;
  vec4 here = texture(sTD2DInputs[0], px);
  vec2 seed = here.xy;
  float idx = here.z;
  float e = max(uEdgeThickness, 0.0);
  vec2 sN = texture(sTD2DInputs[0], px + vec2(0.0,  e)).xy;
  vec2 sS = texture(sTD2DInputs[0], px + vec2(0.0, -e)).xy;
  vec2 sE = texture(sTD2DInputs[0], px + vec2( e, 0.0)).xy;
  vec2 sW = texture(sTD2DInputs[0], px + vec2(-e, 0.0)).xy;
  float diff = distance(seed, sN) + distance(seed, sS) + distance(seed, sE) + distance(seed, sW);
  float isEdge = step(0.0005, diff);
  vec3 cellCol;
  if(uPaletteMode == 1){
    cellCol = texture(sTD2DInputs[2], seed).rgb;
  } else {
    cellCol = texture(sTD2DInputs[1], vec2(idx, 0.5)).rgb;
  }
  vec3 col = mix(cellCol, uEdgeColor, isEdge);
  fragColor = TDOutputSwizzle(vec4(col, 1.0));
}
`;

// --- Schema ------------------------------------------------------------------------------------

export const createJfaVoronoiSchema = z.object({
  seed_count: z.coerce
    .number()
    .int()
    .min(4)
    .max(512)
    .default(48)
    .describe("Number of Voronoi seeds (4..512). Drives the seed TOP width (next pow-2)."),
  speed: z.coerce
    .number()
    .default(0.25)
    .describe("Animation speed multiplier driving uTime drift of seeds. Live 'Speed' control."),
  palette_mode: z
    .enum(PALETTE_MODES)
    .default("random")
    .describe("random = HSV per seed; duotone = mix(ColorA, ColorB); from_image = sample image."),
  palette_image: z
    .string()
    .default("")
    .describe("Op path to a TOP sampled at seed UVs when palette_mode='from_image'."),
  edge_thickness: z.coerce
    .number()
    .min(0)
    .max(0.05)
    .default(0.004)
    .describe("Cell border width in UV units (0..0.05). Live 'EdgeThickness' control."),
  edge_color: z
    .string()
    .default("#000000")
    .describe("Border colour as hex (e.g. '#000000'). Live 'EdgeColor' RGB swatch."),
  jitter: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.6)
    .describe("Per-seed drift amplitude (0 = static lattice). Live 'Jitter' control."),
  color_a: z.string().default("#ff3366").describe("Duotone primary hex. Live 'ColorA' swatch."),
  color_b: z.string().default("#33ccff").describe("Duotone secondary hex. Live 'ColorB' swatch."),
  resolution: z
    .tuple([z.coerce.number().int().positive(), z.coerce.number().int().positive()])
    .default([1280, 720])
    .describe("Output resolution [width, height]; JFA pass count auto-derived from max axis."),
  step_count: z.coerce
    .number()
    .int()
    .min(0)
    .max(14)
    .default(0)
    .describe("Manual JFA pass count (0 = auto = ceil(log2(max(w,h))))."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe(
      "Expose live PaletteMode/SeedCount/Speed/Jitter/EdgeThickness/EdgeColor/ColorA/ColorB.",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path; container 'jfa_voronoi' is created inside."),
});
type CreateJfaVoronoiArgs = z.infer<typeof createJfaVoronoiSchema>;

// --- Builder -----------------------------------------------------------------------------------

interface BuildResult {
  builder: NetworkBuilder;
  outputPath: string;
  passes: number;
  seedWidth: number;
}

async function buildJfaNetwork(
  ctx: ToolContext,
  args: CreateJfaVoronoiArgs,
  colorA: [number, number, number],
  colorB: [number, number, number],
  edgeColor: [number, number, number],
): Promise<BuildResult> {
  const [width, height] = args.resolution;
  const passes =
    args.step_count > 0 ? args.step_count : Math.ceil(Math.log2(Math.max(width, height)));
  const seedWidth = Math.min(512, nextPow2(args.seed_count));
  const paletteCode = PALETTE_MODE_CODE[args.palette_mode];

  const builder = await createSystemContainer(ctx, args.parent_path, "jfa_voronoi");

  // Defensive uniform expressions: each reads the parent COMP's custom par if present, else
  // falls back to the build-time constant (so the network cooks even without expose_controls).
  const speedExpr = `absTime.seconds * (parent().par.Speed.eval() if hasattr(parent().par, 'Speed') else ${args.speed})`;
  const seedCountExpr = `parent().par.Seedcount.eval() if hasattr(parent().par, 'Seedcount') else ${args.seed_count}`;
  const jitterExpr = `parent().par.Jitter.eval() if hasattr(parent().par, 'Jitter') else ${args.jitter}`;
  const edgeExpr = `parent().par.Edgethickness.eval() if hasattr(parent().par, 'Edgethickness') else ${args.edge_thickness}`;
  const paletteExpr = `parent().par.Palettemode.menuIndex if hasattr(parent().par, 'Palettemode') else ${paletteCode}`;
  const compExpr = (control: string, fallback: number): string =>
    `parent().par.${control}.eval() if hasattr(parent().par, '${control}') else ${fallback}`;

  // --- seeds_uv (Nseeds × 1, RGBA32F)
  const seedsUv = await builder.add("glslTOP", "seeds_uv", {
    resolutionw: seedWidth,
    resolutionh: 1,
    outputresolution: "custom",
    format: "rgba32float",
  });
  const seedsUvFrag = await builder.add("textDAT", "seeds_uv_frag");
  await builder.python(
    [
      `op(${q(seedsUvFrag)}).text = ${q(SEEDS_UV_SHADER)}`,
      `op(${q(seedsUv)}).par.pixeldat = op(${q(seedsUvFrag)}).name`,
      `_g = op(${q(seedsUv)})`,
      `_g.seq.vec.numBlocks = max(_g.seq.vec.numBlocks, 3)`,
      `_g.par.vec0name = 'uTime'`,
      `_g.par.vec0valuex.expr = ${q(speedExpr)}`,
      `_g.par.vec1name = 'uJitter'`,
      `_g.par.vec1valuex.expr = ${q(jitterExpr)}`,
      `_g.par.vec2name = 'uSeedCount'`,
      `_g.par.vec2valuex.expr = ${q(seedCountExpr)}`,
    ].join("\n"),
  );

  // --- seeds_col (Nseeds × 1, RGBA32F)
  const seedsCol = await builder.add("glslTOP", "seeds_col", {
    resolutionw: seedWidth,
    resolutionh: 1,
    outputresolution: "custom",
    format: "rgba32float",
  });
  const seedsColFrag = await builder.add("textDAT", "seeds_col_frag");
  await builder.python(
    [
      `op(${q(seedsColFrag)}).text = ${q(SEEDS_COL_SHADER)}`,
      `op(${q(seedsCol)}).par.pixeldat = op(${q(seedsColFrag)}).name`,
      `_g = op(${q(seedsCol)})`,
      `_g.seq.vec.numBlocks = max(_g.seq.vec.numBlocks, 2)`,
      `_g.par.vec0name = 'uSeedCount'`,
      `_g.par.vec0valuex.expr = ${q(seedCountExpr)}`,
      `_g.par.vec1name = 'uPaletteMode'`,
      `_g.par.vec1valuex.expr = ${q(paletteExpr)}`,
      `_g.seq.color.numBlocks = max(_g.seq.color.numBlocks, 2)`,
      `_g.par.color0name = 'uColorA'`,
      `_g.par.color0rgbr.expr = ${q(compExpr("Colorar", colorA[0]))}`,
      `_g.par.color0rgbg.expr = ${q(compExpr("Colorag", colorA[1]))}`,
      `_g.par.color0rgbb.expr = ${q(compExpr("Colorab", colorA[2]))}`,
      `_g.par.color1name = 'uColorB'`,
      `_g.par.color1rgbr.expr = ${q(compExpr("Colorbr", colorB[0]))}`,
      `_g.par.color1rgbg.expr = ${q(compExpr("Colorbg", colorB[1]))}`,
      `_g.par.color1rgbb.expr = ${q(compExpr("Colorbb", colorB[2]))}`,
    ].join("\n"),
  );

  // --- jfa_init (full-res, RGBA32F) reads seeds_uv as sTD2DInputs[0].
  const jfaInit = await builder.add("glslTOP", "jfa_init", {
    resolutionw: width,
    resolutionh: height,
    outputresolution: "custom",
    format: "rgba32float",
  });
  const jfaInitFrag = await builder.add("textDAT", "jfa_init_frag");
  await builder.python(
    [
      `op(${q(jfaInitFrag)}).text = ${q(JFA_INIT_SHADER)}`,
      `op(${q(jfaInit)}).par.pixeldat = op(${q(jfaInitFrag)}).name`,
      `_g = op(${q(jfaInit)})`,
      `_g.seq.vec.numBlocks = max(_g.seq.vec.numBlocks, 1)`,
      `_g.par.vec0name = 'uSeedCount'`,
      `_g.par.vec0valuex.expr = ${q(seedCountExpr)}`,
    ].join("\n"),
  );
  await builder.connect(seedsUv, jfaInit);

  // --- jfa_pass_0..K-1 share one Text DAT; each pass overrides uStep.
  const jfaStepFrag = await builder.add("textDAT", "jfa_step_frag");
  await builder.python(`op(${q(jfaStepFrag)}).text = ${q(JFA_STEP_SHADER)}`);

  let prev = jfaInit;
  for (let i = 0; i < passes; i++) {
    const step = Math.max(1, 2 ** (passes - 1 - i));
    const passPath = await builder.add("glslTOP", `jfa_pass_${i}`, {
      resolutionw: width,
      resolutionh: height,
      outputresolution: "custom",
      format: "rgba32float",
    });
    await builder.python(
      [
        `_g = op(${q(passPath)})`,
        `_g.par.pixeldat = op(${q(jfaStepFrag)}).name`,
        `_g.seq.vec.numBlocks = max(_g.seq.vec.numBlocks, 1)`,
        `_g.par.vec0name = 'uStep'`,
        `_g.par.vec0valuex.expr = ${q(String(step))}`,
      ].join("\n"),
    );
    await builder.connect(prev, passPath);
    prev = passPath;
  }

  // --- color_pass: nearest-seed UV → cell colour + borders.
  const colorPass = await builder.add("glslTOP", "color_pass", {
    resolutionw: width,
    resolutionh: height,
    outputresolution: "custom",
  });
  const colorFrag = await builder.add("textDAT", "color_pass_frag");
  await builder.python(
    [
      `op(${q(colorFrag)}).text = ${q(COLOR_SHADER)}`,
      `op(${q(colorPass)}).par.pixeldat = op(${q(colorFrag)}).name`,
      `_g = op(${q(colorPass)})`,
      `_g.seq.vec.numBlocks = max(_g.seq.vec.numBlocks, 3)`,
      `_g.par.vec0name = 'uSeedCount'`,
      `_g.par.vec0valuex.expr = ${q(seedCountExpr)}`,
      `_g.par.vec1name = 'uEdgeThickness'`,
      `_g.par.vec1valuex.expr = ${q(edgeExpr)}`,
      `_g.par.vec2name = 'uPaletteMode'`,
      `_g.par.vec2valuex.expr = ${q(paletteExpr)}`,
      `_g.seq.color.numBlocks = max(_g.seq.color.numBlocks, 1)`,
      `_g.par.color0name = 'uEdgeColor'`,
      `_g.par.color0rgbr.expr = ${q(compExpr("Edgecolorr", edgeColor[0]))}`,
      `_g.par.color0rgbg.expr = ${q(compExpr("Edgecolorg", edgeColor[1]))}`,
      `_g.par.color0rgbb.expr = ${q(compExpr("Edgecolorb", edgeColor[2]))}`,
    ].join("\n"),
  );
  await builder.connect(prev, colorPass, 0, 0);
  await builder.connect(seedsCol, colorPass, 0, 1);
  // Input 2 (palette image) must ALWAYS be wired so sTD2DInputs[2] is valid in GLSL — the
  // shader gates on uPaletteMode and only samples it in from_image mode. When the user
  // supplies a palette image we bridge it via a Select TOP (no cross-container wires); in
  // every other case we wire a benign stub (seeds_col) so the shader still compiles.
  if (args.palette_mode === "from_image" && args.palette_image.trim().length > 0) {
    const sel = await builder.add("selectTOP", "palette_src");
    await builder.setParams(sel, { top: args.palette_image.trim() });
    await builder.connect(sel, colorPass, 0, 2);
  } else {
    await builder.connect(seedsCol, colorPass, 0, 2);
  }

  const out = await builder.add("nullTOP", "out1");
  await builder.connect(colorPass, out);

  return { builder, outputPath: out, passes, seedWidth };
}

// --- Impl + registrar --------------------------------------------------------------------------

export async function createJfaVoronoiImpl(ctx: ToolContext, args: CreateJfaVoronoiArgs) {
  return runBuild(async () => {
    const defaultA: [number, number, number] = [1.0, 0.2, 0.4];
    const defaultB: [number, number, number] = [0.2, 0.8, 1.0];
    const defaultEdge: [number, number, number] = [0, 0, 0];

    const parsedA = parseHexColor(args.color_a);
    const parsedB = parseHexColor(args.color_b);
    const parsedEdge = parseHexColor(args.edge_color);
    const colorA = parsedA ?? defaultA;
    const colorB = parsedB ?? defaultB;
    const edgeColor = parsedEdge ?? defaultEdge;

    const colorWarnings: string[] = [];
    if (parsedA === undefined)
      colorWarnings.push(
        `Could not parse color_a "${args.color_a}" (expected hex like '#ff3366'); used the default.`,
      );
    if (parsedB === undefined)
      colorWarnings.push(
        `Could not parse color_b "${args.color_b}" (expected hex like '#33ccff'); used the default.`,
      );
    if (parsedEdge === undefined)
      colorWarnings.push(
        `Could not parse edge_color "${args.edge_color}" (expected hex like '#000000'); used the default.`,
      );

    const { builder, outputPath, passes, seedWidth } = await buildJfaNetwork(
      ctx,
      args,
      colorA,
      colorB,
      edgeColor,
    );
    builder.warnings.push(...colorWarnings);

    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "PaletteMode",
            type: "menu",
            default: args.palette_mode,
            menu_items: [...PALETTE_MODES],
          },
          {
            name: "SeedCount",
            type: "int",
            min: 4,
            max: seedWidth,
            default: args.seed_count,
          },
          { name: "Speed", type: "float", min: 0, max: 4, default: args.speed },
          { name: "Jitter", type: "float", min: 0, max: 1, default: args.jitter },
          {
            name: "EdgeThickness",
            type: "float",
            min: 0,
            max: 0.05,
            default: args.edge_thickness,
          },
          { name: "EdgeColor", type: "rgb", default: rgbToHex(edgeColor) },
          { name: "ColorA", type: "rgb", default: rgbToHex(colorA) },
          { name: "ColorB", type: "rgb", default: rgbToHex(colorB) },
        ]
      : [];

    return finalize(ctx, {
      summary: `Created a JFA Voronoi system (${passes} passes, ${args.seed_count} seeds, ${args.palette_mode}).`,
      builder,
      outputPath,
      controls,
      capturePreviewImage: true,
      extra: {
        seed_count: args.seed_count,
        seed_width: seedWidth,
        palette_mode: args.palette_mode,
        jfa_passes: passes,
        scene_resolution: args.resolution,
        edge_thickness: args.edge_thickness,
        speed: args.speed,
        jitter: args.jitter,
        color_a: colorA,
        color_b: colorB,
        edge_color: edgeColor,
      },
    });
  });
}

export const registerCreateJfaVoronoi: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_jfa_voronoi",
    {
      title: "Create JFA Voronoi",
      description:
        "Instantiate a self-contained Jump-Flooding-Algorithm Voronoi generator (stained-glass / cell pattern) as GLSL TOPs — seeds → jfa_init → K halving passes → color_pass → null. Exposes live PaletteMode / SeedCount / Speed / Jitter / EdgeThickness / EdgeColor / ColorA / ColorB controls and previews the output TOP. Pass count auto-derives from resolution (log2(max(w,h))); override with step_count.",
      inputSchema: createJfaVoronoiSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createJfaVoronoiImpl(ctx, args),
  );
};
