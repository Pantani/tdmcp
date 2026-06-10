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
 * Programmable SDF (signed-distance-field) generator that lets the caller compose a CSG
 * tree of primitives — sphere, box, torus — combined with boolean ops union / intersect /
 * subtract (smooth blends via smin/smax). Implements roadmap Milestone 4.
 *
 * The generated GLSL TOP fragment follows the same preamble conventions as createRaymarchScene:
 *   - declares `out vec4 fragColor` and writes through `TDOutputSwizzle`,
 *   - reads animation time from `uniform float uTime` (no built-in uTime in TD),
 *   - reads camera / step / intensity / rotate / colour uniforms from the GLSL TOP's sequences,
 *   - uses only lowercase descriptive identifiers (UPPERCASE like F1/F2 collide with TD preamble macros).
 */

// SDF primitive helpers — always emitted so the shader compiles even when not all are used.
const SDF_HELPERS = `float sdSphere(vec3 pos, float r){
  return length(pos) - r;
}
float sdBox(vec3 pos, vec3 halfSize){
  vec3 d = abs(pos) - halfSize;
  return length(max(d, 0.0)) + min(max(d.x, max(d.y, d.z)), 0.0);
}
float sdTorus(vec3 pos, float outerR, float innerR){
  vec2 q = vec2(length(pos.xz) - outerR, pos.y);
  return length(q) - innerR;
}
float smin(float a, float b, float k){
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
float smax(float a, float b, float k){
  float h = clamp(0.5 - 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) + k * h * (1.0 - h);
}
`;

// Central-difference normal.
const SCENE_NORMAL = `vec3 sceneNormal(vec3 pos){
  vec2 eps = vec2(0.001, 0.0);
  return normalize(vec3(
    sceneDist(pos + eps.xyy) - sceneDist(pos - eps.xyy),
    sceneDist(pos + eps.yxy) - sceneDist(pos - eps.yxy),
    sceneDist(pos + eps.yyx) - sceneDist(pos - eps.yyx)));
}
`;

// Shared march body — identical to createRaymarchScene but reads uBackground for misses and
// uses uRotate-driven orbit. uBackground is carried in the Colors sequence block 2.
const MARCH_BODY = `void main(){
  vec2 uv = (vUV.st - 0.5) * 2.0;
  vec3 rayOrigin = vec3(0.0, 0.0, max(uCameraZ, 0.1));
  // uCameraTarget is baked at build time from the schema's camera_target arg
  // so the ray aims where the artist asked instead of always at the origin.
  vec3 forward = normalize(uCameraTarget - rayOrigin);
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
  vec3 col = uBackground;
  if(hit > 0.5){
    vec3 pos = rayOrigin + rayDir * traveled;
    vec3 normal = sceneNormal(pos);
    vec3 lightDir = uLightDir;
    float diffuse = max(dot(normal, lightDir), 0.0);
    float depth = clamp(traveled / 12.0, 0.0, 1.0);
    vec3 base = mix(uColorA, uColorB, depth);
    col = base * (0.18 + diffuse);
  }
  col *= max(uIntensity, 0.0);
  fragColor = TDOutputSwizzle(vec4(col, 1.0));
}
`;

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

const primitiveSchema = z.object({
  kind: z.enum(["sphere", "box", "torus"]).describe("SDF primitive shape."),
  op: z
    .enum(["union", "intersect", "subtract"])
    .describe(
      "Boolean CSG op vs the running fold. First primitive's op is always treated as union.",
    ),
  position: z
    .tuple([z.number(), z.number(), z.number()])
    .default([0, 0, 0])
    .describe("Centre position offset [x,y,z]."),
  size: z.number().positive().default(1).describe("Uniform radius/half-extent (sphere/box)."),
  size3: z
    .tuple([z.number().positive(), z.number().positive(), z.number().positive()])
    .optional()
    .describe("Per-axis half-extents [x,y,z] for box (overrides size when provided)."),
  thickness: z
    .number()
    .positive()
    .default(0.3)
    .describe("Tube radius for torus (inner radius); outer radius = size."),
  blend: z
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe("Smooth blend radius [0..1]. 0 = hard boolean; >0 enables smin/smax."),
});
type Primitive = z.infer<typeof primitiveSchema>;

