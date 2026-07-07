import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { TdApiError } from "../../src/td-client/types.js";
import { renderOutputImpl } from "../../src/tools/layer3/renderOutput.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

function fakeCtx(saveNode: ReturnType<typeof vi.fn>): ToolContext {
  return { client: { saveNode }, logger: silentLogger } as unknown as ToolContext;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

describe("renderOutputImpl", () => {
  it("reports the saved path and native dimensions on success", async () => {
    const saveNode = vi.fn(async () => ({
      path: "/project1/render1",
      saved: "/tmp/frame.png",
      has_dimensions: true,
      width: 1920,
      height: 1080,
    }));
    const result = await renderOutputImpl(fakeCtx(saveNode), {
      node_path: "/project1/render1",
      file: "/tmp/frame.png",
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/tmp/frame.png");
    expect(text).toContain("1920");
    expect(text).toContain("1080");
    // The tool forwarded the node path + file to the client method.
    expect(saveNode).toHaveBeenCalledWith("/project1/render1", "/tmp/frame.png");
  });

  it("omits dimensions when the saved node is not an image op (e.g. a COMP .tox)", async () => {
    const saveNode = vi.fn(async () => ({
      path: "/project1/base1",
      saved: "/tmp/base1.tox",
      has_dimensions: false,
    }));
    const result = await renderOutputImpl(fakeCtx(saveNode), {
      node_path: "/project1/base1",
      file: "/tmp/base1.tox",
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/tmp/base1.tox");
    expect(text).not.toContain("×");
  });

  it("returns a friendly error result when the save fails in TD", async () => {
    const saveNode = vi.fn(async () => {
      throw new TdApiError("save: node not found: /project1/missing");
    });
    const result = await renderOutputImpl(fakeCtx(saveNode), {
      node_path: "/project1/missing",
      file: "/tmp/frame.png",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("node not found");
  });
});
