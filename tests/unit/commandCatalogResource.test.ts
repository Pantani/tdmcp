import { describe, expect, it } from "vitest";
import { listAgentCommands } from "../../src/cli/agent.js";
import { readCommandCatalogResource } from "../../src/resources/commandCatalogResource.js";

describe("command catalog resource helpers", () => {
  it("builds the tdmcp-agent command catalog from the actual CLI table", async () => {
    const actualCommands = listAgentCommands();
    const result = await readCommandCatalogResource();

    expect(result.count).toBe(actualCommands.length);
    expect(result.commands).toEqual(actualCommands);
    expect(result.count).toBeGreaterThan(100);
    expect(result.commands).toContainEqual(
      expect.objectContaining({
        command: "nodes find",
        summary: expect.stringContaining("Search nodes"),
        mutates: false,
        unsafe: false,
      }),
    );
    expect(result.commands).toContainEqual(
      expect.objectContaining({
        command: "hardware-diagnose",
        summary: expect.stringContaining("Preflight bridge"),
        mutates: false,
        unsafe: false,
        source: "tool",
      }),
    );
  }, 10_000);
});
