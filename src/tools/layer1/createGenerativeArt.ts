import { z } from "zod";
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
  evolution_speed: z.number().positive().default(1.0),
  custom_glsl_code: z
    .string()
    .optional()
    .describe("Fragment shader (only for technique 'custom_glsl')."),
  parent_path: z.string().default("/project1"),
});
type CreateGenerativeArtArgs = z.infer<typeof createGenerativeArtSchema>;

async function buildGlslGenerative(
  ctx: ToolContext,
  parentPath: string,
  name: string,
  fragment: string,
): Promise<{ builder: NetworkBuilder; outputPath: string }> {
  const builder = await createSystemContainer(ctx, parentPath, name);
  const glsl = await builder.add("glslTOP", "glsl1");
  const frag = await builder.add("textDAT", "glsl1_frag");
  await builder.python(
    `op(${q(frag)}).text = ${q(fragment)}\nop(${q(glsl)}).par.pixeldat = op(${q(frag)}).name`,
  );
  const out = await builder.add("nullTOP", "out1");
  await builder.connect(glsl, out);
  return { builder, outputPath: out };
}

export async function createGenerativeArtImpl(ctx: ToolContext, args: CreateGenerativeArtArgs) {
  return runBuild(async () => {
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
      );
      if (!args.custom_glsl_code) {
        builder.warnings.push("No custom_glsl_code provided; used a default plasma shader.");
      }
      return finalize(ctx, {
        summary: "Created a custom GLSL generative system.",
        builder,
        outputPath,
        extra: { technique: args.technique },
      });
    }

    // Other techniques: prefer a matching GLSL knowledge pattern, else animated noise.
    const pattern = ctx.knowledge.getGlslPattern(args.technique);
    if (pattern?.code?.snippet) {
      const { builder, outputPath } = await buildGlslGenerative(
        ctx,
        args.parent_path,
        `generative_${args.technique}`,
        pattern.code.snippet,
      );
      return finalize(ctx, {
        summary: `Created a "${args.technique}" system from the GLSL knowledge pattern "${pattern.name}".`,
        builder,
        outputPath,
        extra: { technique: args.technique, glsl_pattern: pattern.id },
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
      `p = op(${q(noise)}).par.tz\np.expr = ${q(`absTime.seconds * ${args.evolution_speed}`)}`,
    );
    builder.warnings.push(
      `Technique "${args.technique}" is approximated with an animated-noise generator in this version.`,
    );
    return finalize(ctx, {
      summary: `Created an approximate "${args.technique}" generative system.`,
      builder,
      outputPath: out,
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
