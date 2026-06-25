import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import {
  createSystemContainer,
  finalize,
  type NetworkBuilder,
  runBuild,
} from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { parseHexColor } from "../util/color.js";

const q = (value: string): string => JSON.stringify(value);

/**
 * Curated, self-contained full-screen GLSL shaders for instant VJ eye-candy. Each one is
 * written for a TouchDesigner GLSL TOP and follows the rules verified in
 * createGenerativeArt.ts / applyPostProcessing.ts:
 *   - declares its own `out vec4 fragColor` and writes through `TDOutputSwizzle(...)`,
 *   - reads animation time from a `uniform float uTime` (bound to absTime by the Vectors
 *     sequence — there is NO built-in uTime in TD),
 *   - reads `uniform float uScale` and `uniform vec3 uColor` (also bound via the sequences),
 *   - uses only lowercase descriptive identifiers (short UPPERCASE names like F1/F2 collide
 *     with macros in TD's auto-prepended GLSL preamble),
 *   - samples nothing external (generative — no input TOP).
 * The fragment-local UV comes from the GLSL TOP built-in `vUV.st` (same idiom the repo's
 * working voronoi/fbm shaders use).
 *
 * Provenance (compile-risk notes live with the export at the bottom):
 *   - tunnel / metaballs / plasma: freshly written here (classic, low-complexity bodies).
 *   - fractal: a Julia-set zoom adapted from the iteration/coloring style of the verified
 *     fbm/voronoi shaders in createGenerativeArt.ts (same structure, no texture reads).
 *   - raymarch_sphere: a minimal sphere+ground sphere-trace with a single light; newly
 *     written, the highest-complexity body in the set.
 */

const TUNNEL_SHADER = `out vec4 fragColor;
uniform float uTime;
uniform float uScale;
uniform vec3 uColor;
void main(){
  vec2 uv = (vUV.st - 0.5) * 2.0;
  float radius = length(uv) * max(uScale, 0.0001);
  float angle = atan(uv.y, uv.x);
  float depth = 0.3 / (radius + 0.05) + uTime;
  float bands = 0.5 + 0.5 * sin(depth * 6.2831 + angle * 3.0);
  float rings = 0.5 + 0.5 * sin(angle * 8.0 + uTime * 2.0);
  float shade = bands * rings;
  vec3 col = uColor * shade + 0.05;
  col *= smoothstep(0.0, 0.25, radius);
  fragColor = TDOutputSwizzle(vec4(col, 1.0));
}
`;

const RAYMARCH_SPHERE_SHADER = `out vec4 fragColor;
uniform float uTime;
uniform float uScale;
uniform vec3 uColor;
float sceneDist(vec3 pos){
  float sphere = length(pos - vec3(0.0, 0.0, 0.0)) - max(uScale, 0.0001);
  float ground = pos.y + 1.0;
  return min(sphere, ground);
}
vec3 sceneNormal(vec3 pos){
  vec2 eps = vec2(0.001, 0.0);
  return normalize(vec3(
    sceneDist(pos + eps.xyy) - sceneDist(pos - eps.xyy),
    sceneDist(pos + eps.yxy) - sceneDist(pos - eps.yxy),
    sceneDist(pos + eps.yyx) - sceneDist(pos - eps.yyx)));
}
void main(){
  vec2 uv = (vUV.st - 0.5) * 2.0;
  vec3 rayOrigin = vec3(sin(uTime) * 3.0, 1.0, cos(uTime) * 3.0);
  vec3 forward = normalize(vec3(0.0) - rayOrigin);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), forward));
  vec3 up = cross(forward, right);
  vec3 rayDir = normalize(forward + uv.x * right + uv.y * up);
  float traveled = 0.0;
  float hit = 0.0;
  for(int step = 0; step < 64; step++){
    vec3 pos = rayOrigin + rayDir * traveled;
    float dist = sceneDist(pos);
    if(dist < 0.001){ hit = 1.0; break; }
    traveled += dist;
    if(traveled > 20.0){ break; }
  }
  vec3 col = vec3(0.02, 0.03, 0.06);
  if(hit > 0.5){
    vec3 pos = rayOrigin + rayDir * traveled;
    vec3 normal = sceneNormal(pos);
    vec3 lightDir = normalize(vec3(0.6, 0.8, 0.2));
    float diffuse = max(dot(normal, lightDir), 0.0);
    float ambient = 0.15;
    col = uColor * (ambient + diffuse);
  }
  fragColor = TDOutputSwizzle(vec4(col, 1.0));
}
`;

