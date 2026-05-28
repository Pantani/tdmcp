import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, type NetworkBuilder, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

/**
 * Self-contained GLSL TOP raymarchers — the 3D / signed-distance-field complement to
 * createShaderLib's flat 2D shaders. Each scene is a single fragment shader for a
 * TouchDesigner GLSL TOP, written to the exact conventions verified in createShaderLib.ts
 * / createGenerativeArt.ts (which already ships a working sphere-trace), so there is no new
 * compile mechanism — only new SDF bodies:
 *   - declares its own `out vec4 fragColor` and writes through `TDOutputSwizzle(...)`,
 *   - reads animation time from a `uniform float uTime` bound to absTime by the Vectors
 *     sequence (there is NO built-in uTime in TD),
 *   - reads `uniform float uCameraZ`, `uSteps`, `uIntensity` (Vectors sequence) and
 *     `uniform vec3 uColorA`, `uColorB` (Colors sequence) — all bound via the GLSL TOP's
 *     parameter sequences, the same path createShaderLib uses,
 *   - uses only lowercase descriptive identifiers (short UPPERCASE names like F1/F2 collide
 *     with macros in TD's auto-prepended GLSL preamble),
 *   - samples nothing external (generative — no input TOP).
 * The fragment-local UV comes from the GLSL TOP built-in `vUV.st` (same idiom the repo's
 * working voronoi/fbm/raymarch_sphere shaders use).
 *
 * `uSteps` gates the raymarch iteration count. GLSL requires a constant `for` bound, so each
 * body loops to a literal ceiling (256) and breaks once `i >= int(uSteps)` — the live control
 * trims the work without a dynamic loop bound.
 */

// Shared raymarch preamble: camera setup + the iteration loop. Each scene supplies its own
// `sceneDist` (SDF) above the body; the marcher and shading below are identical.
const MARCH_BODY = `void main(){
  vec2 uv = (vUV.st - 0.5) * 2.0;
  vec3 rayOrigin = vec3(0.0, 0.0, max(uCameraZ, 0.1));
  vec3 forward = normalize(vec3(0.0) - rayOrigin);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), forward));
  vec3 up = cross(forward, right);
  vec3 rayDir = normalize(forward + uv.x * right + uv.y * up);
  float traveled = 0.0;
  float hit = 0.0;
  int maxSteps = int(max(uSteps, 1.0));
  for(int i = 0; i < 256; i++){
    if(i >= maxSteps){ break; }
    vec3 pos = rayOrigin + rayDir * traveled;
    float dist = sceneDist(pos);
    if(dist < 0.001){ hit = 1.0; break; }
    traveled += dist;
    if(traveled > 40.0){ break; }
  }
  vec3 col = mix(uColorA, uColorB, 0.0) * 0.04;
  if(hit > 0.5){
    vec3 pos = rayOrigin + rayDir * traveled;
    vec3 normal = sceneNormal(pos);
    vec3 lightDir = normalize(vec3(0.6, 0.8, 0.4));
    float diffuse = max(dot(normal, lightDir), 0.0);
    float depth = clamp(traveled / 12.0, 0.0, 1.0);
    vec3 base = mix(uColorA, uColorB, depth);
    col = base * (0.18 + diffuse);
  }
  col *= max(uIntensity, 0.0);
  fragColor = TDOutputSwizzle(vec4(col, 1.0));
}
`;

// Central-difference normal from the scene SDF — identical for every scene.
const SCENE_NORMAL = `vec3 sceneNormal(vec3 pos){
  vec2 eps = vec2(0.001, 0.0);
  return normalize(vec3(
    sceneDist(pos + eps.xyy) - sceneDist(pos - eps.xyy),
    sceneDist(pos + eps.yxy) - sceneDist(pos - eps.yxy),
    sceneDist(pos + eps.yyx) - sceneDist(pos - eps.yyx)));
}
`;

const UNIFORMS = `uniform float uTime;
uniform float uCameraZ;
uniform float uSteps;
uniform float uIntensity;
uniform vec3  uColorA;
uniform vec3  uColorB;
`;

// Infinitely repeated spheres: domain repetition with mod() tiles one sphere through space,
// the lattice slowly drifting with uTime so the field breathes.
const SPHERE_FIELD_SHADER = `out vec4 fragColor;
${UNIFORMS}
float sceneDist(vec3 pos){
  vec3 drift = vec3(0.0, 0.0, uTime * 0.6);
  vec3 cell = mod(pos + drift + 2.0, 4.0) - 2.0;
  return length(cell) - 0.85;
}
${SCENE_NORMAL}${MARCH_BODY}`;

