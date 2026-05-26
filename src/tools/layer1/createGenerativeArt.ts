import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  buildFromRecipe,
  createSystemContainer,
  finalize,
  type NetworkBuilder,
  runBuild,
} from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

const DEFAULT_PLASMA = `out vec4 fragColor;
uniform float uTime;
void main(){
    vec2 uv = vUV.st;
    float v = sin(uv.x * 10.0 + uTime) + sin(uv.y * 10.0 + uTime * 0.7);
    v += sin((uv.x + uv.y) * 8.0 + uTime * 1.3);
    vec3 col = 0.5 + 0.5 * cos(vec3(0.0, 2.0, 4.0) + v);
    fragColor = TDOutputSwizzle(vec4(col, 1.0));
}
`;

// Self-contained, TouchDesigner-ready generative shaders, keyed by technique. They each
// declare their own `out vec4 fragColor` and read a `uTime` uniform (bound to absTime by
// buildGlslGenerative). Variable names avoid single letters / F1-style names that collide
// with macros in TD's auto-prepended GLSL preamble. These replace the knowledge-base GLSL
// snippets, which are documentation fragments (no output declaration, unbound uniforms) and
// are not directly compilable.
const VORONOI_SHADER = `out vec4 fragColor;
uniform float uTime;
vec2 hash2(vec2 p){ return fract(sin(vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3))))*43758.5453); }
vec2 cellNoise(vec2 p){
  vec2 ip=floor(p); vec2 fp=fract(p);
  float d1=8.0; float d2=8.0;
  for(int yy=-1; yy<=1; yy++){
    for(int xx=-1; xx<=1; xx++){
      vec2 nb=vec2(float(xx),float(yy));
      vec2 pt=hash2(ip+nb);
      pt=0.5+0.5*sin(uTime*0.5+6.2831*pt);
      vec2 diff=nb+pt-fp; float dd=length(diff);
      if(dd<d1){ d2=d1; d1=dd; } else if(dd<d2){ d2=dd; }
    }
  }
  return vec2(d1,d2);
}
void main(){
  vec2 uv=vUV.st*8.0;
  vec2 fc=cellNoise(uv);
  float edge=smoothstep(0.0,0.08,fc.y-fc.x);
  float cell=fc.x;
  vec3 col=mix(vec3(0.02),vec3(0.5+0.5*cell,0.7,0.9),edge);
  fragColor=TDOutputSwizzle(vec4(col,1.0));
}
`;

const FBM_SHADER = `out vec4 fragColor;
uniform float uTime;
float hashF(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
float vnoise(vec2 p){
  vec2 ip=floor(p); vec2 fp=fract(p);
  vec2 uu=fp*fp*(3.0-2.0*fp);
  float na=hashF(ip+vec2(0.0,0.0));
  float nb=hashF(ip+vec2(1.0,0.0));
  float nc=hashF(ip+vec2(0.0,1.0));
  float nd=hashF(ip+vec2(1.0,1.0));
  return mix(mix(na,nb,uu.x),mix(nc,nd,uu.x),uu.y);
}
float fbm(vec2 p){
  float acc=0.0; float amp=0.5;
  for(int oc=0; oc<6; oc++){ acc+=amp*vnoise(p); p*=2.0; amp*=0.5; }
  return acc;
}
void main(){
  vec2 uv=vUV.st*3.0;
  float val=fbm(uv+vec2(uTime*0.1, uTime*0.05));
  vec3 col=mix(vec3(0.02,0.05,0.15), vec3(0.95,0.6,0.25), val);
  fragColor=TDOutputSwizzle(vec4(col,1.0));
}
`;

// Techniques that map to a faithful inline shader. The rest fall back to animated noise.
const TECHNIQUE_SHADERS: Record<string, string> = {
  voronoi: VORONOI_SHADER,
  fractal: FBM_SHADER,
};

const RECIPE_FOR = new Map<string, string>([
  ["reaction_diffusion", "reaction_diffusion"],
  ["noise_landscape", "noise_landscape"],
]);

