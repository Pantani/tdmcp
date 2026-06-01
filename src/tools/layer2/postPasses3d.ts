import { z } from "zod";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { connectNodesViaBridge } from "./connectHelper.js";

export const postPasses3dSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the post-pass container."),
  name: z.string().default("post_passes_3d").describe("Name of the created baseCOMP container."),
  color_top: z.string().describe("Absolute path of the beauty-pass TOP (Render TOP / Null TOP)."),
  depth_top: z
    .string()
    .default("")
    .describe(
      "Absolute path of the depth TOP. Empty = auto-derive from a sibling depthTOP when color is a renderTOP.",
    ),
  normal_top: z
    .string()
    .default("")
    .describe("Absolute path of the normal-AOV TOP. Empty = SSR is skipped (warning)."),
  velocity_top: z
    .string()
    .default("")
    .describe(
      "Absolute path of the velocity-AOV TOP. Empty = motion blur falls back to directional.",
    ),
  ssao_enable: z.boolean().default(true),
  ssao_radius: z.number().min(0.001).max(0.5).default(0.05),
  ssao_intensity: z.number().min(0).max(4).default(1.0),
  ssr_enable: z.boolean().default(false),
  ssr_intensity: z.number().min(0).max(2).default(0.5),
  dof_enable: z.boolean().default(false),
  dof_focus: z.number().min(0).max(1).default(0.3),
  dof_aperture: z.number().min(0).max(0.1).default(0.02),
  motion_blur_enable: z.boolean().default(false),
  motion_blur_amount: z.number().min(0).max(1).default(0.3),
  resolution: z.tuple([z.number(), z.number()]).default([1280, 720]),
});

type PostPasses3dArgs = z.infer<typeof postPasses3dSchema>;

const q = (value: string): string => JSON.stringify(value);

const SSAO_FRAG = `// SSAO — in0: prev color, in1: depth, (in2: normal optional)
out vec4 fragColor;
uniform float uRadius;
uniform float uIntensity;
float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
void main(){
  vec2 uv = vUV.st;
  vec4 c = texture(sTD2DInputs[0], uv);
  float d0 = texture(sTD2DInputs[1], uv).r;
  float occ = 0.0;
  const int N = 8;
  for (int i = 0; i < N; i++) {
    float a = 6.2831 * float(i) / float(N);
    vec2 o = vec2(cos(a), sin(a)) * uRadius * (0.5 + 0.5 * h(uv + float(i)));
    float ds = texture(sTD2DInputs[1], uv + o).r;
    occ += step(ds + 0.0008, d0);
  }
  occ = 1.0 - (occ / float(N)) * uIntensity;
  fragColor = TDOutputSwizzle(vec4(c.rgb * occ, c.a));
}
`;

const SSR_FRAG = `// SSR — in0: prev color, in1: depth, in2: normal
out vec4 fragColor;
uniform float uIntensity;
void main(){
  vec2 uv = vUV.st;
  vec4 c = texture(sTD2DInputs[0], uv);
  float d0 = texture(sTD2DInputs[1], uv).r;
  vec3 n = texture(sTD2DInputs[2], uv).rgb * 2.0 - 1.0;
  vec2 dir = normalize(n.xy + vec2(1e-4));
  vec4 hit = c;
  float step = 1.0 / 32.0;
  for (int i = 1; i <= 16; i++) {
    vec2 p = uv + dir * step * float(i);
    if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) break;
    float ds = texture(sTD2DInputs[1], p).r;
    if (ds < d0 - 0.001) { hit = texture(sTD2DInputs[0], p); break; }
  }
  fragColor = TDOutputSwizzle(vec4(mix(c.rgb, hit.rgb, uIntensity), c.a));
}
`;

const DOF_FRAG = `// DOF — in0: prev color, in1: depth
out vec4 fragColor;
uniform float uFocus;
uniform float uAperture;
void main(){
  vec2 uv = vUV.st;
  float d = texture(sTD2DInputs[1], uv).r;
  float coc = abs(d - uFocus) * uAperture;
  vec4 acc = texture(sTD2DInputs[0], uv);
  const int N = 6;
  for (int i = 0; i < N; i++) {
    float a = 6.2831 * float(i) / float(N);
    vec2 o = vec2(cos(a), sin(a)) * coc;
    acc += texture(sTD2DInputs[0], uv + o);
  }
  acc /= float(N + 1);
  fragColor = TDOutputSwizzle(acc);
}
`;

