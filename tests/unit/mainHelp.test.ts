import { describe, expect, it } from "vitest";
import { renderMainHelp } from "../../src/cli/mainHelp.js";

describe("tdmcp top-level help", () => {
  it("documents the primary binary commands without starting the MCP server", () => {
    const help = renderMainHelp();

    expect(help).toContain("Usage: tdmcp");
    expect(help).toContain("serve");
    expect(help).toContain("--http --port");
    expect(help).toContain("install-bridge");
    expect(help).toContain("--verify/--wait");
    expect(help).toContain("install-client");
    expect(help).toContain("chat");
    expect(help).toContain("dashboard");
    expect(help).toContain("packages");
  });
});
