import { z } from "zod";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const SAMPLER_TYPES = new Set(["sampler2D", "sampler2DArray", "samplerCube"]);

const UniformSchema = z.object({
  name: z.string().describe("Uniform name as declared in the shader."),
  type: z
    .enum([
      "float",
      "vec2",
      "vec3",
      "vec4",
      "int",
      "ivec2",
      "ivec3",
      "ivec4",
      "sampler2D",
      "sampler2DArray",
      "samplerCube",
    ])
    .describe("GLSL uniform type. Numeric → Vectors page; sampler* → Samplers page."),
  default_value: z
    .string()
    .optional()
    .describe("Comma-separated components for numeric uniforms (e.g. '1,0,0,1')."),
  top_path: z
    .string()
    .optional()
    .describe("For sampler* uniforms: TOP path to bind into the Samplers sequence."),
});

export const createGlslMaterialSchema = z.object({
  parent_path: z.string().describe("Parent COMP to create the GLSL MAT + DATs inside."),
  name: z.string().optional().describe("Name for the GLSL MAT (default 'glsl_mat1')."),
  pixel_shader: z
    .string()
    .min(1)
    .describe("GLSL pixel/fragment shader source. Must declare `out vec4 fragColor;`."),
  vertex_shader: z.string().optional().describe("Optional GLSL vertex shader source."),
  geometry_shader: z.string().optional().describe("Optional GLSL geometry shader source."),
  uniforms: z
    .array(UniformSchema)
    .optional()
    .describe("Optional uniform declarations to best-effort bind on the GLSL MAT."),
  glsl_version: z
    .enum(["330", "400", "410", "420", "430", "440", "450", "460"])
    .default("330")
    .describe("GLSL Version par value."),
  two_sided: z.boolean().default(false).describe("twoside par."),
  lighting_space: z.enum(["world", "camera"]).default("world").describe("lightingspace par."),
});

type CreateGlslMaterialArgs = z.infer<typeof createGlslMaterialSchema>;

const q = (value: string): string => JSON.stringify(value);

/** Scan shader sources for known TD GLSL footguns. Returns warnings; never rewrites source. */
function scanShaderFootguns(args: CreateGlslMaterialArgs): string[] {
  const warnings: string[] = [];
  const pix = args.pixel_shader;
  const hasOutFragColor = /\bout\s+vec4\s+fragColor\b/.test(pix);
  const hasLegacyGlFragColor = /\bgl_FragColor\b/.test(pix);
  if (!hasOutFragColor && !hasLegacyGlFragColor) {
    warnings.push(
      "Pixel shader does not declare `out vec4 fragColor;` (or use legacy `gl_FragColor`); TD GLSL MAT will fail to compile.",
    );
  }
  const allSrc = [args.pixel_shader, args.vertex_shader ?? "", args.geometry_shader ?? ""].join(
    "\n",
  );
  if (/#\s*define\s+F1\b/.test(allSrc) || /#\s*define\s+F2\b/.test(allSrc)) {
    warnings.push(
      "Shader source defines F1/F2 which collide with TD's GLSL preamble — rename these macros.",
    );
  }
  if (/\buTime\b/.test(allSrc) && !/\buniform\s+float\s+uTime\b/.test(allSrc)) {
    warnings.push(
      "Shader references `uTime` but does not declare it as a uniform — TD has no built-in uTime; add `uniform float uTime;` and bind it yourself.",
    );
  }
  return warnings;
}