const MB_FRAG_WITH_VEL = `// Motion blur — in0: prev color, in1: velocity
out vec4 fragColor;
uniform float uAmount;
void main(){
  vec2 uv = vUV.st;
  vec2 v = (texture(sTD2DInputs[1], uv).rg * 2.0 - 1.0) * uAmount;
  vec4 acc = vec4(0.0);
  const int N = 8;
  for (int i = 0; i < N; i++) {
    float t = float(i) / float(N - 1) - 0.5;
    acc += texture(sTD2DInputs[0], uv + v * t);
  }
  fragColor = TDOutputSwizzle(acc / float(N));
}
`;

const MB_FRAG_DIRECTIONAL = `// Motion blur (directional fallback — no velocity input)
out vec4 fragColor;
uniform float uAmount;
void main(){
  vec2 uv = vUV.st;
  vec2 v = vec2(uAmount, 0.0);
  vec4 acc = vec4(0.0);
  const int N = 8;
  for (int i = 0; i < N; i++) {
    float t = float(i) / float(N - 1) - 0.5;
    acc += texture(sTD2DInputs[0], uv + v * t);
  }
  fragColor = TDOutputSwizzle(acc / float(N));
}
`;

interface PassInfo {
  name: string;
  path: string;
}

export async function postPasses3dImpl(ctx: ToolContext, args: PostPasses3dArgs) {
  return guardTd(
    async () => {
      const warnings: string[] = [];

      // 1. Create the container.
      const container = await ctx.client.createNode({
        parent_path: args.parent_path,
        type: "baseCOMP",
        name: args.name,
      });
      const containerPath = container.path;

      // 2. Pull in the color input via selectTOP.
      const selColor = await ctx.client.createNode({
        parent_path: containerPath,
        type: "selectTOP",
        name: "sel_color",
      });
      await ctx.client.updateNodeParameters(selColor.path, { top: args.color_top });

      // 3. Resolve depth.
      let depthSourcePath = args.depth_top;
      let autoDepthPath: string | undefined;
      if (!depthSourcePath && args.color_top.match(/\/render\d*$/)) {
        try {
          const depthAuto = await ctx.client.createNode({
            parent_path: args.parent_path,
            type: "depthTOP",
            name: "post_passes_3d_depth",
          });
          autoDepthPath = depthAuto.path;
          // Best-effort param name; UNVERIFIED.
          await ctx.client
            .executePythonScript(
              `try:\n    op(${q(depthAuto.path)}).par.rendertop = ${q(args.color_top)}\nexcept Exception as e:\n    pass\n`,
              false,
            )
            .catch(() => {
              warnings.push("Could not set depthTOP.par.rendertop (param name unverified).");
            });
          depthSourcePath = depthAuto.path;
        } catch {
          warnings.push(
            "Failed to auto-create sibling depthTOP; depth-dependent passes will degrade.",
          );
        }
      }

      let selDepthPath: string | undefined;
      if (depthSourcePath) {
        const selDepth = await ctx.client.createNode({
          parent_path: containerPath,
          type: "selectTOP",
          name: "sel_depth",
        });
        await ctx.client.updateNodeParameters(selDepth.path, { top: depthSourcePath });
        selDepthPath = selDepth.path;
      } else if (args.ssao_enable || args.dof_enable) {
        warnings.push(
          "No depth_top provided and color_top is not a render TOP; SSAO/DOF will read constant depth.",
        );
      }

      let selNormalPath: string | undefined;
      if (args.normal_top) {
        const selNormal = await ctx.client.createNode({
          parent_path: containerPath,
          type: "selectTOP",
          name: "sel_normal",
        });
        await ctx.client.updateNodeParameters(selNormal.path, { top: args.normal_top });
        selNormalPath = selNormal.path;
      }

      let selVelocityPath: string | undefined;
      if (args.velocity_top) {
        const selVel = await ctx.client.createNode({
          parent_path: containerPath,
          type: "selectTOP",
          name: "sel_velocity",
        });
        await ctx.client.updateNodeParameters(selVel.path, { top: args.velocity_top });
        selVelocityPath = selVel.path;
      }

      const [resW, resH] = args.resolution;
      const passes: PassInfo[] = [];
      let prevPath = selColor.path;

      // Helper: create a glslTOP + textDAT, wire shader, set resolution + uniforms.
      const buildPass = async (
        passName: string,
        shaderSource: string,
        extraInputs: string[],
        uniforms: { name: string; value: number }[],
      ): Promise<string> => {
        const glsl = await ctx.client.createNode({
          parent_path: containerPath,
          type: "glslTOP",
          name: passName,
        });
        const fragDat = await ctx.client.createNode({
          parent_path: containerPath,
          type: "textDAT",
          name: `${passName}_frag`,
        });
        const setupScript = [
          `op(${q(fragDat.path)}).text = ${q(shaderSource)}`,
          `op(${q(glsl.path)}).par.pixeldat = ${q(fragDat.name || `${passName}_frag`)}`,
        ].join("\n");
        await ctx.client.executePythonScript(setupScript, false);

        // Wire previous color first (input 0) — required; fail the build if it fails.
        await connectNodesViaBridge(ctx.client, prevPath, glsl.path, 0, 0);
        for (let i = 0; i < extraInputs.length; i++) {
          const src = extraInputs[i];
          if (!src) continue;
          await connectNodesViaBridge(ctx.client, src, glsl.path, 0, i + 1).catch(
            (err: unknown) => {
              warnings.push(
                `Failed to wire ${src} → ${glsl.path} (input ${i + 1}): ${err instanceof Error ? err.message : String(err)}`,
              );
            },
          );
        }

        // Resolution best-effort.
        try {
          await ctx.client.updateNodeParameters(glsl.path, {
            outputresolution: "custom",
            resolutionw: resW,
            resolutionh: resH,
          });
        } catch {
          warnings.push(`Could not set resolution on ${glsl.path}.`);
        }

        // Bind uniforms via Vectors sequence (vec<i>name + vec<i>valuex).
        if (uniforms.length > 0) {
          const specs = uniforms.map((u) => ({ name: u.name, value: u.value }));
          const bind = [
            `g = op(${q(glsl.path)})`,
            `_specs = ${JSON.stringify(specs)}`,
            "g.seq.vec.numBlocks = max(g.seq.vec.numBlocks, len(_specs))",
            "for i, s in enumerate(_specs):",
            "    try: setattr(g.par, 'vec%dname' % i, s['name'])",
            "    except Exception: pass",
            "    try: setattr(g.par, 'vec%dvaluex' % i, s['value'])",
            "    except Exception: pass",
          ].join("\n");
          await ctx.client.executePythonScript(bind, false).catch(() => {
            warnings.push(`Could not bind uniforms on ${glsl.path}.`);
          });
        }

        passes.push({ name: passName, path: glsl.path });
        prevPath = glsl.path;
        return glsl.path;
      };

      // SSAO
      if (args.ssao_enable) {
        const depthForSsao = selDepthPath ?? selColor.path; // graceful fallback
        const extras = [depthForSsao];
        if (selNormalPath) extras.push(selNormalPath);
        await buildPass("glsl_ssao", SSAO_FRAG, extras, [
          { name: "uRadius", value: args.ssao_radius },
          { name: "uIntensity", value: args.ssao_intensity },
        ]);
      }

      // SSR — requires normal_top.
      if (args.ssr_enable) {
        if (!selNormalPath) {
          warnings.push("SSR requires normal_top — skipped.");
        } else {
          const depthForSsr = selDepthPath ?? selColor.path;
          await buildPass(
            "glsl_ssr",
            SSR_FRAG,
            [depthForSsr, selNormalPath],
            [{ name: "uIntensity", value: args.ssr_intensity }],
          );
        }
      }

      // DOF
      if (args.dof_enable) {
        const depthForDof = selDepthPath ?? selColor.path;
        await buildPass(
          "glsl_dof",
          DOF_FRAG,
          [depthForDof],
          [
            { name: "uFocus", value: args.dof_focus },
            { name: "uAperture", value: args.dof_aperture },
          ],
        );
      }

      // Motion blur
      if (args.motion_blur_enable) {
        if (selVelocityPath) {
          await buildPass(
            "glsl_mb",
            MB_FRAG_WITH_VEL,
            [selVelocityPath],
            [{ name: "uAmount", value: args.motion_blur_amount }],
          );
        } else {
          await buildPass(
            "glsl_mb",
            MB_FRAG_DIRECTIONAL,
            [],
            [{ name: "uAmount", value: args.motion_blur_amount }],
          );
        }
      }

      if (passes.length === 0) {
        warnings.push("All passes disabled — output is the source color passthrough.");
      }

      // Final null output.
      const nullOut = await ctx.client.createNode({
        parent_path: containerPath,
        type: "nullTOP",
        name: "out1",
      });
      await connectNodesViaBridge(ctx.client, prevPath, nullOut.path, 0, 0);

      // Best-effort expose container custom params bound to per-pass uniforms.
      const bindings: Array<[string, string, string, number]> = [];
      const ssaoPass = passes.find((p) => p.name === "glsl_ssao");
      if (ssaoPass) {
        bindings.push(["Ssaoradius", ssaoPass.path, "vec0valuex", args.ssao_radius]);
        bindings.push(["Ssaointensity", ssaoPass.path, "vec1valuex", args.ssao_intensity]);
      }
      const ssrPass = passes.find((p) => p.name === "glsl_ssr");
      if (ssrPass) {
        bindings.push(["Ssrintensity", ssrPass.path, "vec0valuex", args.ssr_intensity]);
      }
      const dofPass = passes.find((p) => p.name === "glsl_dof");
      if (dofPass) {
        bindings.push(["Doffocus", dofPass.path, "vec0valuex", args.dof_focus]);
        bindings.push(["Dofaperture", dofPass.path, "vec1valuex", args.dof_aperture]);
      }
      const mbPass = passes.find((p) => p.name === "glsl_mb");
      if (mbPass) {
        bindings.push(["Motionblur", mbPass.path, "vec0valuex", args.motion_blur_amount]);
      }
      if (bindings.length > 0) {
        const script = [
          `c = op(${q(containerPath)})`,
          "page = None",
          "for p in c.customPages:",
          "    if p.name == 'Post Passes':",
          "        page = p; break",
          "if page is None: page = c.appendCustomPage('Post Passes')",
          `_binds = ${JSON.stringify(bindings)}`,
          "for parname, opath, target, default in _binds:",
          "    try:",
          "        existing = getattr(c.par, parname, None)",
          "        if existing is None:",
          "            p = page.appendFloat(parname)[0]",
          "            p.default = default",
          "            p.val = default",
          "        target_par = getattr(op(opath).par, target, None)",
          "        if target_par is not None:",
          "            target_par.expr = \"op('%s').par.%s\" % (c.path, parname)",
          "            try: target_par.mode = ParMode.EXPRESSION",
          "            except Exception: pass",
          "    except Exception:",
          "        pass",
        ].join("\n");
        await ctx.client.executePythonScript(script, false).catch(() => {
          warnings.push("Could not expose all container custom params (best-effort).");
        });
      }

      return {
        container_path: containerPath,
        output_path: nullOut.path,
        color_top: args.color_top,
        depth_top: depthSourcePath,
        normal_top: args.normal_top,
        velocity_top: args.velocity_top,
        auto_depth_top: autoDepthPath,
        passes,
        warnings,
      };
    },
    (result) =>
      jsonResult(
        `Built post_passes_3d at ${result.container_path} with ${result.passes.length} pass(es).`,
        result,
      ),
  );
}

export const registerPostPasses3d: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "post_passes_3d",
    {
      title: "3D-aware post-processing passes",
      description:
        "Compose a chain of 3D-aware post-processing passes (SSAO, SSR, DOF, motion blur) inside a new baseCOMP. Each pass is a glslTOP with companion textDAT that samples color + depth + (optional) normal/velocity AOVs from selectTOPs. Passes run in fixed order SSAO → SSR → DOF → MB and emit a final null TOP ('out1'). SSR is skipped with a warning when normal_top is empty; motion blur falls back to a directional blur when velocity_top is empty; if color_top points at a renderTOP and depth_top is empty, a sibling depthTOP is auto-created (best-effort). Returns container/output paths, the resolved AOV paths, the enabled passes, and any warnings.",
      inputSchema: postPasses3dSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => postPasses3dImpl(ctx, args),
  );
};
