import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { reloadBridgeImpl } from "../../src/tools/layer3/reloadBridge.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return { client: { executePythonScript: exec }, logger: silentLogger } as unknown as ToolContext;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

describe("reloadBridgeImpl", () => {
  it("summarises the count of reloaded modules from the TD report", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        reloaded: ["mcp.dev", "mcp.api", "utils.paths"],
        count: 3,
      }),
    }));
    const result = await reloadBridgeImpl(fakeCtx(exec));
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("3 bridge module(s)");
  });

  it("runs a reload script through executePythonScript with captureStdout=true", async () => {
    const exec = vi.fn(async (_script: string, _capture?: boolean) => ({
      stdout: JSON.stringify({ reloaded: [], count: 0 }),
    }));
    await reloadBridgeImpl(fakeCtx(exec));
    const script = exec.mock.calls[0]?.[0];
    const capture = exec.mock.calls[0]?.[1];
    expect(typeof script).toBe("string");
    expect(script).toContain("reload_bridge");
    expect(capture).toBe(true);
  });
});