export const createGenerativeArtSchema = z.object({
  technique: z.enum([
    "noise_landscape",
    "reaction_diffusion",
    "strange_attractor",
    "l_system",
    "cellular_automata",
    "flow_field",
    "voronoi",
    "fractal",
    "custom_glsl",
  ]),
  color_palette: z.string().optional().describe("Free-text palette hint (best-effort)."),
  evolution_speed: z.coerce.number().positive().default(1.0),
  custom_glsl_code: z
    .string()
    .optional()
    .describe("Fragment shader (only for technique 'custom_glsl')."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Expose a live 'Speed' knob (evolution speed) on the system container."),
  parent_path: z.string().default("/project1"),
});
type CreateGenerativeArtArgs = z.infer<typeof createGenerativeArtSchema>;

async function buildGlslGenerative(
  ctx: ToolContext,
  parentPath: string,
  name: string,
  fragment: string,
  speed = 1.0,
): Promise<{ builder: NetworkBuilder; outputPath: string }> {
  const builder = await createSystemContainer(ctx, parentPath, name);
  const glsl = await builder.add("glslTOP", "glsl1");
  const frag = await builder.add("textDAT", "glsl1_frag");
  await builder.python(
    `op(${q(frag)}).text = ${q(fragment)}\nop(${q(glsl)}).par.pixeldat = op(${q(frag)}).name`,
  );
  // Bind a `uTime` uniform to absTime so time-driven shaders animate. The uniform lives in
  // the GLSL TOP's "Vectors" sequence, whose block count has no structured setter; raise it
  // via numBlocks, then set the block name and an expression on its first component.
  // uTime advances with absTime; a defensive `Speed` lookup lets an auto-exposed control
  // (parent().par.Speed) drive evolution speed live, and falls back to the build-time constant
  // when no control is present — so the expression never errors.
  await builder.python(
    `_g = op(${q(glsl)})\n_g.seq.vec.numBlocks = max(_g.seq.vec.numBlocks, 1)\n_g.par.vec0name = 'uTime'\n_g.par.vec0valuex.expr = ${q(`absTime.seconds * (parent().par.Speed.eval() if hasattr(parent().par, 'Speed') else ${speed})`)}`,
  );
  const out = await builder.add("nullTOP", "out1");
  await builder.connect(glsl, out);
  return { builder, outputPath: out };
}

export async function createGenerativeArtImpl(ctx: ToolContext, args: CreateGenerativeArtArgs) {
  return runBuild(async () => {
    // A single "Speed" knob drives evolution speed (the time-driving expressions reference it).
    // Recipe-built techniques don't use that expression, so they don't get the control.
    const speedControls: ControlSpec[] = args.expose_controls
      ? [{ name: "Speed", type: "float", min: 0, max: 4, default: args.evolution_speed }]
      : [];
    const recipeId = RECIPE_FOR.get(args.technique);
    if (recipeId) {
      const recipe = ctx.recipes.get(recipeId);
      if (recipe) {
        const { builder, outputPath } = await buildFromRecipe(ctx, recipe, args.parent_path);
        return finalize(ctx, {
          summary: `Created "${recipe.name}" generative system.`,
          builder,
          outputPath,
          recipeId,
          extra: { technique: args.technique, color_palette: args.color_palette },
        });
      }
    }

    if (args.technique === "custom_glsl") {
      const fragment = args.custom_glsl_code ?? DEFAULT_PLASMA;
      const { builder, outputPath } = await buildGlslGenerative(
        ctx,
        args.parent_path,
        "generative_custom_glsl",
        fragment,
        args.evolution_speed,
      );
      if (!args.custom_glsl_code) {
        builder.warnings.push("No custom_glsl_code provided; used a default plasma shader.");
      }
      return finalize(ctx, {
        summary: "Created a custom GLSL generative system.",
        builder,
        outputPath,
        controls: speedControls,
        extra: { technique: args.technique },
      });
    }

    // Techniques with a faithful inline shader render the real thing (animated via uTime);
    // the rest fall back to animated noise below.
    const inlineShader = TECHNIQUE_SHADERS[args.technique];
    if (inlineShader) {
      const { builder, outputPath } = await buildGlslGenerative(
        ctx,
        args.parent_path,
        `generative_${args.technique}`,
        inlineShader,
        args.evolution_speed,
      );
      return finalize(ctx, {
        summary: `Created a "${args.technique}" generative system (GLSL).`,
        builder,
        outputPath,
        controls: speedControls,
        extra: { technique: args.technique, color_palette: args.color_palette },
      });
    }

    const builder = await createSystemContainer(
      ctx,
      args.parent_path,
      `generative_${args.technique}`,
    );
    const noise = await builder.add("noiseTOP", "noise1", { monochrome: 0, period: 6 });
    const level = await builder.add("levelTOP", "level1");
    const out = await builder.add("nullTOP", "out1");
    await builder.connect(noise, level);
    await builder.connect(level, out);
    await builder.python(
      `p = op(${q(noise)}).par.tz\np.expr = ${q(`absTime.seconds * (parent().par.Speed.eval() if hasattr(parent().par, 'Speed') else ${args.evolution_speed})`)}`,
    );
    builder.warnings.push(
      `Technique "${args.technique}" is approximated with an animated-noise generator in this version.`,
    );
    return finalize(ctx, {
      summary: `Created an approximate "${args.technique}" generative system.`,
      builder,
      outputPath: out,
      controls: speedControls,
      extra: { technique: args.technique, evolution_speed: args.evolution_speed },
    });
  });
}

export const registerCreateGenerativeArt: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_generative_art",
    {
      title: "Create generative art",
      description:
        "Create an evolving generative visual. Known techniques (reaction_diffusion, noise_landscape) use validated recipes; custom_glsl uses your shader; others fall back to a knowledge GLSL pattern or animated noise.",
      inputSchema: createGenerativeArtSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createGenerativeArtImpl(ctx, args),
  );
};
