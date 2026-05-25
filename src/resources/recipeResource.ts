import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { firstVar, jsonContents, type ResourceRegistrar } from "./shared.js";

export const registerRecipeResource: ResourceRegistrar = (server, ctx) => {
  const template = new ResourceTemplate("tdmcp://recipes/{recipe_name}", {
    list: async () => ({
      resources: ctx.recipes.list().map((recipe) => ({
        uri: `tdmcp://recipes/${recipe.id}`,
        name: recipe.name,
        description: `${recipe.difficulty} — ${recipe.description}`,
        mimeType: "application/json",
      })),
    }),
  });

  server.registerResource(
    "td-recipes",
    template,
    {
      title: "Composite network recipes",
      description: "Pre-validated composite network templates (nodes + connections + parameters).",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const name = firstVar(variables.recipe_name);
      const recipe = ctx.recipes.get(name);
      if (!recipe) {
        return jsonContents(uri, {
          error: `Recipe "${name}" not found.`,
          available: ctx.recipes.list().map((r) => r.id),
        });
      }
      return jsonContents(uri, recipe);
    },
  );
};
