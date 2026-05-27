import { z } from "zod";
import { structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const listRecipesSchema = z.object({
  tag: z
    .string()
    .optional()
    .describe("Optional tag/keyword to filter recipes by (matches tags or name)."),
});
type ListRecipesArgs = z.infer<typeof listRecipesSchema>;

export function listRecipesImpl(ctx: ToolContext, args: ListRecipesArgs) {
  let recipes = ctx.recipes.list();
  if (args.tag) {
    const needle = args.tag.toLowerCase();
    recipes = recipes.filter(
      (r) =>
        r.name.toLowerCase().includes(needle) ||
        r.tags.some((t) => t.toLowerCase().includes(needle)),
    );
  }
  return structuredResult(`${recipes.length} recipe(s) available.`, {
    count: recipes.length,
    recipes,
  });
}

export const registerListRecipes: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "list_recipes",
    {
      title: "List recipes",
      description:
        "List the built-in recipe library — ready-made network templates (feedback tunnel, particle galaxy, reaction-diffusion, projection mapping, …) with their id, name, tags and difficulty. Offline. Apply one with apply_recipe.",
      inputSchema: listRecipesSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => listRecipesImpl(ctx, args),
  );
};