export async function createGlslMaterialImpl(ctx: ToolContext, args: CreateGlslMaterialArgs) {
  const desiredName = args.name ?? "glsl_mat1";
  return guardTd(
    async () => {
      const warnings = scanShaderFootguns(args);

      const mat = await ctx.client.createNode({
        parent_path: args.parent_path,
        type: "glslMAT",
        name: desiredName,
      });
      const matName = mat.name || desiredName;

      const pixName = `${matName}_pix`;
      const pix = await ctx.client.createNode({
        parent_path: args.parent_path,
        type: "textDAT",
        name: pixName,
      });

      const wiring: string[] = [
        `op(${q(pix.path)}).text = ${q(args.pixel_shader)}`,
        `op(${q(mat.path)}).par.pixeldat = ${q(pix.name || pixName)}`,
      ];

      let vertexDat: string | undefined;
      if (args.vertex_shader) {
        const vertName = `${matName}_vert`;
        const vert = await ctx.client.createNode({
          parent_path: args.parent_path,
          type: "textDAT",
          name: vertName,
        });
        vertexDat = vert.path;
        wiring.push(`op(${q(vert.path)}).text = ${q(args.vertex_shader)}`);
        wiring.push(`op(${q(mat.path)}).par.vertexdat = ${q(vert.name || vertName)}`);
      }

      let geometryDat: string | undefined;
      if (args.geometry_shader) {
        const geoName = `${matName}_geo`;
        const geo = await ctx.client.createNode({
          parent_path: args.parent_path,
          type: "textDAT",
          name: geoName,
        });
        geometryDat = geo.path;
        wiring.push(`op(${q(geo.path)}).text = ${q(args.geometry_shader)}`);
        wiring.push(`op(${q(mat.path)}).par.geometrydat = ${q(geo.name || geoName)}`);
      }

      // Static MAT params — set inside try/except so an unexpected internal name
      // doesn't abort the whole payload.
      wiring.push("m = op(" + q(mat.path) + ")");
      wiring.push(`try: m.par.glslversion = ${q(args.glsl_version)}`);
      wiring.push("except Exception: pass");
      wiring.push(`try: m.par.twoside = ${args.two_sided ? "True" : "False"}`);
      wiring.push("except Exception: pass");
      wiring.push(`try: m.par.lightingspace = ${q(args.lighting_space)}`);
      wiring.push("except Exception: pass");

      await ctx.client.executePythonScript(wiring.join("\n"), false);

      if (args.uniforms && args.uniforms.length > 0) {
        const numericSpecs = args.uniforms
          .filter((u) => !SAMPLER_TYPES.has(u.type))
          .map((u) => ({
            name: u.name,
            comps: (u.default_value ?? "")
              .split(",")
              .map((s) => Number(s.trim()))
              .filter((n) => Number.isFinite(n))
              .slice(0, 4),
          }))
          .filter((s) => s.comps.length > 0);

        const samplerSpecs = args.uniforms
          .filter((u) => SAMPLER_TYPES.has(u.type))
          .map((u) => ({ name: u.name, top: u.top_path ?? "" }));

        const samplerMissing = samplerSpecs.filter((s) => !s.top);
        if (samplerMissing.length > 0) {
          warnings.push(
            `sampler uniform(s) ${samplerMissing.map((s) => s.name).join(", ")} missing top_path; wire them manually on the GLSL MAT Samplers page.`,
          );
        }
        const samplerBound = samplerSpecs.filter((s) => s.top);

        if (numericSpecs.length > 0 || samplerBound.length > 0) {
          const bind: string[] = [`g = op(${q(mat.path)})`];
          if (numericSpecs.length > 0) {
            bind.push(`_specs = ${JSON.stringify(numericSpecs)}`);
            bind.push("try:");
            bind.push("    g.seq.vec.numBlocks = max(g.seq.vec.numBlocks, len(_specs))");
            bind.push("    for i, s in enumerate(_specs):");
            bind.push("        try: setattr(g.par, 'vec%dname' % i, s['name'])");
            bind.push("        except Exception: pass");
            bind.push("        for axis, val in zip('xyzw', s['comps']):");
            bind.push("            try: setattr(g.par, 'vec%dvalue%s' % (i, axis), val)");
            bind.push("            except Exception: pass");
            bind.push("except Exception: pass");
          }
          if (samplerBound.length > 0) {
            bind.push(`_samps = ${JSON.stringify(samplerBound)}`);
            bind.push("try:");
            bind.push("    g.seq.samp.numBlocks = max(g.seq.samp.numBlocks, len(_samps))");
            bind.push("    for i, s in enumerate(_samps):");
            bind.push("        try: setattr(g.par, 'samp%dname' % i, s['name'])");
            bind.push("        except Exception: pass");
            bind.push("        try: setattr(g.par, 'samp%dtop' % i, s['top'])");
            bind.push("        except Exception: pass");
            bind.push("except Exception: pass");
          }
          try {
            await ctx.client.executePythonScript(bind.join("\n"), false);
          } catch {
            warnings.push(
              "Could not auto-bind uniforms; set them on the GLSL MAT's Vectors / Samplers pages manually.",
            );
          }
        }
      }

      return {
        glslMat: { path: mat.path, name: mat.name || matName },
        pixelDat: pix.path,
        vertexDat,
        geometryDat,
        warnings,
      };
    },
    (result) => jsonResult(`Created GLSL MAT at ${result.glslMat.path}.`, result),
  );
}

export const registerCreateGlslMaterial: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_glsl_material",
    {
      title: "Create GLSL material",
      description:
        "Create a GLSL MAT under parent_path for custom-shaded geometry. The pixel/vertex/(optional) geometry shader source is placed in companion Text DATs (`<name>_pix`/`_vert`/`_geo`) and wired to the GLSL MAT's pixel/vertex/geometry parameters; numeric uniforms are best-effort bound on the Vectors sequence and samplers on the Samplers sequence. Pixel shader must declare `out vec4 fragColor;`. Returns the GLSL MAT path, the DAT paths, and warnings for known TD GLSL footguns (missing fragColor, F1/F2 preamble collision, undeclared uTime, sampler bindings needing manual wiring). Artist assigns the MAT to a Geometry COMP via its `material` par.",
      inputSchema: createGlslMaterialSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createGlslMaterialImpl(ctx, args),
  );
};