const FRACTAL_SHADER = `out vec4 fragColor;
uniform float uTime;
uniform float uScale;
uniform vec3 uColor;
void main(){
  float zoom = max(uScale, 0.0001);
  vec2 coord = (vUV.st - 0.5) * (3.0 / zoom);
  vec2 seed = vec2(0.7885 * cos(uTime * 0.3), 0.7885 * sin(uTime * 0.3));
  vec2 zval = coord;
  float iter = 0.0;
  const float maxIter = 100.0;
  for(int i = 0; i < 100; i++){
    zval = vec2(zval.x * zval.x - zval.y * zval.y, 2.0 * zval.x * zval.y) + seed;
    if(dot(zval, zval) > 4.0){ break; }
    iter += 1.0;
  }
  float norm = iter / maxIter;
  vec3 col = 0.5 + 0.5 * cos(6.2831 * (norm + uColor));
  col *= smoothstep(0.0, 0.05, norm);
  fragColor = TDOutputSwizzle(vec4(col, 1.0));
}
`;

const METABALLS_SHADER = `out vec4 fragColor;
uniform float uTime;
uniform float uScale;
uniform vec3 uColor;
void main(){
  vec2 uv = vUV.st;
  float field = 0.0;
  float radius = 0.12 * max(uScale, 0.0001);
  for(int i = 0; i < 5; i++){
    float fi = float(i);
    vec2 center = vec2(
      0.5 + 0.35 * sin(uTime * (0.5 + fi * 0.15) + fi * 1.7),
      0.5 + 0.35 * cos(uTime * (0.4 + fi * 0.12) + fi * 2.3));
    float dist = length(uv - center);
    field += radius * radius / (dist * dist + 0.0005);
  }
  float surface = smoothstep(0.8, 1.2, field);
  vec3 col = mix(vec3(0.02, 0.02, 0.05), uColor, surface);
  col += uColor * smoothstep(0.95, 1.05, field) * 0.5;
  fragColor = TDOutputSwizzle(vec4(col, 1.0));
}
`;

const PLASMA_SHADER = `out vec4 fragColor;
uniform float uTime;
uniform float uScale;
uniform vec3 uColor;
void main(){
  vec2 uv = vUV.st * (6.0 * max(uScale, 0.0001));
  float wave = sin(uv.x + uTime);
  wave += sin(uv.y + uTime * 0.8);
  wave += sin((uv.x + uv.y) * 0.7 + uTime * 1.3);
  wave += sin(length(uv - 3.0) + uTime * 1.1);
  float value = wave * 0.25;
  vec3 col = 0.5 + 0.5 * cos(6.2831 * (value + uColor));
  fragColor = TDOutputSwizzle(vec4(col, 1.0));
}
`;

const SHADER_NAMES = ["tunnel", "raymarch_sphere", "fractal", "metaballs", "plasma"] as const;
type ShaderName = (typeof SHADER_NAMES)[number];

// Keyed by the enum so a lookup with a validated `shader` arg is always a `string`.
const SHADERS: Record<ShaderName, string> = {
  tunnel: TUNNEL_SHADER,
  raymarch_sphere: RAYMARCH_SPHERE_SHADER,
  fractal: FRACTAL_SHADER,
  metaballs: METABALLS_SHADER,
  plasma: PLASMA_SHADER,
};

export const createShaderLibSchema = z.object({
  shader: z
    .enum(SHADER_NAMES)
    .default(SHADER_NAMES[0])
    .describe("Which curated built-in shader to instantiate."),
  speed: z.coerce
    .number()
    .default(1)
    .describe("Animation speed multiplier (drives uTime). Exposed as a live 'Speed' control."),
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
    .describe("Expose live Speed / Scale / Color controls on the system container."),
  parent_path: z
    .string()
    .default("/project1")
    .describe(
      "Parent COMP path the self-contained 'shader_lib_<shader>' container is created inside.",
    ),
});
type CreateShaderLibArgs = z.infer<typeof createShaderLibSchema>;

