import { z } from "zod";
import { textResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { significantTerms } from "./intent.js";

export const describeProjectSchema = z.object({
  description: z.string().min(1).describe("Natural-language description of the visual you want."),
});
type DescribeProjectArgs = z.infer<typeof describeProjectSchema>;

export function describeProjectImpl(ctx: ToolContext, args: DescribeProjectArgs) {
  const d = args.description.toLowerCase();
  const has = (...words: string[]) => words.some((w) => d.includes(w));

  let tool: string;
  let summary: string;
  let recipeId: string | undefined;

  if (has("audio", "sound", "music", "beat", "frequenc", "spectrum", "reactive")) {
    tool = "create_audio_reactive";
    summary = "audio-reactive visual";
  } else if (has("particle", "swarm", "galaxy", "sparkle", "emitter")) {
    tool = "create_particle_system";
    summary = "particle system";
  } else if (has("reaction", "diffusion", "gray-scott", "gray scott")) {
    tool = "create_generative_art";
    summary = "reaction-diffusion simulation";
    recipeId = "reaction_diffusion";
  } else if (has("landscape", "terrain", "mountain", "heightfield")) {
    tool = "create_generative_art";
    summary = "3D noise landscape";
    recipeId = "noise_landscape";
  } else if (has("feedback", "tunnel", "echo", "trail", "kaleido")) {
    tool = "create_feedback_network";
    summary = "feedback network";
  } else {
    tool = "create_generative_art";
    summary = "generative visual";
    recipeId = ctx.recipes.findByTags(significantTerms(d))?.id;
  }

  const lines: string[] = [
    `Plan for: "${args.description}"`,
    "",
    `Interpreted as: ${summary}.`,
    `Recommended tool: ${tool}${recipeId ? ` (recipe: ${recipeId})` : ""}.`,
  ];

  if (recipeId) {
    const recipe = ctx.recipes.get(recipeId);
    if (recipe) {
      lines.push("", `Recipe "${recipe.name}" would create:`);
      for (const node of recipe.nodes) {
        lines.push(`  - ${node.name} (${node.type})${node.comment ? ` — ${node.comment}` : ""}`);
      }
    }
  }

  lines.push("", "Next: call the recommended tool, then check get_td_node_errors and get_preview.");
  return textResult(lines.join("\n"));
}

export const registerDescribeProject: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "plan_visual",
    {
      title: "Plan a visual from a description",
      description:
        "Turn a natural-language description of a visual you WANT into a build plan (which tool/recipe and nodes) — a dry run that creates nothing. Note: this does NOT inspect the current TouchDesigner project; to read existing nodes use get_td_nodes / get_td_topology / find_td_nodes.",
      inputSchema: describeProjectSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => describeProjectImpl(ctx, args),
  );
};
