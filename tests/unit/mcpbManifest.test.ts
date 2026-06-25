import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function userConfigEnv(name: string): string {
  return `\${user_config.${name}}`;
}

describe("MCPB manifest safety controls", () => {
  it("exposes bridge auth and raw-tool profile controls to extension users", () => {
    const manifest = JSON.parse(readFileSync(join(root, "dxt", "manifest.json"), "utf8")) as {
      server?: { mcp_config?: { env?: Record<string, string> } };
      user_config?: Record<
        string,
        { type?: string; title?: string; default?: unknown; sensitive?: boolean }
      >;
    };

    expect(manifest.server?.mcp_config?.env).toMatchObject({
      TDMCP_BRIDGE_TOKEN: userConfigEnv("TDMCP_BRIDGE_TOKEN"),
      TDMCP_RAW_PYTHON: userConfigEnv("TDMCP_RAW_PYTHON"),
      TDMCP_TOOL_PROFILE: userConfigEnv("TDMCP_TOOL_PROFILE"),
    });
    expect(manifest.user_config?.TDMCP_BRIDGE_TOKEN).toMatchObject({
      type: "string",
      title: "TouchDesigner bridge token",
      default: "",
      // The bridge token is a secret: Claude Desktop must mask it and store it in
      // the OS keychain rather than render it in plain text.
      sensitive: true,
    });
    expect(manifest.user_config?.TDMCP_RAW_PYTHON).toMatchObject({
      type: "string",
      default: "on",
    });
    expect(manifest.user_config?.TDMCP_TOOL_PROFILE).toMatchObject({
      type: "string",
      default: "full",
    });
  });
});
