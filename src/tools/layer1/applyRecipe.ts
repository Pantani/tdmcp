import { z } from "zod";
import { errorResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { buildFromRecipe, finalize, runBuild } from "./orchestration.js";

export const applyRecipeSchema = z.object({
  id: z.string().describe("Recipe id to build (see list_recipes)."),
  parent_path: z.string().default("/project1").describe("COMP to build the recipe inside."),
});
type ApplyRecipeArgs = z.infer<typeof applyRecipeSchema>;

export async function applyRecipeImpl(ctx: ToolContext, args: ApplyRecipeArgs) {
  const recipe = ctx.recipes.get(args.id);
  if (!recipe) {
    const available = ctx.recipes
      .list()
      .map((r) => r.id)
      .join(", ");
    return errorResult(`Recipe '${args.id}' not found. Available: ${available || "none"}.`);
  }
  return runBuild(async () => {
    const built = await buildFromRecipe(ctx, recipe, args.parent_path);
    return finalize(ctx, {
      summary: `Built recipe "${recipe.name}" (${recipe.id}).`,
      builder: built.builder,
      outputPath: built.outputPath,
      controls: built.controls,
      recipeId: recipe.id,
      extra: { recipe: recipe.id },
    });
  });
}

export const registerApplyRecipe: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "apply_recipe",
    {
      title: "Apply recipe",
      description:
        "Instantiate a built-in recipe by id (from list_recipes) inside a COMP — a tested, ready-made network you can build in one call, then tweak. Verifies and previews the result.",
      inputSchema: applyRecipeSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => applyRecipeImpl(ctx, args),
  );
};
