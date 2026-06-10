import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import {
  buildFromRecipe,
  createSystemContainer,
  finalize,
  runBuild,
} from "../layer2/orchestration.js";
import { errorResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

export const createSimulationSchema = z.object({
  type: z
    .enum(["reaction_diffusion", "slime", "fluid"])
    .default("reaction_diffusion")
    .describe(
      "reaction_diffusion = Gray-Scott patterns (uses the validated recipe); slime = drifting decaying trails; fluid = advected smear.",
    ),
  speed: z.coerce
    .number()
    .positive()
    .default(1)
    .describe("(slime/fluid) How fast the flow field evolves."),
  decay: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.96)
    .describe("(slime/fluid) Trail persistence — higher holds longer."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("(slime/fluid) Expose a live 'Decay' knob bound to the gain Level TOP."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path the self-contained simulation container is created inside."),
});
type CreateSimulationArgs = z.infer<typeof createSimulationSchema>;

export async function createSimulationImpl(ctx: ToolContext, args: CreateSimulationArgs) {
  return runBuild(async () => {
    // Reaction-diffusion has a battle-tested recipe already; reuse it rather than ship a new shader.
    if (args.type === "reaction_diffusion") {
      const recipe = ctx.recipes.get("reaction_diffusion");
      if (!recipe) {
        return errorResult("The 'reaction_diffusion' recipe is unavailable in this build.");
      }
      const built = await buildFromRecipe(ctx, recipe, args.parent_path);
      return finalize(ctx, {
        summary: "Built a reaction-diffusion simulation (Gray-Scott).",
        builder: built.builder,
        outputPath: built.outputPath,
        controls: built.controls,
        recipeId: recipe.id,
        extra: { type: args.type },
      });
    }

    // slime / fluid: a feedback loop displaced by an evolving noise flow field, then decayed.
    const builder = await createSystemContainer(ctx, args.parent_path, `sim_${args.type}`);

    const seed = await builder.add("noiseTOP", "seed", {
      monochrome: 1,
      period: args.type === "slime" ? 2 : 6,
    });
    // An animated 3D-noise flow field (its Z drifts with time) drives the displacement.
    const flow = await builder.add("noiseTOP", "flow", { monochrome: 1, period: 4 });
    await builder.python(
      `_n = op(${q(flow)})\n_pz = _n.par.tz\n_PM = type(_pz.mode)\n_pz.expr = ${q(`absTime.seconds * ${args.speed}`)}\n_pz.mode = _PM.EXPRESSION`,
    );

    const feedback = await builder.add("feedbackTOP", "feedback1");
    const comp = await builder.add("compositeTOP", "comp1", { operand: "maximum" });
    await builder.connect(seed, comp, 0, 0);
    await builder.connect(feedback, comp, 0, 1);
    await builder.connect(seed, feedback); // first-frame input

    const displace = await builder.add("displaceTOP", "displace");
    await builder.connect(comp, displace, 0, 0);
    await builder.connect(flow, displace, 0, 1);

    const blur = await builder.add("blurTOP", "blur", { size: args.type === "slime" ? 1 : 3 });
    await builder.connect(displace, blur);

    const gain = await builder.add("levelTOP", "gain", { brightness1: args.decay });
    await builder.connect(blur, gain);

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(gain, out);
    await builder.python(`op(${q(feedback)}).par.top = op(${q(gain)}).name`);

    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "Decay",
            type: "float",
            min: 0,
            max: 1,
            default: args.decay,
            bind_to: [`${gain}.brightness1`],
          },
        ]
      : [];

    return finalize(ctx, {
      summary: `Built a ${args.type} simulation (feedback flow field, decay ${args.decay}) → ${out}.`,
      builder,
      outputPath: out,
      controls,
      extra: { type: args.type, output_path: out },
    });
  });
}

export const registerCreateSimulation: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_simulation",
    {
      title: "Create simulation",
      description:
        "Build a GPU simulation: 'reaction_diffusion' grows Gray-Scott patterns (via the validated recipe), while 'slime' and 'fluid' run a feedback loop displaced by an evolving noise flow field — drifting trails and advected smears. Exposes a Decay knob (trail persistence). For more procedural techniques (cellular automata, flow fields, strange attractors) see create_generative_art.",
      inputSchema: createSimulationSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createSimulationImpl(ctx, args),
  );
};
