import { z } from "zod";
import { NPR_SHADER } from "../layer2/createNprFilter.js";
import {
  createSystemContainer,
  finalize,
  type NetworkBuilder,
  runBuild,
} from "../layer2/orchestration.js";
import { errorResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

const DIRECT_EFFECTS: Record<string, { type: string; parameters?: Record<string, unknown> }> = {
  // bloomTOP defaults bloom everything above 0.01 and adds it back, which blows bright
  // sources out to solid white. Raise the threshold so only highlights bloom, and soften the
  // intensity for a tasteful glow that preserves the underlying image.
  bloom: {
    type: "bloomTOP",
    parameters: { bloomthreshold: 0.8, bloomintensity: 0.6, bloomfill: 0.5 },
  },
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
  halftone: `out vec4 fragColor;
void main(){ vec2 uv=vUV.st; vec4 c=texture(sTD2DInputs[0],uv);
  vec2 px=uv*uTD2DInfos[0].res.zw; float cell=6.0;
  vec2 g=fract(px/cell)-0.5; float d=length(g);
  float lum=dot(c.rgb,vec3(0.299,0.587,0.114));
  float dotmask=step(d*2.0,sqrt(lum));
  fragColor=TDOutputSwizzle(vec4(vec3(dotmask),c.a)); }
`,
  dither: `out vec4 fragColor;
float hash(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
void main(){ vec2 uv=vUV.st; vec4 c=texture(sTD2DInputs[0],uv);
  vec2 px=floor(uv*uTD2DInfos[0].res.zw); float t=hash(px);
  vec3 q=step(vec3(t),c.rgb);
  fragColor=TDOutputSwizzle(vec4(q,c.a)); }
`,
  crt: `out vec4 fragColor;
void main(){ vec2 uv=vUV.st; vec2 cc=uv-0.5; float dist=dot(cc,cc);
  vec2 wuv=uv+cc*dist*0.15;
  vec4 c=texture(sTD2DInputs[0],wuv);
  float scan=0.9+0.1*step(0.5,fract(wuv.y*uTD2DInfos[0].res.w*0.5));
  float vig=smoothstep(0.85,0.3,length(cc));
  vec3 col=c.rgb*scan*vig;
  if(wuv.x<0.0||wuv.x>1.0||wuv.y<0.0||wuv.y>1.0) col=vec3(0.0);
  fragColor=TDOutputSwizzle(vec4(col,c.a)); }
`,
  mirror: `out vec4 fragColor;
void main(){ vec2 uv=vUV.st; if(uv.x>0.5) uv.x=1.0-uv.x;
  fragColor=TDOutputSwizzle(texture(sTD2DInputs[0],uv)); }
`,
  vhs: `out vec4 fragColor;
float hash(float x){return fract(sin(x*127.1)*43758.5453);}
void main(){ vec2 uv=vUV.st; float line=hash(floor(uv.y*240.0));
  float jit=(line-0.5)*0.01*step(0.85,line); vec2 u=uv+vec2(jit,0.0);
  float r=texture(sTD2DInputs[0],u+vec2(0.004,0.0)).r;
  float g=texture(sTD2DInputs[0],u).g;
  float b=texture(sTD2DInputs[0],u-vec2(0.004,0.0)).b;
  float scan=0.92+0.08*step(0.5,fract(uv.y*uTD2DInfos[0].res.w*0.5));
  float a=texture(sTD2DInputs[0],u).a;
  fragColor=TDOutputSwizzle(vec4(vec3(r,g,b)*scan,a)); }
`,
};

/** Modes that need extra G-buffer AOVs (depth/normal/velocity) the post-fx chain
 * doesn't have — redirect the artist to the dedicated 3D-aware tool. */
const REDIRECT_3D_MODES: Record<string, string> = {
  ssao: "post_passes_3d",
  ssr: "post_passes_3d",
  dof: "post_passes_3d",
  motion_blur: "post_passes_3d",
};

/** NPR modes share one shader (NPR_SHADER) and pick a branch via uMode. */
const NPR_MODES: Record<string, number> = {
  npr_oil: 0,
  npr_pencil: 1,
  npr_watercolor: 2,
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
  "halftone",
  "dither",
  "crt",
  "mirror",
  "vhs",
  // NPR painterly (shared NPR_SHADER from createNprFilter, branch via uMode):
  "npr_oil",
  "npr_pencil",
  "npr_watercolor",
  // 3D post passes — redirected to post_passes_3d (needs depth/normal AOVs):
  "ssao",
  "ssr",
  "dof",
  "motion_blur",
] as const;

export const applyPostProcessingSchema = z.object({
  source_path: z
    .string()
    .describe(
      "Path of the existing TOP to post-process (e.g. '/project1/render1'); pulled in via a Select TOP so it may live in another container.",
    ),
  effects: z
    .array(z.enum(EFFECTS))
    .min(1)
    .describe(
      "Effects to apply, chained in the order listed. Each is one of: bloom, chromatic_aberration, film_grain, vignette, color_grade, sharpen, blur, edge_detect, invert, threshold, posterize, glitch, rgb_split, scanlines, halftone, dither, crt, mirror, vhs, npr_oil, npr_pencil, npr_watercolor. The 3D-aware modes ssao / ssr / dof / motion_blur are recognized but redirect to the dedicated `post_passes_3d` tool (they need depth/normal/velocity AOVs that this chain doesn't have).",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent network where the effect-chain container is created (default '/project1')."),
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

/**
 * Add the shared NPR shader as an inline post-fx pass, mode-switched by uMode.
 * Uses sensible defaults (sectors=8, radius=4, smoothness=0.5, strength=1.0) —
 * for parent-bound live controls use the dedicated `create_npr_filter` tool.
 */
async function addNprEffect(builder: NetworkBuilder, name: string, mode: number): Promise<string> {
  const glsl = await builder.add("glslTOP", name);
  const frag = await builder.add("textDAT", `${name}_frag`);
  const setup = [
    `op(${q(frag)}).text = ${q(NPR_SHADER)}`,
    `_g = op(${q(glsl)})`,
    `_g.par.pixeldat = op(${q(frag)}).name`,
    `_g.seq.vec.numBlocks = max(_g.seq.vec.numBlocks, 5)`,
    `_g.par.vec0name = 'uMode'`,
    `_g.par.vec0valuex = ${mode}`,
    `_g.par.vec1name = 'uSectors'`,
    `_g.par.vec1valuex = 8`,
    `_g.par.vec2name = 'uRadius'`,
    `_g.par.vec2valuex = 4`,
    `_g.par.vec3name = 'uSmoothness'`,
    `_g.par.vec3valuex = 0.5`,
    `_g.par.vec4name = 'uStrength'`,
    `_g.par.vec4valuex = 1.0`,
  ].join("\n");
  await builder.python(setup);
  return glsl;
}

export async function applyPostProcessingImpl(ctx: ToolContext, args: ApplyPostProcessingArgs) {
  // Friendly redirect for modes that require depth/normal/velocity AOVs — the
  // post-fx chain only has the colour TOP, so route the artist to the dedicated
  // 3D-aware tool instead of silently doing the wrong thing.
  const redirect = args.effects.find((e) => REDIRECT_3D_MODES[e]);
  if (redirect) {
    return errorResult(
      `Mode '${redirect}' requires depth/normal/velocity AOVs that apply_post_processing doesn't have — use the dedicated \`${REDIRECT_3D_MODES[redirect]}\` tool instead, which renders the G-buffer alongside the colour pass.`,
      { unsupported_effect: redirect, use_tool_instead: REDIRECT_3D_MODES[redirect] },
    );
  }
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
      } else if (effect in NPR_MODES) {
        nodePath = await addNprEffect(builder, `${effect}${i}`, NPR_MODES[effect] ?? 0);
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
        "Chain post-processing effects (bloom, glitch, rgb_split, vignette, etc.) onto an existing TOP, applied in the order given. Creates a new baseCOMP under `parent_path` that pulls the source in via a Select TOP, wires each effect (built-in TOPs or inline-GLSL passes) in series, and ends in a Null TOP. Returns a summary plus a JSON block with the container path, all created node paths, the output Null path, any node errors, warnings, and an inline preview image. Use create_color_grade or create_glitch instead when you want a single dedicated effect with its own exposed controls.",
      inputSchema: applyPostProcessingSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => applyPostProcessingImpl(ctx, args),
  );
};