/**
 * Builds the GLSL TOP + Text DAT (fragment via pixeldat) → Null TOP network and binds the
 * uTime / uScale / uColor uniforms through the GLSL TOP's parameter sequences, mirroring
 * createGenerativeArt.buildGlslGenerative exactly.
 *
 * Binding strategy (matches the verified Speed idiom): every uniform expression reads its
 * matching custom parameter on the parent COMP with a defensive `hasattr` guard, falling
 * back to the build-time constant when no control is present — so the expression never
 * errors whether or not `expose_controls` ran. The Color control is an RGB swatch, which
 * cannot use `bind_to` (createControlPanel ignores it for rgb), so uColor reads the swatch's
 * Colorr/Colorg/Colorb components directly instead.
 */
async function buildShaderNetwork(
  ctx: ToolContext,
  parentPath: string,
  name: string,
  fragment: string,
  speed: number,
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
  // setter, so raise it via numBlocks, then set each block's name + value expression.
  // The "Vectors" page (vec sequence) carries the float scalars uTime (block 0) and uScale
  // (block 1); the "Colors" page (color sequence) carries the vec3 uColor (block 0).
  const speedExpr = `absTime.seconds * (parent().par.Speed.eval() if hasattr(parent().par, 'Speed') else ${speed})`;
  const scaleExpr = `parent().par.Scale.eval() if hasattr(parent().par, 'Scale') else ${scale}`;
  await builder.python(
    [
      `_g = op(${q(glsl)})`,
      `_g.seq.vec.numBlocks = max(_g.seq.vec.numBlocks, 2)`,
      `_g.par.vec0name = 'uTime'`,
      `_g.par.vec0valuex.expr = ${q(speedExpr)}`,
      `_g.par.vec1name = 'uScale'`,
      `_g.par.vec1valuex.expr = ${q(scaleExpr)}`,
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

export async function createShaderLibImpl(ctx: ToolContext, args: CreateShaderLibArgs) {
  return runBuild(async () => {
    const fragment = SHADERS[args.shader];

    const color = parseHexColor(args.color ?? "") ?? ([0.2, 0.8, 1.0] as [number, number, number]);
    const colorWarning =
      args.color !== undefined && parseHexColor(args.color) === undefined
        ? `Could not parse color "${args.color}" (expected hex like '#33ccff'); used the default.`
        : undefined;

    const { builder, outputPath } = await buildShaderNetwork(
      ctx,
      args.parent_path,
      `shader_lib_${args.shader}`,
      fragment,
      args.speed,
      args.scale,
      color,
      args.resolution,
    );
    if (colorWarning) builder.warnings.push(colorWarning);

    // Live controls bound to the uniforms. Speed/Scale drive their uniform expressions via
    // the defensive parent() lookups above; Color is an RGB swatch whose components those
    // expressions read directly (bind_to is unsupported for rgb).
    const controls: ControlSpec[] = args.expose_controls
      ? [
          { name: "Speed", type: "float", min: 0, max: 4, default: args.speed },
          { name: "Scale", type: "float", min: 0.1, max: 4, default: args.scale },
          // Seed the RGB swatch with the build-time colour (a swatch defaults to black, which
          // would make every uColor-driven shader render black/dark).
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
      summary: `Created a "${args.shader}" shader from the curated library (GLSL).`,
      builder,
      outputPath,
      controls,
      capturePreviewImage: true,
      extra: {
        shader: args.shader,
        speed: args.speed,
        scale: args.scale,
        color,
        resolution: args.resolution,
      },
    });
  });
}

export const registerCreateShaderLib: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_shader_lib",
    {
      title: "Create shader from library",
      description:
        "Instantiate a curated, ready-to-run full-screen GLSL shader (tunnel, raymarch_sphere, fractal, metaballs, plasma) into a GLSL TOP with live Speed / Scale / Color controls. High-value VJ eye-candy; unlike create_glsl_shader it ships robust built-in shaders rather than taking arbitrary code.",
      inputSchema: createShaderLibSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createShaderLibImpl(ctx, args),
  );
};
