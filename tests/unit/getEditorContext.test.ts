import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  getEditorContextImpl,
  getEditorContextSchema,
} from "../../src/tools/layer3/getEditorContext.js";
import type { ToolContext } from "../../src/tools/types.js";

function makeCtx(client: object): ToolContext {
  return { client } as unknown as ToolContext;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

describe("get_editor_context", () => {
  it("has an empty input schema", () => {
    expect(getEditorContextSchema.parse({})).toEqual({});
  });

  it("returns compact structured context and honest UI warnings", async () => {
    const getEditorContext = vi.fn().mockResolvedValue({
      project: { name: "show.toe", folder: "/shows", build: "2023.12000" },
      perform_mode: true,
      panes: [],
      warnings: ["Network Editor is unavailable in perform mode."],
    });

    const result = await getEditorContextImpl(makeCtx({ getEditorContext }), {});

    expect(getEditorContext).toHaveBeenCalledOnce();
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("perform mode");
    expect(result.structuredContent).toMatchObject({
      project: { name: "show.toe" },
      perform_mode: true,
      panes: [],
      warnings: ["Network Editor is unavailable in perform mode."],
    });
  });

  it("returns a friendly error when the structured endpoint fails", async () => {
    const result = await getEditorContextImpl(
      makeCtx({ getEditorContext: vi.fn().mockRejectedValue(new Error("bridge offline")) }),
      {},
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("bridge offline");
  });
});
