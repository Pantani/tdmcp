import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("Claude Code plugin marketplace", () => {
  it("publishes the tdmcp plugin from the marketplace catalog", () => {
    const marketplace = JSON.parse(
      readFileSync(join(root, ".claude-plugin", "marketplace.json"), "utf8"),
    ) as {
      name?: string;
      owner?: { name?: string };
      plugins?: Array<{ name?: string; source?: string; description?: string }>;
    };

    expect(marketplace).toMatchObject({
      name: "tdmcp",
      owner: { name: "Pantani" },
    });
    expect(marketplace.plugins).toContainEqual(
      expect.objectContaining({
        name: "tdmcp",
        source: "./plugins/tdmcp",
        description: expect.any(String),
      }),
    );
  });

  it("pins the Claude plugin MCP command to the package version", () => {
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      version?: string;
    };
    const plugin = JSON.parse(
      readFileSync(join(root, "plugins", "tdmcp", ".claude-plugin", "plugin.json"), "utf8"),
    ) as {
      version?: string;
      mcpServers?: { tdmcp?: { command?: string; args?: string[]; env?: Record<string, string> } };
    };

    expect(plugin.version).toBe(packageJson.version);
    expect(plugin.mcpServers?.tdmcp).toMatchObject({
      command: "npx",
      args: ["--yes", `--package=@dpantani/tdmcp@${packageJson.version}`, "tdmcp"],
      env: {
        TDMCP_TRANSPORT: "stdio",
        TDMCP_RAW_PYTHON: "off",
        TDMCP_TOOL_PROFILE: "safe",
      },
    });
  });
});
