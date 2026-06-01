import { describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import {
  readTouchDesignerLearningResource,
  registerTouchDesignerLearningResource,
} from "../../src/resources/touchDesignerLearningResource.js";
import { silentLogger } from "../../src/utils/logger.js";

function resourceCtx() {
  return {
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
}

describe("TouchDesigner learning resource", () => {
  it("builds a teach_touchdesigner learning path from existing KB resources", () => {
    const knowledge = new KnowledgeBase();
    const recipes = new RecipeLibrary();
    const resource = readTouchDesignerLearningResource(knowledge);
    const categories = new Set(knowledge.listOperatorCategories());

    expect(resource.uri).toBe("tdmcp://learning/touchdesigner");
    expect(resource.prompt.name).toBe("teach_touchdesigner");
    expect(resource.prompt.resourceUri).toBe("tdmcp://prompts");
    expect(resource.modules.length).toBeGreaterThanOrEqual(4);

    for (const module of resource.modules) {
      expect(module.operatorResources.length + module.tutorialResources.length).toBeGreaterThan(0);
      expect("prompt_topic" in module).toBe(false);
      expect("operator_resources" in module).toBe(false);
      expect("tutorial_resources" in module).toBe(false);
      expect("recipe_resources" in module).toBe(false);
      for (const uri of module.operatorResources) {
        const category = uri.replace("tdmcp://operators/", "");
        expect(categories.has(category)).toBe(true);
      }
      for (const uri of module.tutorialResources) {
        const id = uri.replace("tdmcp://tutorials/", "");
        expect(knowledge.getTutorial(id)).toBeDefined();
      }
      for (const uri of module.recipeResources) {
        const id = uri.replace("tdmcp://recipes/", "");
        expect(recipes.get(id)).toBeDefined();
      }
    }
  });

  it("registers tdmcp://learning/touchdesigner as an application/json resource", async () => {
    const calls: Array<{
      name: string;
      uri: string;
      metadata: { mimeType?: string };
      handler: (uri: URL) => Promise<{ contents: Array<{ mimeType?: string; text?: string }> }>;
    }> = [];
    const server = {
      registerResource: (
        name: string,
        uri: string,
        metadata: { mimeType?: string },
        handler: (uri: URL) => Promise<{ contents: Array<{ mimeType?: string; text?: string }> }>,
      ) => {
        calls.push({ name, uri, metadata, handler });
      },
    };

    registerTouchDesignerLearningResource(server as never, resourceCtx() as never);

    expect(calls[0]?.name).toBe("td-learning-touchdesigner");
    expect(calls[0]?.uri).toBe("tdmcp://learning/touchdesigner");
    expect(calls[0]?.metadata.mimeType).toBe("application/json");

    const result = await calls[0]?.handler(new URL("tdmcp://learning/touchdesigner"));
    const payload = JSON.parse(result?.contents[0]?.text ?? "{}");

    expect(result?.contents[0]?.mimeType).toBe("application/json");
    expect(payload.modules.map((mod: { id: string }) => mod.id)).toContain("glsl-shaders");
    expect(payload.prompt.resourceUri).toBe("tdmcp://prompts");
    expect(payload.prompt.resource_uri).toBeUndefined();
    expect(payload.modules[0].operatorResources).toBeDefined();
    expect(payload.modules[0].operator_resources).toBeUndefined();
  });
});
