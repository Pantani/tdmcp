import { z } from "zod";
import {
  compileShaderParkToTouchDesigner,
  type ShaderParkUniform,
} from "../../integrations/shaderPark.js";
import { type ControlSpec, toTdCustomParameterName } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

const DEFAULT_CODE = `setMaxIterations(96);
rotateY(time * 0.25);
color(vec3(0.2, 0.8, 1.0));
sphere(0.45);`;

const SHADER_PARK_VERTEX_SHADER = `out Vertex
{
  vec4 color;
  vec3 worldSpacePos;
  vec3 worldSpaceNorm;
  flat int cameraIndex;
  vec2 texCoord0;
  vec3 sculptureCenter;
} oVert;

void main()
{
  vec4 worldSpacePos = TDDeform(P);
  oVert.color = Cd;
  oVert.worldSpacePos = worldSpacePos.xyz;
  oVert.worldSpaceNorm = normalize(TDDeformNorm(N));
  oVert.cameraIndex = TDCameraIndex();
  oVert.texCoord0 = uv[0].st;
  oVert.sculptureCenter = vec3(0.0);
  gl_Position = TDWorldToProj(worldSpacePos);
}`;

const MATERIAL_UNIFORMS: ShaderParkUniform[] = [
  { name: "uShadowStrength", type: "float", value: 0 },
  { name: "uShadowColor", type: "vec3", value: [0, 0, 0] },
  { name: "uBaseColor", type: "vec4", value: [1, 1, 1, 1] },
  { name: "uMetallic", type: "float", value: 0 },
  { name: "uRoughness", type: "float", value: 0.7 },
  { name: "uSpecularLevel", type: "float", value: 1 },
  { name: "uAmbientOcclusion", type: "float", value: 1 },
  { name: "cameraPosition", type: "vec3", value: [0, 0, 4] },
  { name: "useTDLighting", type: "float", value: 0 },
];

const BASE_UNIFORMS = new Set([
  "time",
  "opacity",
  "_scale",
  "mouse",
  "stepSize",
  "resolution",
  ...MATERIAL_UNIFORMS.map((uniform) => uniform.name),
]);

const uniformValueSchema = z.union([z.coerce.number(), z.array(z.coerce.number()).min(1).max(4)]);

export const createShaderParkSchema = z.object({
  code: z
    .string()
    .default(DEFAULT_CODE)
    .describe(
      "Shader Park sculpture code. Example: `let size = input(); sphere(size);`. The code is compiled with shader-park-core and stored in a Text DAT for editing.",
    ),
  name: z
    .string()
    .default("shader_park_sculpture")
    .describe("Name of the created baseCOMP container."),
  uniform_values: z
    .record(z.string(), uniformValueSchema)
    .default({})
    .describe(
      'Initial values for Shader Park `input()` uniforms by name, e.g. `{ "size": 0.55 }`.',
    ),
  speed: z.coerce
    .number()
    .default(1)
    .describe("Animation speed multiplier for the Shader Park `time` uniform."),
  scale: z.coerce.number().positive().default(1).describe("Initial `_scale` uniform value."),
  opacity: z.coerce.number().min(0).max(1).default(1).describe("Initial opacity uniform value."),
  step_size: z.coerce
    .number()
    .positive()
    .default(0.85)
    .describe("Initial Shader Park raymarch stepSize uniform value."),
  camera_z: z.coerce.number().positive().default(4).describe("Camera distance from the sculpture."),
  resolution: z
    .tuple([z.coerce.number().int().positive(), z.coerce.number().int().positive()])
    .default([1280, 720])
    .describe("Render TOP resolution [width, height]."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe(
      "Expose Speed / Scale / Opacity / StepSize / CameraZ plus any float Shader Park inputs.",
    ),
  parent_path: z.string().default("/project1").describe("Parent COMP path for the new sculpture."),
});
type CreateShaderParkArgs = z.infer<typeof createShaderParkSchema>;
type UniformValue = z.infer<typeof uniformValueSchema>;

function arrayValue(value: UniformValue | ShaderParkUniform["value"] | undefined): number[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "number") return [value];
  return [];
}

function componentCountForUniform(uniform: ShaderParkUniform): number | undefined {
  const vectorMatch = /^vec([2-4])$/.exec(uniform.type);
  if (vectorMatch) return Number(vectorMatch[1]);
  const defaults = arrayValue(uniform.value);
  return defaults.length || undefined;
}

function vectorComponents(
  uniform: ShaderParkUniform,
  customValue: UniformValue | undefined,
  defaultValue: ShaderParkUniform["value"] = uniform.value,
): number[] {
  const customValues = arrayValue(customValue);
  const defaults = arrayValue(defaultValue);
  const componentCount =
    componentCountForUniform(uniform) ?? Math.max(customValues.length, defaults.length);

  return Array.from(
    { length: componentCount },
    (_, component) => customValues[component] ?? defaults[component] ?? 0,
  );
}

