import { describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import {
  readGlslSnippetCatalog,
  registerGlslSnippetCatalogResource,
} from "../../src/resources/glslSnippetCatalogResource.js";
import { silentLogger } from "../../src/utils/logger.js";

function resourceCtx() {
  return {
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
}

describe("GLSL snippet catalog resource", () => {
  it("summarizes every embedded GLSL technique as an assembly-ready snippet", () => {
    const catalog = readGlslSnippetCatalog(new KnowledgeBase());

    expect(catalog.uri).toBe("tdmcp://glsl-snippets");
    expect(catalog.count).toBeGreaterThan(0);
    expect(catalog.license_policy.status).toBe("tdmcp-vetted");
    expect(
      catalog.snippets.every((snippet) => snippet.resource_uri.startsWith("tdmcp://glsl/")),
    ).toBe(true);
    expect(catalog.snippets.some((snippet) => snippet.id === "raymarching_basic")).toBe(true);
    const raymarch = catalog.snippets.find((snippet) => snippet.id === "raymarching_basic");
    expect(raymarch?.snippet).toContain("raymarch");
    expect(raymarch?.operators).toContain("GLSL TOP");
  });

  it("registers tdmcp://glsl-snippets as an application/json resource", async () => {
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

    registerGlslSnippetCatalogResource(server as never, resourceCtx() as never);

    expect(calls[0]?.name).toBe("td-glsl-snippets");
    expect(calls[0]?.uri).toBe("tdmcp://glsl-snippets");
    expect(calls[0]?.metadata.mimeType).toBe("application/json");

    const result = await calls[0]?.handler(new URL("tdmcp://glsl-snippets"));
    const payload = JSON.parse(result?.contents[0]?.text ?? "{}");

    expect(result?.contents[0]?.mimeType).toBe("application/json");
    expect(payload.count).toBeGreaterThan(0);
    expect(payload.snippets[0].resource_uri).toMatch(/^tdmcp:\/\/glsl\//);
  });
});
