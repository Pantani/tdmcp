import { describe, expect, it } from "vitest";
import { renderMainCompletion, renderMainHelp } from "../../src/cli/mainHelp.js";

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
    expect(help).toContain("search [query]");
    expect(help).toContain("install <lib>");
    expect(help).toContain("packages path");
    expect(help).toContain("completion <shell>");
  });

  it("prints top-level shell completions including package commands", () => {
    const completion = renderMainCompletion("bash");

    expect(completion).toContain("complete -F _tdmcp tdmcp");
    expect(completion).toContain("install-bridge");
    expect(completion).toContain("install-client");
    expect(completion).toContain("search");
    expect(completion).toContain("install");
    expect(completion).toContain("packages");
    expect(completion).toContain("--dry-run");
    expect(completion).toContain("--json");
  });

  it("returns undefined for unsupported completion shells", () => {
    expect(renderMainCompletion("powershell")).toBeUndefined();
  });
});
