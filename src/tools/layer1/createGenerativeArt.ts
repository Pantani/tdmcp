import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import {
  buildFromRecipe,
  createSystemContainer,
  finalize,
  type NetworkBuilder,
  runBuild,
} from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

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

// A real de Jong strange attractor, iterated per pixel and splatted as glowing points on
// black: each pixel sums a tight Gaussian over thousands of orbit samples (fine particle
// filaments) plus a faint wide halo (glow). The four coefficients are FIXED at a known dense,
// robustly-chaotic set — de Jong has periodic windows scattered through coefficient space, so
// animating the coefficients can collapse the figure to a few dots; motion instead comes from
// slowly rotating and breathing the framing. `uTime` is bound to absTime by buildGlslGenerative;
// lowercase var names dodge the preamble #define collisions (see CLAUDE.md / GLSL gotchas).
const STRANGE_ATTRACTOR_SHADER = `out vec4 fragColor;
uniform float uTime;
vec2 dejong(vec2 z, float a, float b, float c, float d){
  return vec2(sin(a*z.y)-cos(b*z.x), sin(c*z.x)-cos(d*z.y));
}
void main(){
  const float pa = 1.4, pb = -2.3, pc = 2.4, pd = -2.1;
  const vec2 ctr = vec2(-0.185, -0.227);   // orbit centroid -> recenter on canvas
  float ang = uTime * 0.05;
  float ca = cos(ang), sa = sin(ang);
  vec2 p = mat2(ca, -sa, sa, ca) * (vUV.st - 0.5);
  float scale = 0.18 * (1.0 + 0.04 * sin(uTime * 0.11));
  vec2 z = vec2(0.10, 0.10);
  for(int i=0;i<40;i++){ z = dejong(z,pa,pb,pc,pd); }   // settle onto the attractor
  float glow = 0.0;
  const int STEPS = 3600;
  for(int i=0;i<STEPS;i++){
    z = dejong(z,pa,pb,pc,pd);
    vec2 d2 = p - (z - ctr) * scale;
    float r = dot(d2, d2);
    glow += exp(-r*22000.0);        // tight core -> particle filaments
    glow += 0.08*exp(-r*1200.0);    // faint halo -> glow
  }
  glow *= 0.02;
  vec3 col = vec3(0.10,0.35,1.00)*glow;
  col += vec3(0.30,0.95,1.00)*pow(glow,1.5)*0.7;
  col += vec3(1.00,0.80,0.45)*pow(glow,3.0)*0.9;
  fragColor = TDOutputSwizzle(vec4(col,1.0));
}
`;

interface InlineTechnique {
  shader: string;
  // Generator GLSL TOPs default to 256×256 (no input to size from). Fine attractor filaments
  // need a real canvas, so this pins a fixed square resolution; undefined keeps the default.
  squareRes?: number;
}

// Techniques that map to a faithful inline shader. The rest fall back to animated noise.
const TECHNIQUE_SHADERS: Record<string, InlineTechnique> = {
  voronoi: { shader: VORONOI_SHADER },
  fractal: { shader: FBM_SHADER },
  strange_attractor: { shader: STRANGE_ATTRACTOR_SHADER, squareRes: 720 },
};

const RECIPE_FOR = new Map<string, string>([
  ["reaction_diffusion", "reaction_diffusion"],
  ["noise_landscape", "noise_landscape"],
]);

export const createGenerativeArtSchema = z.object({
  technique: z
    .enum([
      "noise_landscape",
      "reaction_diffusion",
      "strange_attractor",
      "l_system",
      "cellular_automata",
      "flow_field",
      "voronoi",
      "fractal",
      "custom_glsl",
    ])
    .describe(
      "Generative method. reaction_diffusion/noise_landscape build validated recipes; strange_attractor/voronoi/fractal render faithful inline GLSL; custom_glsl uses your shader (custom_glsl_code); l_system/cellular_automata/flow_field currently fall back to an animated-noise approximation (with a warning).",
    ),
  color_palette: z
    .string()
    .optional()
    .describe(
      "Free-text palette hint recorded in the result; best-effort, not all techniques honor it.",
    ),
  evolution_speed: z.coerce
    .number()
    .positive()
    .default(1.0)
    .describe(
      "Animation speed multiplier on the time uniform driving the look (1 = nominal, higher = faster evolution). Exposed as the 'Speed' knob.",
    ),
  custom_glsl_code: z
    .string()
    .optional()
    .describe(
      "Fragment shader source used only when technique='custom_glsl'; if omitted, a default plasma shader is used (with a warning).",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe(
      "When true (default), expose a live 'Speed' knob (evolution speed) on the system container.",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent network where the generative container is created (default '/project1')."),
});
type CreateGenerativeArtArgs = z.infer<typeof createGenerativeArtSchema>;

async function buildGlslGenerative(
  ctx: ToolContext,
  parentPath: string,
  name: string,
  fragment: string,
  speed = 1.0,
  squareRes?: number,
): Promise<{ builder: NetworkBuilder; outputPath: string }> {
  const builder = await createSystemContainer(ctx, parentPath, name);
  const glsl = await builder.add("glslTOP", "glsl1");
  const frag = await builder.add("textDAT", "glsl1_frag");
  await builder.python(
    `op(${q(frag)}).text = ${q(fragment)}\nop(${q(glsl)}).par.pixeldat = op(${q(frag)}).name`,
  );
  if (squareRes !== undefined) {
    await builder.python(
      `_r = op(${q(glsl)})\n_r.par.outputresolution = 'custom'\n_r.par.resolutionw = ${squareRes}\n_r.par.resolutionh = ${squareRes}`,
    );
  }
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
        const { builder, outputPath, controls } = await buildFromRecipe(
          ctx,
          recipe,
          args.parent_path,
        );
        return finalize(ctx, {
          summary: `Created "${recipe.name}" generative system.`,
          builder,
          outputPath,
          recipeId,
          controls,
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
    const inline = TECHNIQUE_SHADERS[args.technique];
    if (inline) {
      const { builder, outputPath } = await buildGlslGenerative(
        ctx,
        args.parent_path,
        `generative_${args.technique}`,
        inline.shader,
        args.evolution_speed,
        inline.squareRes,
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
        "Create an evolving generative visual. Creates a new baseCOMP under `parent_path` holding the generator (a recipe network, a GLSL TOP + Text DAT, or a noise chain) ending in a Null output. reaction_diffusion/noise_landscape use validated recipes; strange_attractor, voronoi, and fractal render real GLSL; custom_glsl uses your shader; the rest fall back to animated noise (with a warning). Exposes a live 'Speed' knob (except for recipe-built techniques). Returns a summary plus a JSON block with the container path, created node paths, the output path, exposed controls, the technique, any node errors, warnings, and an inline preview image.",
      inputSchema: createGenerativeArtSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createGenerativeArtImpl(ctx, args),
  );
};
