import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, type NetworkBuilder, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

const DIRECT_EFFECTS: Record<string, { type: string; parameters?: Record<string, unknown> }> = {
  bloom: { type: "bloomTOP" },
  blur: { type: "blurTOP", parameters: { size: 4 } },
  edge_detect: { type: "edgeTOP" },
  sharpen: { type: "sharpenTOP" },
  threshold: { type: "thresholdTOP", parameters: { threshold: 0.5 } },
  invert: { type: "levelTOP", parameters: { invert: 1 } },
  color_grade: { type: "levelTOP", parameters: { gamma1: 1.1, blacklevel: 0.02 } },
};

const GLSL_EFFECTS: Record<string, string> = {
  rgb_split: `out vec4 fragColor;
void main(){ vec2 uv=vUV.st; vec2 o=vec2(0.004,0.0);
  float r=texture(sTD2DInputs[0],uv+o).r; float g=texture(sTD2DInputs[0],uv).g; float b=texture(sTD2DInputs[0],uv-o).b;
  fragColor=TDOutputSwizzle(vec4(r,g,b,1.0)); }
`,
  chromatic_aberration: `out vec4 fragColor;
void main(){ vec2 uv=vUV.st; vec2 o=(uv-0.5)*0.02;
  float r=texture(sTD2DInputs[0],uv+o).r; float g=texture(sTD2DInputs[0],uv).g; float b=texture(sTD2DInputs[0],uv-o).b;
  fragColor=TDOutputSwizzle(vec4(r,g,b,1.0)); }
`,
  scanlines: `out vec4 fragColor;
void main(){ vec2 uv=vUV.st; vec4 c=texture(sTD2DInputs[0],uv);
  float s=0.85+0.15*step(0.5,fract(uv.y*uTD2DInfos[0].res.w*0.5));
  fragColor=TDOutputSwizzle(vec4(c.rgb*s,c.a)); }
`,
  vignette: `out vec4 fragColor;
void main(){ vec2 uv=vUV.st; vec4 c=texture(sTD2DInputs[0],uv);
  float v=smoothstep(0.8,0.35,distance(uv,vec2(0.5)));
  fragColor=TDOutputSwizzle(vec4(c.rgb*v,c.a)); }
`,
  posterize: `out vec4 fragColor;
void main(){ vec2 uv=vUV.st; vec4 c=texture(sTD2DInputs[0],uv);
  vec3 p=floor(c.rgb*6.0)/6.0; fragColor=TDOutputSwizzle(vec4(p,c.a)); }
`,
  film_grain: `out vec4 fragColor;
float hash(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
void main(){ vec2 uv=vUV.st; vec4 c=texture(sTD2DInputs[0],uv);
  float g=hash(uv*uTD2DInfos[0].res.zw)*0.12-0.06; fragColor=TDOutputSwizzle(vec4(c.rgb+g,c.a)); }
`,
  glitch: `out vec4 fragColor;
float hash(float x){return fract(sin(x*127.1)*43758.5453);}
void main(){ vec2 uv=vUV.st; float band=floor(uv.y*24.0);
  float off=(hash(band)-0.5)*0.06*step(0.7,hash(band*1.7));
  fragColor=TDOutputSwizzle(texture(sTD2DInputs[0],uv+vec2(off,0.0))); }
`,
};

const EFFECTS = [
  "bloom",
  "chromatic_aberration",
  "film_grain",
  "vignette",
  "color_grade",
  "sharpen",
  "blur",
  "edge_detect",
  "invert",
  "threshold",
  "posterize",
  "glitch",
  "rgb_split",
  "scanlines",
] as const;

export const applyPostProcessingSchema = z.object({
  source_path: z.string().describe("Path of the TOP to post-process."),
  effects: z.array(z.enum(EFFECTS)).min(1).describe("Effects to apply in order."),
  parent_path: z.string().default("/project1"),
});
type ApplyPostProcessingArgs = z.infer<typeof applyPostProcessingSchema>;

async function addGlslEffect(
  builder: NetworkBuilder,
  name: string,
  fragment: string,
): Promise<string> {
  const glsl = await builder.add("glslTOP", name);
  const frag = await builder.add("textDAT", `${name}_frag`);
  await builder.python(
    `op(${q(frag)}).text = ${q(fragment)}\nop(${q(glsl)}).par.pixeldat = op(${q(frag)}).name`,
  );
  return glsl;
}

export async function applyPostProcessingImpl(ctx: ToolContext, args: ApplyPostProcessingArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "post_fx");
    // Wires can't cross COMPs, so pull the external source in via a Select TOP (references by path).
    const source = await builder.add("selectTOP", "source");
    await builder.setParams(source, { top: args.source_path });
    let previous = source;
    let applied = 0;

    for (let i = 0; i < args.effects.length; i++) {
      const effect = args.effects[i];
      if (!effect) continue;
      let nodePath: string | undefined;
      const direct = DIRECT_EFFECTS[effect];
      if (direct) {
        nodePath = await builder.add(direct.type, `${effect}${i}`, direct.parameters);
      } else if (GLSL_EFFECTS[effect]) {
        nodePath = await addGlslEffect(builder, `${effect}${i}`, GLSL_EFFECTS[effect]);
      }
      if (!nodePath) {
        builder.warnings.push(`Effect "${effect}" is not supported and was skipped.`);
        continue;
      }
      await builder.connect(previous, nodePath);
      previous = nodePath;
      applied++;
    }

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(previous, out);

    return finalize(ctx, {
      summary: `Applied ${applied}/${args.effects.length} post-processing effect(s) to ${args.source_path}.`,
      builder,
      outputPath: out,
      extra: { source_path: args.source_path, effects: args.effects },
    });
  });
}

export const registerApplyPostProcessing: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "apply_post_processing",
    {
      title: "Apply post-processing",
      description:
        "Chain post-processing effects (bloom, glitch, rgb_split, vignette, etc.) onto an existing TOP. Returns the processed output.",
      inputSchema: applyPostProcessingSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => applyPostProcessingImpl(ctx, args),
  );
};
