import { describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { registerAllResources } from "../../src/resources/index.js";
import { silentLogger } from "../../src/utils/logger.js";

describe("resource registry", () => {
  it("registers the persistent session profile resource", () => {
    const calls: Array<{ name: string; uriOrTemplate: unknown; metadata: { mimeType?: string } }> =
      [];
    const server = {
      registerResource(
        name: string,
        uriOrTemplate: unknown,
        metadata: { mimeType?: string },
        _handler: unknown,
      ) {
        calls.push({ name, uriOrTemplate, metadata });
      },
    };

    registerAllResources(server as never, {
      knowledge: new KnowledgeBase({ logger: silentLogger }),
      logger: silentLogger,
      recipes: new RecipeLibrary(),
    });

    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "td-session-profile",
          uriOrTemplate: "tdmcp://session/profile",
          metadata: expect.objectContaining({ mimeType: "application/json" }),
        }),
      ]),
    );
  });
});
