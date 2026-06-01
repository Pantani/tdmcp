import { describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import {
  readCheatsheetResource,
  registerCheatsheetResource,
} from "../../src/resources/cheatsheetResource.js";
import { silentLogger } from "../../src/utils/logger.js";

function resourceCtx() {
  return {
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
}

describe("cheatsheet resource", () => {
  it("returns a stable KB-grounded cheatsheet catalog", () => {
    const catalog = readCheatsheetResource();

    expect(catalog.uri).toBe("tdmcp://cheatsheets");
    expect(catalog.count).toBeGreaterThanOrEqual(4);
    expect(catalog.cheatsheets.map((sheet) => sheet.id)).toEqual(
      expect.arrayContaining(["operator-families", "glsl-top", "debug-loop"]),
    );
    expect(catalog.cheatsheets.every((sheet) => sheet.resourceRefs.length > 0)).toBe(true);
    expect(catalog.cheatsheets.flatMap((sheet) => sheet.resourceRefs)).toContain(
      "tdmcp://operators/TOP",
    );
    const firstSheet = catalog.cheatsheets[0];
    expect(firstSheet).toBeDefined();
    expect("resource_refs" in (firstSheet ?? {})).toBe(false);
    expect("when_to_use" in (firstSheet ?? {})).toBe(false);
  });

  it("registers tdmcp://cheatsheets as application/json", async () => {
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

    registerCheatsheetResource(server as never, resourceCtx() as never);

    expect(calls[0]?.name).toBe("td-cheatsheets");
    expect(calls[0]?.uri).toBe("tdmcp://cheatsheets");
    expect(calls[0]?.metadata.mimeType).toBe("application/json");

    const result = await calls[0]?.handler(new URL("tdmcp://cheatsheets"));
    const payload = JSON.parse(result?.contents[0]?.text ?? "{}");

    expect(result?.contents[0]?.mimeType).toBe("application/json");
    expect(payload.cheatsheets.some((sheet: { id: string }) => sheet.id === "debug-loop")).toBe(
      true,
    );
    expect(payload.cheatsheets[0].resourceRefs).toBeDefined();
    expect(payload.cheatsheets[0].resource_refs).toBeUndefined();
  });
});
