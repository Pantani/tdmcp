import { describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { registerAllPrompts } from "../../src/prompts/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { collectPromptCatalog } from "../../src/resources/promptCatalogResource.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeStubServer } from "../helpers/promptHarness.js";

function promptCtx() {
  return {
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
}

describe("prompt catalog resource", () => {
  it("derives the catalog from the actual prompt registry", () => {
    const ctx = promptCtx();
    const { server, prompts } = makeStubServer();
    registerAllPrompts(server as never, ctx);

    const catalog = collectPromptCatalog(ctx);
    expect(catalog.map((p) => p.name)).toEqual(prompts.map((p) => p.name));
    expect(catalog.map((p) => p.name)).toContain("teach_touchdesigner");
    expect(catalog.map((p) => p.name)).toContain("design_brief");
    expect(catalog.find((p) => p.name === "design_brief")?.summary).toContain(
      "persistent aesthetic direction",
    );
  });
});
