import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  editTdNodeMetadataImpl,
  editTdNodeMetadataSchema,
} from "../../src/tools/layer3/editTdNodeMetadata.js";
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

describe("edit_td_node_metadata", () => {
  it("requires at least one bounded metadata field", () => {
    expect(() => editTdNodeMetadataSchema.parse({ path: "/project1/noise1" })).toThrow(
      "Provide at least one metadata field",
    );
    expect(() =>
      editTdNodeMetadataSchema.parse({ path: "/project1/noise1", color: [1.1, 0, 0] }),
    ).toThrow();
    expect(
      editTdNodeMetadataSchema.parse({
        path: "/project1/noise1",
        name: "texture_noise",
        node_x: 260,
        node_y: -200,
        viewer: true,
      }),
    ).toMatchObject({ name: "texture_noise", node_x: 260, viewer: true });
  });

  it("forwards the complete structured edit and reports per-field readback", async () => {
    const editNodeMetadata = vi.fn().mockResolvedValue({
      original_path: "/project1/noise1",
      final_path: "/project1/visuals/texture_noise",
      applied: true,
      rolled_back: false,
      fields: {
        parent_path: {
          requested: "/project1/visuals",
          actual: "/project1/visuals",
          status: "applied",
        },
        name: { requested: "texture_noise", actual: "texture_noise", status: "applied" },
        node_x: { requested: 260, actual: 260, status: "applied" },
      },
      undo_label: "MCP edit_td_node_metadata /project1/noise1",
    });
    const args = {
      path: "/project1/noise1",
      parent_path: "/project1/visuals",
      name: "texture_noise",
      node_x: 260,
    };

    const result = await editTdNodeMetadataImpl(makeCtx({ editNodeMetadata }), args);

    expect(editNodeMetadata).toHaveBeenCalledWith(args);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Edited 3 metadata field(s)");
    expect(textOf(result)).toContain("/project1/visuals/texture_noise");
  });

  it("marks a partial failure as an error and preserves rollback evidence", async () => {
    const result = await editTdNodeMetadataImpl(
      makeCtx({
        editNodeMetadata: vi.fn().mockResolvedValue({
          original_path: "/project1/noise1",
          final_path: "/project1/noise1",
          applied: false,
          rolled_back: true,
          fields: {
            name: {
              requested: "renamed",
              actual: "noise1",
              status: "rolled_back",
              error: "display flag rejected",
            },
          },
        }),
      }),
      { path: "/project1/noise1", name: "renamed", display: true },
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("partial edit was rolled back");
    expect(textOf(result)).toContain('"rolled_back": true');
  });

  it("rejects empty edits defensively even when called without schema parsing", async () => {
    const editNodeMetadata = vi.fn();
    const result = await editTdNodeMetadataImpl(makeCtx({ editNodeMetadata }), {
      path: "/project1/noise1",
    });

    expect(result.isError).toBe(true);
    expect(editNodeMetadata).not.toHaveBeenCalled();
    expect(textOf(result)).toContain("at least one metadata field");
  });

  it("surfaces bridge failure without a raw-exec retry", async () => {
    const editNodeMetadata = vi.fn().mockRejectedValue(new Error("metadata rollback failed"));
    const result = await editTdNodeMetadataImpl(makeCtx({ editNodeMetadata }), {
      path: "/project1/noise1",
      comment: "hero texture",
    });

    expect(editNodeMetadata).toHaveBeenCalledOnce();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("metadata rollback failed");
  });
});