// Menger sponge: the classic box-fold fractal. Iterating the cross-subtraction carves the
// sponge; uTime gently rotates the lattice so faces catch the light.
const MENGER_SHADER = `out vec4 fragColor;
${UNIFORMS}
float sdBox(vec3 pos, vec3 halfSize){
  vec3 d = abs(pos) - halfSize;
  return length(max(d, 0.0)) + min(max(d.x, max(d.y, d.z)), 0.0);
}
float sceneDist(vec3 pos){
  float ca = cos(uTime * 0.25);
  float sa = sin(uTime * 0.25);
  pos.xz = mat2(ca, -sa, sa, ca) * pos.xz;
  float dist = sdBox(pos, vec3(1.2));
  float scale = 1.0;
  for(int i = 0; i < 4; i++){
    vec3 a = mod(pos * scale, 2.0) - 1.0;
    scale *= 3.0;
    vec3 r = abs(1.0 - 3.0 * abs(a));
    float cross = min(max(r.x, r.y), min(max(r.y, r.z), max(r.z, r.x))) - 1.0;
    dist = max(dist, cross / scale);
  }
  return dist;
}
${SCENE_NORMAL}${MARCH_BODY}`;

// Twisting tunnel: a hollow cylinder (subtract the radial distance from a fixed radius)
// whose cross-section twists along z with uTime, pulling the camera through it.
const TUNNEL_SHADER = `out vec4 fragColor;
${UNIFORMS}
float sceneDist(vec3 pos){
  pos.z += uTime * 1.5;
  float twist = pos.z * 0.35;
  float ca = cos(twist);
  float sa = sin(twist);
  pos.xy = mat2(ca, -sa, sa, ca) * pos.xy;
  float wobble = 0.3 * sin(pos.z * 0.7) + 0.2 * cos(pos.x * 2.0);
  float radius = length(pos.xy) - (1.6 + wobble);
  return -radius;
}
${SCENE_NORMAL}${MARCH_BODY}`;

const SCENE_NAMES = ["sphere_field", "menger", "tunnel"] as const;
type SceneName = (typeof SCENE_NAMES)[number];

// Keyed by the enum so a lookup with a validated `scene` arg is always a `string`.
const SHADERS: Record<SceneName, string> = {
  sphere_field: SPHERE_FIELD_SHADER,
  menger: MENGER_SHADER,
  tunnel: TUNNEL_SHADER,
};

const HEX_COLOR = /^#?([0-9a-fA-F]{6})$/;

/** Parses "#rrggbb" (or "rrggbb") into 0..1 RGB; undefined for malformed input. */
function parseHexColor(hex: string): [number, number, number] | undefined {
  const match = HEX_COLOR.exec(hex.trim());
  const group = match?.[1];
  if (!group) return undefined;
  const int = Number.parseInt(group, 16);
  return [((int >> 16) & 0xff) / 255, ((int >> 8) & 0xff) / 255, (int & 0xff) / 255];
}

