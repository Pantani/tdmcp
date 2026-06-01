import { describe, expect, it } from "vitest";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { readCookbookResource } from "../../src/resources/cookbookResource.js";
import { searchRecipeSummaries } from "../../src/resources/recipeResource.js";

describe("recipe search resource helpers", () => {
  it("searches recipes by keyword across id, name, description and tags", () => {
    const recipes = new RecipeLibrary();
    const result = searchRecipeSummaries(recipes, "feedback");

    expect(result.query).toBe("feedback");
    expect(result.count).toBeGreaterThan(0);
    expect(
      result.recipes.some((recipe) =>
        [recipe.id, recipe.name, recipe.description, ...(recipe.tags ?? [])]
          .join(" ")
          .toLowerCase()
          .includes("feedback"),
      ),
    ).toBe(true);
  });
});

describe("cookbook resource helpers", () => {
  it("reads the English prompt cookbook as a compact MCP resource payload", () => {
    const result = readCookbookResource("en");

    expect(result.locale).toBe("en");
    expect(result.title.toLowerCase()).toContain("prompt cookbook");
    expect(result.text).toContain("tdmcp");
    expect(result.bytes).toBeGreaterThan(1000);
  });

  it("reads the Portuguese prompt cookbook separately", () => {
    const result = readCookbookResource("pt");

    expect(result.locale).toBe("pt");
    expect(result.title.toLowerCase()).toContain("prompt");
    expect(result.text).toContain("tdmcp");
  });
});
