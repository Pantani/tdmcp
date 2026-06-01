import { describe, expect, it } from "vitest";
import { readCommandCatalogResource } from "../../src/resources/commandCatalogResource.js";

describe("command catalog resource helpers", () => {
  it("builds the tdmcp-agent command catalog from the actual CLI table", async () => {
    const result = await readCommandCatalogResource();

    expect(result.count).toBeGreaterThan(100);
    expect(result.commands).toContainEqual(
      expect.objectContaining({
        command: "nodes find",
        summary: expect.stringContaining("Search nodes"),
        mutates: false,
        unsafe: false,
      }),
    );
  }, 10_000);
});