/** Formats a 0..1 RGB triple back to a "#rrggbb" string for seeding an RGB swatch. */
function toHex(rgb: [number, number, number]): string {
  return `#${rgb
    .map((c) =>
      Math.round(c * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

export const createRaymarchSceneSchema = z.object({
  scene: z
    .enum(SCENE_NAMES)
    .default(SCENE_NAMES[0])
    .describe("Which SDF scene to ray-march: sphere_field, menger (sponge fractal), or tunnel."),
  camera_z: z.coerce
    .number()
    .default(4)
    .describe(
      "Camera distance back from the origin (uCameraZ). Exposed as a live 'CameraZ' control.",
    ),
  speed: z.coerce
    .number()
    .default(1)
    .describe("Animation speed multiplier (drives uTime). Exposed as a live 'Speed' control."),
  step_count: z.coerce
    .number()
    .int()
    .min(8)
    .max(256)
    .default(64)
    .describe("Raymarch iterations (uSteps); higher = more detail/cost. Exposed as 'StepCount'."),
  intensity: z.coerce
    .number()
    .default(1)
    .describe("Output brightness multiplier (uIntensity). Exposed as a live 'Intensity' control."),
  color_a: z
    .string()
    .optional()
    .describe(
      "Near/primary colour as hex (e.g. '#33ccff'); parsed to 0..1 RGB, exposed as 'ColorA'.",
    ),
  color_b: z
    .string()
    .optional()
    .describe(
      "Far/secondary colour as hex (e.g. '#ff2266'); parsed to 0..1 RGB, exposed as 'ColorB'.",
    ),
  resolution: z
    .tuple([z.coerce.number().int().positive(), z.coerce.number().int().positive()])
    .default([1280, 720])
    .describe("Output resolution [width, height] of the GLSL TOP."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Expose live CameraZ / Speed / StepCount / Intensity / ColorA / ColorB controls."),
  parent_path: z.string().default("/project1"),
});
type CreateRaymarchSceneArgs = z.infer<typeof createRaymarchSceneSchema>;

/**
 * Builds the GLSL TOP + Text DAT (fragment via pixeldat) → Null TOP network and binds the
 * uTime / uCameraZ / uSteps / uIntensity / uColorA / uColorB uniforms through the GLSL TOP's
 * parameter sequences, mirroring createShaderLib.buildShaderNetwork exactly.
 *
 * Binding strategy (the verified Speed idiom): every uniform expression reads its matching
 * custom parameter on the parent COMP with a defensive `hasattr` guard, falling back to the
 * build-time constant when no control is present — so the expression never errors whether or
 * not `expose_controls` ran. The ColorA/ColorB controls are RGB swatches, which cannot use
 * `bind_to` (createControlPanel ignores it for rgb), so uColorA/uColorB read each swatch's
 * Color<x>r/g/b components directly instead. The control names lowercase their tail in TD
 * (CameraZ → par Cameraz, StepCount → Stepcount, ColorA → comps Colorar/Colorag/Colorab), so
 * the expressions read those exact parameter names.
 */
async function buildRaymarchNetwork(
  ctx: ToolContext,
  parentPath: string,
  name: string,
  fragment: string,
  args: CreateRaymarchSceneArgs,
  colorA: [number, number, number],
  colorB: [number, number, number],
): Promise<{ builder: NetworkBuilder; outputPath: string }> {
  const builder = await createSystemContainer(ctx, parentPath, name);
  const glsl = await builder.add("glslTOP", "glsl1", {
    resolutionw: args.resolution[0],
    resolutionh: args.resolution[1],
    outputresolution: "custom",
  });
  const frag = await builder.add("textDAT", "glsl1_frag");
  await builder.python(
    `op(${q(frag)}).text = ${q(fragment)}\nop(${q(glsl)}).par.pixeldat = op(${q(frag)}).name`,
  );

  // Uniforms live in the GLSL TOP's parameter sequences; the block count has no structured
  // setter, so raise it via numBlocks, then set each block's name + value expression. The
  // "Vectors" page (vec sequence) carries the float scalars uTime/uCameraZ/uSteps/uIntensity;
  // the "Colors" page (color sequence) carries the vec3 uColorA (block 0) / uColorB (block 1).
  const timeExpr = `absTime.seconds * (parent().par.Speed.eval() if hasattr(parent().par, 'Speed') else ${args.speed})`;
  const camExpr = `parent().par.Cameraz.eval() if hasattr(parent().par, 'Cameraz') else ${args.camera_z}`;
  const stepsExpr = `parent().par.Stepcount.eval() if hasattr(parent().par, 'Stepcount') else ${args.step_count}`;
  const intensityExpr = `parent().par.Intensity.eval() if hasattr(parent().par, 'Intensity') else ${args.intensity}`;
  const colorExpr = (control: string, fallback: number): string =>
    `parent().par.${control}.eval() if hasattr(parent().par, '${control}') else ${fallback}`;
  await builder.python(
    [
      `_g = op(${q(glsl)})`,
      `_g.seq.vec.numBlocks = max(_g.seq.vec.numBlocks, 4)`,
      `_g.par.vec0name = 'uTime'`,
      `_g.par.vec0valuex.expr = ${q(timeExpr)}`,
      `_g.par.vec1name = 'uCameraZ'`,
      `_g.par.vec1valuex.expr = ${q(camExpr)}`,
      `_g.par.vec2name = 'uSteps'`,
      `_g.par.vec2valuex.expr = ${q(stepsExpr)}`,
      `_g.par.vec3name = 'uIntensity'`,
      `_g.par.vec3valuex.expr = ${q(intensityExpr)}`,
      `_g.seq.color.numBlocks = max(_g.seq.color.numBlocks, 2)`,
      `_g.par.color0name = 'uColorA'`,
      `_g.par.color0rgbr.expr = ${q(colorExpr("Colorar", colorA[0]))}`,
      `_g.par.color0rgbg.expr = ${q(colorExpr("Colorag", colorA[1]))}`,
      `_g.par.color0rgbb.expr = ${q(colorExpr("Colorab", colorA[2]))}`,
      `_g.par.color1name = 'uColorB'`,
      `_g.par.color1rgbr.expr = ${q(colorExpr("Colorbr", colorB[0]))}`,
      `_g.par.color1rgbg.expr = ${q(colorExpr("Colorbg", colorB[1]))}`,
      `_g.par.color1rgbb.expr = ${q(colorExpr("Colorbb", colorB[2]))}`,
    ].join("\n"),
  );

  const out = await builder.add("nullTOP", "out1");
  await builder.connect(glsl, out);
  return { builder, outputPath: out };
}

export async function createRaymarchSceneImpl(ctx: ToolContext, args: CreateRaymarchSceneArgs) {
  return runBuild(async () => {
    const fragment = SHADERS[args.scene];

    const defaultA: [number, number, number] = [0.2, 0.8, 1.0];
    const defaultB: [number, number, number] = [1.0, 0.13, 0.4];
    const colorA = parseHexColor(args.color_a ?? "") ?? defaultA;
    const colorB = parseHexColor(args.color_b ?? "") ?? defaultB;
    const colorWarnings: string[] = [];
    if (args.color_a !== undefined && parseHexColor(args.color_a) === undefined) {
      colorWarnings.push(
        `Could not parse color_a "${args.color_a}" (expected hex like '#33ccff'); used the default.`,
      );
    }
    if (args.color_b !== undefined && parseHexColor(args.color_b) === undefined) {
      colorWarnings.push(
        `Could not parse color_b "${args.color_b}" (expected hex like '#ff2266'); used the default.`,
      );
    }

    const { builder, outputPath } = await buildRaymarchNetwork(
      ctx,
      args.parent_path,
      `raymarch_scene_${args.scene}`,
      fragment,
      args,
      colorA,
      colorB,
    );
    builder.warnings.push(...colorWarnings);

    // Live controls bound to the uniforms. CameraZ/Speed/StepCount/Intensity drive their
    // uniform expressions via the defensive parent() lookups above; ColorA/ColorB are RGB
    // swatches whose components those expressions read directly (bind_to is unsupported for
    // rgb). Seed each swatch with the build-time colour (a swatch defaults to black, which
    // would render the scene dark).
    const controls: ControlSpec[] = args.expose_controls
      ? [
          { name: "CameraZ", type: "float", min: 1, max: 12, default: args.camera_z },
          { name: "Speed", type: "float", min: 0, max: 4, default: args.speed },
          { name: "StepCount", type: "int", min: 8, max: 256, default: args.step_count },
          { name: "Intensity", type: "float", min: 0, max: 3, default: args.intensity },
          { name: "ColorA", type: "rgb", default: toHex(colorA) },
          { name: "ColorB", type: "rgb", default: toHex(colorB) },
        ]
      : [];

    return finalize(ctx, {
      summary: `Created a "${args.scene}" SDF raymarcher (GLSL).`,
      builder,
      outputPath,
      controls,
      capturePreviewImage: true,
      extra: {
        scene: args.scene,
        camera_z: args.camera_z,
        speed: args.speed,
        step_count: args.step_count,
        intensity: args.intensity,
        color_a: colorA,
        color_b: colorB,
        resolution: args.resolution,
      },
    });
  });
}

export const registerCreateRaymarchScene: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_raymarch_scene",
    {
      title: "Create raymarch scene",
      description:
        "Instantiate a self-contained GLSL TOP raymarcher (volumetric / signed-distance-field) — the 3D complement to create_shader_lib. Scenes: sphere_field (repeated spheres), menger (Menger-sponge fractal), tunnel (twisting tunnel). Exposes live CameraZ / Speed / StepCount / Intensity / ColorA / ColorB controls and previews the output TOP.",
      inputSchema: createRaymarchSceneSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createRaymarchSceneImpl(ctx, args),
  );
};