function scalarValue(
  uniform: ShaderParkUniform,
  args: CreateShaderParkArgs,
  customValue: UniformValue | undefined,
): number {
  if (typeof customValue === "number") return customValue;
  if (Array.isArray(customValue) && typeof customValue[0] === "number") return customValue[0];
  if (uniform.name === "opacity") return args.opacity;
  if (uniform.name === "_scale") return args.scale;
  if (uniform.name === "stepSize") return args.step_size;
  if (typeof uniform.value === "number") return uniform.value;
  return 0;
}

function controlNameForUniform(uniformName: string): string {
  const words = uniformName.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const name = (words.length ? words : [uniformName])
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join("")
    .replace(/[^a-zA-Z0-9]/g, "");
  const safe = name || "Input";
  return /^\d/.test(safe) ? `Input${safe}` : safe;
}

function expressionForUniform(
  uniform: ShaderParkUniform,
  args: CreateShaderParkArgs,
  fallback: number,
): string | undefined {
  if (uniform.name === "time") {
    return `absTime.seconds * (parent().par.Speed.eval() if hasattr(parent().par, 'Speed') else ${args.speed})`;
  }
  if (uniform.name === "opacity") {
    return `parent().par.Opacity.eval() if hasattr(parent().par, 'Opacity') else ${fallback}`;
  }
  if (uniform.name === "_scale") {
    return `parent().par.Scale.eval() if hasattr(parent().par, 'Scale') else ${fallback}`;
  }
  if (uniform.name === "stepSize") {
    return `parent().par.Stepsize.eval() if hasattr(parent().par, 'Stepsize') else ${fallback}`;
  }
  if (!BASE_UNIFORMS.has(uniform.name) && uniform.type === "float") {
    const control = toTdCustomParameterName(controlNameForUniform(uniform.name));
    return `parent().par.${control}.eval() if hasattr(parent().par, '${control}') else ${fallback}`;
  }
  return undefined;
}

function expressionForUniformComponent(
  uniform: ShaderParkUniform,
  args: CreateShaderParkArgs,
  component: number,
  fallback: number,
): string | undefined {
  if (uniform.name === "cameraPosition" && component === 2) {
    return `parent().op('cam').par.tz.eval() if parent().op('cam') else ${fallback}`;
  }
  if (component !== 0) return undefined;
  return expressionForUniform(uniform, args, fallback);
}

function uniformComponents(uniform: ShaderParkUniform, args: CreateShaderParkArgs): number[] {
  const custom = args.uniform_values[uniform.name];
  if (uniform.name === "resolution") return [...args.resolution];
  if (uniform.name === "mouse") return vectorComponents(uniform, custom, [0.5, 0.5, 0.5]);
  if (uniform.type === "float") return [scalarValue(uniform, args, custom)];
  return vectorComponents(uniform, custom);
}

function buildUniformScript(
  mat: string,
  uniforms: ShaderParkUniform[],
  args: CreateShaderParkArgs,
): string {
  const lines = [
    `_m = op(${q(mat)})`,
    `_m.seq.vec.numBlocks = max(_m.seq.vec.numBlocks, ${uniforms.length})`,
  ];
  uniforms.forEach((uniform, index) => {
    const components = uniformComponents(uniform, args);
    lines.push(`_m.par.vec${index}name = ${q(uniform.name)}`);
    for (const [component, suffix] of ["valuex", "valuey", "valuez", "valuew"].entries()) {
      const value = components[component];
      if (value === undefined && component > 0) continue;
      const fallback = value ?? 0;
      const expr = expressionForUniformComponent(uniform, args, component, fallback);
      if (expr) {
        lines.push(`_m.par.vec${index}${suffix}.expr = ${q(expr)}`);
      } else {
        lines.push(`_m.par.vec${index}${suffix} = ${fallback}`);
      }
    }
  });
  return lines.join("\n");
}

function customFloatUniforms(uniforms: ShaderParkUniform[]): ShaderParkUniform[] {
  return uniforms.filter((uniform) => !BASE_UNIFORMS.has(uniform.name) && uniform.type === "float");
}

function assignMaterialDefaults(
  uniforms: ShaderParkUniform[],
  cameraZ: number,
): ShaderParkUniform[] {
  const names = new Set(uniforms.map((uniform) => uniform.name));
  return [
    ...uniforms,
    ...MATERIAL_UNIFORMS.filter((uniform) => !names.has(uniform.name)).map((uniform) =>
      uniform.name === "cameraPosition" ? { ...uniform, value: [0, 0, cameraZ] } : uniform,
    ),
  ];
}

