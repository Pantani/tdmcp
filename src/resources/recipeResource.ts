import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RecipeLibrary } from "../recipes/loader.js";
import type { RecipeSummary } from "../recipes/schema.js";
import { firstVar, jsonContents, type ResourceRegistrar } from "./shared.js";

export interface RecipeSearchResult {
  query: string;
  count: number;
  recipes: RecipeSummary[];
}

function recipeHaystack(recipe: RecipeSummary): string {
  return [recipe.id, recipe.name, recipe.description, recipe.difficulty, ...recipe.tags]
    .join(" ")
    .toLowerCase();
}

export function searchRecipeSummaries(recipes: RecipeLibrary, query: string): RecipeSearchResult {
  const needle = query.trim().toLowerCase();
  const all = recipes.list();
  const matched = needle ? all.filter((recipe) => recipeHaystack(recipe).includes(needle)) : all;
  return { query, count: matched.length, recipes: matched };
}

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

  const searchTemplate = new ResourceTemplate("tdmcp://recipes/search/{query}", {
    list: undefined,
  });

  server.registerResource(
    "td-recipes-search",
    searchTemplate,
    {
      title: "Search recipe catalog",
      description:
        "Keyword search over built-in and vault recipes by id, name, description, difficulty and tags.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const encodedQuery = firstVar(variables.query);
      let query: string;
      try {
        query = decodeURIComponent(encodedQuery);
      } catch {
        return jsonContents(uri, {
          error: "Invalid query encoding.",
          query: encodedQuery,
        });
      }
      return jsonContents(uri, searchRecipeSummaries(ctx.recipes, query));
    },
  );
};