export const createSdfFieldSchema = z.object({
  primitives: z
    .array(primitiveSchema)
    .min(1)
    .max(16)
    .default([
      { kind: "sphere", op: "union", position: [0, 0, 0], size: 1, thickness: 0.3, blend: 0 },
    ])
    .describe(
      "CSG tree of SDF primitives (max 16). First prim is always union (root). Each subsequent prim is combined with the running fold via its op.",
    ),
  camera_z: z.coerce
    .number()
    .default(4)
    .describe("Camera distance from origin (uCameraZ). Live 'CameraZ' control."),
  camera_target: z
    .tuple([z.number(), z.number(), z.number()])
    .default([0, 0, 0])
    .describe("Look-at point baked as GLSL constant (not a live control)."),
  speed: z.coerce
    .number()
    .default(1)
    .describe("Animation speed multiplier (drives uTime). Live 'Speed' control."),
  step_count: z.coerce
    .number()
    .int()
    .min(8)
    .max(256)
    .default(96)
    .describe("Raymarch iterations (uSteps); SDF CSG benefits from more steps. Live 'StepCount'."),
  intensity: z.coerce
    .number()
    .default(1)
    .describe("Output brightness multiplier (uIntensity). Live 'Intensity' control."),
  light_direction: z
    .tuple([z.number(), z.number(), z.number()])
    .default([0.6, 0.8, 0.4])
    .describe("Light direction normalised in shader — baked as GLSL constant."),
  color_a: z
    .string()
    .default("#33ccff")
    .describe("Near colour hex (e.g. '#33ccff'). Live RGB swatch 'ColorA'."),
  color_b: z
    .string()
    .default("#ff2266")
    .describe("Far colour hex (e.g. '#ff2266'). Live RGB swatch 'ColorB'."),
  background: z
    .string()
    .default("#06080c")
    .describe("Background / miss colour hex. Live RGB swatch 'Background'."),
  rotate_scene: z.coerce
    .number()
    .default(0)
    .describe(
      "Y-axis rotation speed (radians/s applied to SDF space via uRotate * uTime). Live 'Rotate'. Reads 0 when TD timeline is paused.",
    ),
  resolution: z
    .tuple([z.coerce.number().int().positive(), z.coerce.number().int().positive()])
    .default([1280, 720])
    .describe("Output resolution [width, height] of the GLSL TOP."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe(
      "Expose live CameraZ/Speed/StepCount/Intensity/Rotate/ColorA/ColorB/Background controls.",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path the self-contained 'sdf_field' container is created inside."),
});

type CreateSdfFieldArgs = z.infer<typeof createSdfFieldSchema>;

/** Generates the sceneDist function body from the primitives CSG tree. */
function generateSceneDist(primitives: Primitive[], lightDir: [number, number, number]): string {
  const ld = lightDir;
  const ldLen = Math.sqrt(ld[0] * ld[0] + ld[1] * ld[1] + ld[2] * ld[2]) || 1;
  const ldNorm: [number, number, number] = [ld[0] / ldLen, ld[1] / ldLen, ld[2] / ldLen];

  const lines: string[] = [];
  lines.push(
    `// light direction baked at build time`,
    `const vec3 uLightDir = normalize(vec3(${ldNorm[0].toFixed(4)}, ${ldNorm[1].toFixed(4)}, ${ldNorm[2].toFixed(4)}));`,
    ``,
    `float sceneDist(vec3 pos){`,
    `  // apply y-axis rotation driven by uRotate * uTime`,
    `  float angle = uTime * uRotate;`,
    `  float ca = cos(angle);`,
    `  float sa = sin(angle);`,
    `  pos.xz = mat2(ca, -sa, sa, ca) * pos.xz;`,
    ``,
  );

  // Emit per-primitive distance calls
  primitives.forEach((prim, i) => {
    const px = prim.position[0].toFixed(4);
    const py = prim.position[1].toFixed(4);
    const pz = prim.position[2].toFixed(4);
    const shifted = `pos - vec3(${px}, ${py}, ${pz})`;
    if (prim.kind === "sphere") {
      lines.push(`  float d${i} = sdSphere(${shifted}, ${prim.size.toFixed(4)});`);
    } else if (prim.kind === "box") {
      const hx = prim.size3 ? prim.size3[0] : prim.size;
      const hy = prim.size3 ? prim.size3[1] : prim.size;
      const hz = prim.size3 ? prim.size3[2] : prim.size;
      lines.push(
        `  float d${i} = sdBox(${shifted}, vec3(${hx.toFixed(4)}, ${hy.toFixed(4)}, ${hz.toFixed(4)}));`,
      );
    } else {
      // torus
      lines.push(
        `  float d${i} = sdTorus(${shifted}, ${prim.size.toFixed(4)}, ${prim.thickness.toFixed(4)});`,
      );
    }
  });

  lines.push(`  float d = d0;`);

  // CSG fold left to right
  for (let i = 1; i < primitives.length; i++) {
    const prim = primitives[i];
    if (!prim) continue;
    const blend = prim.blend ?? 0;
    const useSmooth = blend > 0;
    if (prim.op === "union") {
      if (useSmooth) {
        lines.push(`  d = smin(d, d${i}, ${blend.toFixed(4)});`);
      } else {
        lines.push(`  d = min(d, d${i});`);
      }
    } else if (prim.op === "intersect") {
      if (useSmooth) {
        lines.push(`  d = smax(d, d${i}, ${blend.toFixed(4)});`);
      } else {
        lines.push(`  d = max(d, d${i});`);
      }
    } else {
      // subtract — subtracts the i-th prim from the running fold
      if (useSmooth) {
        lines.push(`  d = smax(d, -d${i}, ${blend.toFixed(4)});`);
      } else {
        lines.push(`  d = max(d, -d${i});`);
      }
    }
  }

  lines.push(`  return d;`, `}`);
  return lines.join("\n");
}

/** Builds the full fragment shader string. */
function buildFragmentShader(
  primitives: Primitive[],
  lightDir: [number, number, number],
  cameraTarget: [number, number, number],
): string {
  const uniforms = `uniform float uTime;
uniform float uCameraZ;
uniform float uSteps;
uniform float uIntensity;
uniform float uRotate;
uniform vec3  uColorA;
uniform vec3  uColorB;
uniform vec3  uBackground;
`;
  // Bake camera_target as a const (not a uniform) — the schema doc explicitly
  // calls it "not a live control"; this is the cheapest, most faithful wiring.
  const cameraTargetConst = `const vec3 uCameraTarget = vec3(${cameraTarget[0].toFixed(4)}, ${cameraTarget[1].toFixed(4)}, ${cameraTarget[2].toFixed(4)});\n`;
  return `out vec4 fragColor;
${uniforms}${cameraTargetConst}
${SDF_HELPERS}
${generateSceneDist(primitives, lightDir)}
${SCENE_NORMAL}${MARCH_BODY}`;
}

async function buildSdfNetwork(
  ctx: ToolContext,
  args: CreateSdfFieldArgs,
  colorA: [number, number, number],
  colorB: [number, number, number],
  bg: [number, number, number],
): Promise<{ builder: NetworkBuilder; outputPath: string }> {
  const fragment = buildFragmentShader(args.primitives, args.light_direction, args.camera_target);

  const builder = await createSystemContainer(ctx, args.parent_path, "sdf_field");
  const glsl = await builder.add("glslTOP", "glsl1", {
    resolutionw: args.resolution[0],
    resolutionh: args.resolution[1],
    outputresolution: "custom",
  });
  const frag = await builder.add("textDAT", "glsl1_frag");
  await builder.python(
    `op(${q(frag)}).text = ${q(fragment)}\nop(${q(glsl)}).par.pixeldat = op(${q(frag)}).name`,
  );

  const timeExpr = `absTime.seconds * (parent().par.Speed.eval() if hasattr(parent().par, 'Speed') else ${args.speed})`;
  const camExpr = `parent().par.Cameraz.eval() if hasattr(parent().par, 'Cameraz') else ${args.camera_z}`;
  const stepsExpr = `parent().par.Stepcount.eval() if hasattr(parent().par, 'Stepcount') else ${args.step_count}`;
  const intensityExpr = `parent().par.Intensity.eval() if hasattr(parent().par, 'Intensity') else ${args.intensity}`;
  const rotateExpr = `parent().par.Rotate.eval() if hasattr(parent().par, 'Rotate') else ${args.rotate_scene}`;
  const colorExpr = (control: string, fallback: number): string =>
    `parent().par.${control}.eval() if hasattr(parent().par, '${control}') else ${fallback}`;

  await builder.python(
    [
      `_g = op(${q(glsl)})`,
      `_g.seq.vec.numBlocks = max(_g.seq.vec.numBlocks, 5)`,
      `_g.par.vec0name = 'uTime'`,
      `_g.par.vec0valuex.expr = ${q(timeExpr)}`,
      `_g.par.vec1name = 'uCameraZ'`,
      `_g.par.vec1valuex.expr = ${q(camExpr)}`,
      `_g.par.vec2name = 'uSteps'`,
      `_g.par.vec2valuex.expr = ${q(stepsExpr)}`,
      `_g.par.vec3name = 'uIntensity'`,
      `_g.par.vec3valuex.expr = ${q(intensityExpr)}`,
      `_g.par.vec4name = 'uRotate'`,
      `_g.par.vec4valuex.expr = ${q(rotateExpr)}`,
      `_g.seq.color.numBlocks = max(_g.seq.color.numBlocks, 3)`,
      `_g.par.color0name = 'uColorA'`,
      `_g.par.color0rgbr.expr = ${q(colorExpr("Colorar", colorA[0]))}`,
      `_g.par.color0rgbg.expr = ${q(colorExpr("Colorag", colorA[1]))}`,
      `_g.par.color0rgbb.expr = ${q(colorExpr("Colorab", colorA[2]))}`,
      `_g.par.color1name = 'uColorB'`,
      `_g.par.color1rgbr.expr = ${q(colorExpr("Colorbr", colorB[0]))}`,
      `_g.par.color1rgbg.expr = ${q(colorExpr("Colorbg", colorB[1]))}`,
      `_g.par.color1rgbb.expr = ${q(colorExpr("Colorbb", colorB[2]))}`,
      `_g.par.color2name = 'uBackground'`,
      `_g.par.color2rgbr.expr = ${q(colorExpr("Backgroundr", bg[0]))}`,
      `_g.par.color2rgbg.expr = ${q(colorExpr("Backgroundg", bg[1]))}`,
      `_g.par.color2rgbb.expr = ${q(colorExpr("Backgroundb", bg[2]))}`,
    ].join("\n"),
  );

  const out = await builder.add("nullTOP", "out1");
  await builder.connect(glsl, out);
  return { builder, outputPath: out };
}

export async function createSdfFieldImpl(ctx: ToolContext, args: CreateSdfFieldArgs) {
  return runBuild(async () => {
    const defaultA: [number, number, number] = [0.2, 0.8, 1.0];
    const defaultB: [number, number, number] = [1.0, 0.13, 0.4];
    const defaultBg: [number, number, number] = [0.024, 0.031, 0.047];

    const colorA = parseHexColor(args.color_a) ?? defaultA;
    const colorB = parseHexColor(args.color_b) ?? defaultB;
    const bg = parseHexColor(args.background) ?? defaultBg;

    const colorWarnings: string[] = [];
    if (parseHexColor(args.color_a) === undefined) {
      colorWarnings.push(
        `Could not parse color_a "${args.color_a}" (expected hex like '#33ccff'); used the default.`,
      );
    }
    if (parseHexColor(args.color_b) === undefined) {
      colorWarnings.push(
        `Could not parse color_b "${args.color_b}" (expected hex like '#ff2266'); used the default.`,
      );
    }
    if (parseHexColor(args.background) === undefined) {
      colorWarnings.push(
        `Could not parse background "${args.background}" (expected hex like '#06080c'); used the default.`,
      );
    }

    const { builder, outputPath } = await buildSdfNetwork(ctx, args, colorA, colorB, bg);
    builder.warnings.push(...colorWarnings);

    const controls: ControlSpec[] = args.expose_controls
      ? [
          { name: "CameraZ", type: "float", min: 1, max: 12, default: args.camera_z },
          { name: "Speed", type: "float", min: 0, max: 4, default: args.speed },
          { name: "StepCount", type: "int", min: 8, max: 256, default: args.step_count },
          { name: "Intensity", type: "float", min: 0, max: 3, default: args.intensity },
          { name: "Rotate", type: "float", min: -6.28, max: 6.28, default: args.rotate_scene },
          { name: "ColorA", type: "rgb", default: toHex(colorA) },
          { name: "ColorB", type: "rgb", default: toHex(colorB) },
          { name: "Background", type: "rgb", default: toHex(bg) },
        ]
      : [];

    return finalize(ctx, {
      summary: `Created SDF field with ${args.primitives.length} primitive(s) (GLSL raymarcher).`,
      builder,
      outputPath,
      controls,
      capturePreviewImage: true,
      extra: {
        primitives: args.primitives,
        camera_z: args.camera_z,
        camera_target: args.camera_target,
        speed: args.speed,
        step_count: args.step_count,
        intensity: args.intensity,
        rotate_scene: args.rotate_scene,
        light_direction: args.light_direction,
        color_a: colorA,
        color_b: colorB,
        background: bg,
        resolution: args.resolution,
      },
    });
  });
}

export const registerCreateSdfField: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_sdf_field",
    {
      title: "Create SDF field",
      description:
        "Build a programmable signed-distance-field (SDF) raymarcher in TouchDesigner as a self-contained GLSL TOP. Compose a CSG tree of sphere / box / torus primitives with union / intersect / subtract boolean ops and optional smooth blending. Exposes live CameraZ / Speed / StepCount / Intensity / Rotate / ColorA / ColorB / Background controls and previews the output.",
      inputSchema: createSdfFieldSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createSdfFieldImpl(ctx, args),
  );
};
