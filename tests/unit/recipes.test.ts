import { describe, expect, it } from "vitest";
import { RecipeLibrary } from "../../src/recipes/loader.js";

const library = new RecipeLibrary();

describe("RecipeLibrary", () => {
  it("loads the starter recipes", () => {
    const ids = library.list().map((r) => r.id);
    expect(ids).toContain("feedback_tunnel");
    expect(ids).toContain("noise_landscape");
    expect(ids).toContain("reaction_diffusion");
  });

  it("returns a recipe by id with nodes and connections", () => {
    const recipe = library.get("feedback_tunnel");
    expect(recipe).toBeDefined();
    expect(recipe?.nodes.length).toBeGreaterThan(0);
    expect(recipe?.connections.length).toBeGreaterThan(0);
  });

  it("matches recipes by tag", () => {
    const recipe = library.findByTags(["feedback"]);
    expect(recipe?.id).toBe("feedback_tunnel");
  });

  it("carries GLSL code for the reaction-diffusion recipe", () => {
    const recipe = library.get("reaction_diffusion");
    expect(recipe?.glsl_code?.glsl1).toContain("uFeed");
  });
});