function buildControls(
  uniforms: ShaderParkUniform[],
  args: CreateShaderParkArgs,
  cameraPath: string,
): ControlSpec[] {
  if (!args.expose_controls) return [];
  return [
    { name: "Speed", type: "float", min: 0, max: 4, default: args.speed },
    { name: "Scale", type: "float", min: 0.05, max: 5, default: args.scale },
    { name: "Opacity", type: "float", min: 0, max: 1, default: args.opacity },
    { name: "StepSize", type: "float", min: 0.05, max: 2, default: args.step_size },
    {
      name: "CameraZ",
      type: "float",
      min: 0.5,
      max: 20,
      default: args.camera_z,
      bind_to: [`${cameraPath}.tz`],
    },
    ...customFloatUniforms(uniforms).map((uniform) => ({
      name: controlNameForUniform(uniform.name),
      type: "float" as const,
      min: -10,
      max: 10,
      default: scalarValue(uniform, args, args.uniform_values[uniform.name]),
    })),
  ];
}

export async function createShaderParkImpl(ctx: ToolContext, args: CreateShaderParkArgs) {
  return runBuild(async () => {
    const compiled = await compileShaderParkToTouchDesigner(args.code);
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);

    const geo = await builder.add("geometryCOMP", "geo");
    const bounds = await builder.add("boxSOP", "bounds", { sizex: 3, sizey: 3, sizez: 3 }, geo);
    await builder.python(`_s = op(${q(bounds)})\n_s.render = True\n_s.display = True`);

    const mat = await builder.add("glslMAT", "shaderpark_mat");
    const baseColorMap = await builder.add("constantTOP", "base_color_map", {
      colorr: 1,
      colorg: 1,
      colorb: 1,
      alpha: 1,
    });
    const codeDat = await builder.add("textDAT", "shaderpark_code");
    const vertexDat = await builder.add("textDAT", "shaderpark_vertex");
    const pixelDat = await builder.add("textDAT", "shaderpark_pixel");
    await builder.python(
      [
        `op(${q(codeDat)}).text = ${q(args.code)}`,
        `op(${q(vertexDat)}).text = ${q(SHADER_PARK_VERTEX_SHADER)}`,
        `op(${q(pixelDat)}).text = ${q(compiled.pixelShader)}`,
        `_m = op(${q(mat)})`,
        `_m.par.vdat = op(${q(vertexDat)}).name`,
        `_m.par.pdat = op(${q(pixelDat)}).name`,
        `_m.par.sampler0top = ${q(baseColorMap)}`,
        '_m.par.sampler0name = "sBaseColorMap"',
      ].join("\n"),
    );
    await builder.python(
      buildUniformScript(mat, assignMaterialDefaults(compiled.uniforms, args.camera_z), args),
    );
    await builder.python(`op(${q(geo)}).par.material = ${q(mat)}`);

    const cam = await builder.add("cameraCOMP", "cam", { tz: args.camera_z });
    const light = await builder.add("lightCOMP", "light", { tx: 3, ty: 4, tz: 5 });
    const render = await builder.add("renderTOP", "render", {
      camera: cam,
      geometry: geo,
      lights: light,
      outputresolution: "custom",
      resolutionw: args.resolution[0],
      resolutionh: args.resolution[1],
    });
    const out = await builder.add("nullTOP", "out1");
    await builder.connect(render, out);

    const cooker = await builder.add("executeDAT", "cooker");
    await builder.python(
      `_c = op(${q(cooker)})\n_c.text = "def onFrameStart(frame):\\n\\tparent().op('out1').cook(force=True)\\n\\treturn\\n"\n_c.par.framestart = True\n_c.par.active = True`,
    );

    const controls = buildControls(compiled.uniforms, args, cam);

    return finalize(ctx, {
      summary: "Compiled Shader Park sculpture code into a TouchDesigner GLSL MAT render network.",
      builder,
      outputPath: out,
      controls,
      capturePreviewImage: true,
      extra: {
        code_dat: codeDat,
        vertex_dat: vertexDat,
        pixel_dat: pixelDat,
        shader_park: {
          code: args.code,
          uniform_names: compiled.uniforms.map((uniform) => uniform.name),
          custom_uniforms: customFloatUniforms(compiled.uniforms).map((uniform) => uniform.name),
          source: "shader-park-core",
        },
        resolution: args.resolution,
      },
    });
  });
}

export const registerCreateShaderPark: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_shader_park",
    {
      title: "Create Shader Park sculpture",
      description:
        "Compile Shader Park JavaScript sculpture code with shader-park-core and instantiate it as a self-contained TouchDesigner GLSL MAT scene with live controls. Use the companion shader-park:tox script when you specifically want the official Shader Park .tox plugin workflow.",
      inputSchema: createShaderParkSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createShaderParkImpl(ctx, args),
  );
};
