import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { recipeFromMarkdown, recipeToMarkdown } from "../../src/recipes/markdown.js";
import { RecipeSchema } from "../../src/recipes/schema.js";
import { Vault } from "../../src/vault/index.js";

const recipe = RecipeSchema.parse({
  id: "vault_demo",
  name: "Vault Demo",
  description: "A tiny demo.",
  tags: ["demo", "test"],
  difficulty: "beginner",
  nodes: [
    { name: "noise1", type: "noiseTOP", parameters: { period: 4 } },
    { name: "out1", type: "nullTOP" },
  ],
  connections: [{ from: "noise1", to: "out1" }],
});

describe("recipe markdown codec", () => {
  it("round-trips a recipe through markdown", () => {
    expect(recipeFromMarkdown(recipeToMarkdown(recipe))).toEqual(recipe);
  });

  it("writes searchable metadata into frontmatter", () => {
    const md = recipeToMarkdown(recipe);
    expect(md.startsWith("---")).toBe(true);
    expect(md).toContain("id: vault_demo");
    expect(md).toContain("tdmcp-recipe");
  });

  it("throws when the note has no recipe block", () => {
    expect(() => recipeFromMarkdown("---\nid: x\n---\njust prose")).toThrow(/code block/);
  });
});

describe("RecipeLibrary + vault", () => {
  it("loads vault recipes and overrides built-ins by id", () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-recipes-"));
    try {
      const vault = new Vault(dir);
      vault.write("Recipes/vault_demo.md", recipeToMarkdown(recipe));
      const override = RecipeSchema.parse({ ...recipe, id: "feedback_tunnel", name: "My Tunnel" });
      vault.write("Recipes/feedback_tunnel.md", recipeToMarkdown(override));

      const lib = new RecipeLibrary({ vault });
      expect(lib.get("vault_demo")?.name).toBe("Vault Demo");
      // a built-in id present in the vault is replaced by the vault version
      expect(lib.get("feedback_tunnel")?.name).toBe("My Tunnel");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
