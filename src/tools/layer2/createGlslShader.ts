import { z } from "zod";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const UniformSchema = z.object({
  name: z.string(),
  type: z.enum(["float", "vec2", "vec3", "vec4", "int", "sampler2D"]),
  default_value: z.string().optional(),
});

export const createGlslShaderSchema = z.object({
  parent_path: z.string().describe("Parent COMP to create the GLSL TOP inside."),
  name: z.string().optional().describe("Name for the GLSL TOP (default 'glsl1')."),
  fragment_shader: z.string().min(1).describe("GLSL fragment (pixel) shader source."),
  vertex_shader: z.string().optional().describe("Optional GLSL vertex shader source."),
  uniforms: z
    .array(UniformSchema)
    .optional()
    .describe("Optional uniform declarations to best-effort bind on the GLSL TOP."),
  resolution: z.enum(["720p", "1080p", "4K", "input"]).default("input"),
});
type CreateGlslShaderArgs = z.infer<typeof createGlslShaderSchema>;

const RESOLUTIONS = {
  "720p": [1280, 720],
  "1080p": [1920, 1080],
  "4K": [3840, 2160],
} as const;

const q = (value: string): string => JSON.stringify(value);

export async function createGlslShaderImpl(ctx: ToolContext, args: CreateGlslShaderArgs) {
  const desiredName = args.name ?? "glsl1";
  return guardTd(
    async () => {
      const warnings: string[] = [];
      const glsl = await ctx.client.createNode({
        parent_path: args.parent_path,
        type: "glslTOP",
        name: desiredName,
      });
      const glslName = glsl.name || desiredName;

      const fragName = `${glslName}_frag`;
      const frag = await ctx.client.createNode({
        parent_path: args.parent_path,
        type: "textDAT",
        name: fragName,
      });

      const wiring = [
        `op(${q(frag.path)}).text = ${q(args.fragment_shader)}`,
        `op(${q(glsl.path)}).par.pixeldat = ${q(frag.name || fragName)}`,
      ];

      let vertexPath: string | undefined;
      if (args.vertex_shader) {
        const vertName = `${glslName}_vert`;
        const vert = await ctx.client.createNode({
          parent_path: args.parent_path,
          type: "textDAT",
          name: vertName,
        });
        vertexPath = vert.path;
        wiring.push(`op(${q(vert.path)}).text = ${q(args.vertex_shader)}`);
        wiring.push(`op(${q(glsl.path)}).par.vertexdat = ${q(vert.name || vertName)}`);
      }

      await ctx.client.executePythonScript(wiring.join("\n"), false);

      if (args.uniforms && args.uniforms.length > 0) {
        const names = JSON.stringify(args.uniforms.map((u) => u.name));
        const values = JSON.stringify(args.uniforms.map((u) => u.default_value ?? ""));
        const bind = [
          `g = op(${q(glsl.path)})`,
          `for i, nm in enumerate(${names}):`,
          "    try: setattr(g.par, 'uniname' + str(i), nm)",
          "    except Exception: pass",
          `for i, v in enumerate(${values}):`,
          "    try:",
          "        if v != '': setattr(g.par, 'value' + str(i) + 'x', v)",
          "    except Exception: pass",
        ].join("\n");
        try {
          await ctx.client.executePythonScript(bind, false);
        } catch {
          warnings.push(
            "Could not auto-bind uniforms; declare them in the shader and set them on the GLSL TOP manually.",
          );
        }
      }

      if (args.resolution !== "input") {
        const [width, height] = RESOLUTIONS[args.resolution];
        await ctx.client.updateNodeParameters(glsl.path, {
          outputresolution: "custom",
          resolutionw: width,
          resolutionh: height,
        });
      }

      return { glsl, fragmentDat: frag.path, vertexDat: vertexPath, warnings };
    },
    (result) => jsonResult(`Created GLSL TOP at ${result.glsl.path}.`, result),
  );
}

export const registerCreateGlslShader: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_glsl_shader",
    {
      title: "Create GLSL shader",
      description:
        "Create a GLSL TOP with a fragment shader (and optional vertex shader) supplied via Text DATs, with optional uniform binding and output resolution.",
      inputSchema: createGlslShaderSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createGlslShaderImpl(ctx, args),
  );
};
