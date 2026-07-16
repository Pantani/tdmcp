import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import {
  artistWorkspaceReceiptSchema,
  manageArtistWorkspaceImpl,
  manageArtistWorkspaceSchema,
  registerManageArtistWorkspace,
} from "../../src/tools/layer2/manageArtistWorkspace.js";
import type { ToolContext } from "../../src/tools/types.js";

const id = "workspace_opaque_123456789";
const fingerprint = "a".repeat(64);

const activeReceipt = {
  workspace_id: id,
  action: "open" as const,
  status: "active" as const,
  deduplicated: false,
  created_at: 10,
  expires_at: 310,
  targets: {
    network_path: "/project1/network",
    viewer_path: "/project1/network/out1",
    viewer_mode: "top_output" as const,
    split_ratio: 0.62,
  },
  source_pane: { id: 1, name: "network", type: "NETWORKEDITOR" as const },
  owned_pane: { id: 2, name: "tdmcp_workspace_123", type: "TOPVIEWER" as const },
  baseline: { pane_count: 1, fingerprint },
  workspace: { pane_count: 2, fingerprint: `b${fingerprint.slice(1)}` },
  cleanup: {
    attempted: false,
    owned_pane_closed: false,
    source_restored: false,
    baseline_verified: false,
  },
  reason: null,
  warnings: [],
  undo_label: null,
};

function context(manageArtistWorkspace: (request: unknown) => Promise<unknown>): ToolContext {
  return { client: { manageArtistWorkspace } } as unknown as ToolContext;
}

function text(result: Awaited<ReturnType<typeof manageArtistWorkspaceImpl>>) {
  const block = result.content[0];
  return block?.type === "text" ? block.text : "";
}

describe("manage_artist_workspace", () => {
  it("applies strict open defaults and calls only the structured client", async () => {
    const manageArtistWorkspace = vi.fn(async () => activeReceipt);
    const executePythonScript = vi.fn();
    const ctx = {
      client: { manageArtistWorkspace, executePythonScript },
    } as unknown as ToolContext;

    const result = await manageArtistWorkspaceImpl(ctx, {
      action: "open",
      network_path: "/project1/network",
      viewer_path: "/project1/network/out1",
      viewer_mode: "top_output",
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(activeReceipt);
    expect(text(result)).toContain("read back");
    expect(manageArtistWorkspace).toHaveBeenCalledWith({
      action: "open",
      network_path: "/project1/network",
      viewer_path: "/project1/network/out1",
      viewer_mode: "top_output",
      split_ratio: 0.62,
      lease_seconds: 300,
    });
    expect(executePythonScript).not.toHaveBeenCalled();
  });

  it("accepts only bounded action-specific fields", () => {
    expect(
      manageArtistWorkspaceSchema.safeParse({
        action: "open",
        network_path: "/project1/network",
        viewer_path: "/project1/panel",
        viewer_mode: "panel_controls",
      }).success,
    ).toBe(true);
    expect(
      manageArtistWorkspaceSchema.safeParse({
        action: "open",
        network_path: "relative",
        viewer_path: "/project1/panel",
        viewer_mode: "panel_controls",
      }).success,
    ).toBe(false);
    expect(
      manageArtistWorkspaceSchema.safeParse({
        action: "open",
        network_path: "/project1/network",
        viewer_path: "/project1/panel",
        viewer_mode: "panel_controls",
        split_ratio: 0.9,
      }).success,
    ).toBe(false);
    expect(
      manageArtistWorkspaceSchema.safeParse({ action: "status", workspace_id: id, force: true })
        .success,
    ).toBe(false);
    expect(
      manageArtistWorkspaceSchema.safeParse({ action: "restore", workspace_id: "short" }).success,
    ).toBe(false);
  });

  it("rejects false active and false restored receipts", async () => {
    expect(
      artistWorkspaceReceiptSchema.safeParse({ ...activeReceipt, owned_pane: null }).success,
    ).toBe(false);
    expect(
      artistWorkspaceReceiptSchema.safeParse({
        ...activeReceipt,
        status: "restored",
        cleanup: { ...activeReceipt.cleanup, attempted: true },
      }).success,
    ).toBe(false);

    const result = await manageArtistWorkspaceImpl(
      context(async () => ({ ...activeReceipt, workspace: null })),
      { action: "status", workspace_id: id },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      status: "failed",
      error: { code: "INVALID_BRIDGE_RESPONSE" },
    });
  });

  it("renders verified restore and pre-apply cancel without overstating cleanup", async () => {
    const restored = {
      ...activeReceipt,
      action: "restore" as const,
      status: "restored" as const,
      expires_at: null,
      cleanup: {
        attempted: true,
        owned_pane_closed: true,
        source_restored: true,
        baseline_verified: true,
      },
    };
    const restoredResult = await manageArtistWorkspaceImpl(
      context(async () => restored),
      { action: "restore", workspace_id: id },
    );
    expect(restoredResult.isError).toBeFalsy();
    expect(text(restoredResult)).toContain("later-frame baseline matched");

    const cancelled = {
      ...activeReceipt,
      action: "cancel" as const,
      status: "cancelled" as const,
      expires_at: null,
      source_pane: null,
      owned_pane: null,
      baseline: null,
      workspace: null,
      reason: "client_cancelled" as const,
    };
    const cancelledResult = await manageArtistWorkspaceImpl(
      context(async () => cancelled),
      { action: "cancel", workspace_id: id },
    );
    expect(cancelledResult.isError).toBeFalsy();
    expect(text(cancelledResult)).toContain("before it changed the editor");
  });

  it("surfaces CAS conflict as an MCP error with the full receipt", async () => {
    const conflict = {
      ...activeReceipt,
      action: "restore" as const,
      status: "conflicted" as const,
      expires_at: null,
      reason: "artist_layout_changed" as const,
    };
    const result = await manageArtistWorkspaceImpl(
      context(async () => conflict),
      { action: "restore", workspace_id: id },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual(conflict);
    expect(text(result)).toContain("artist layout changed");
  });

  it("registers one non-destructive UI-only tool with the structured schemas", () => {
    const registerTool = vi.fn();
    registerManageArtistWorkspace(
      { registerTool } as unknown as McpServer,
      context(async () => activeReceipt),
    );

    const [name, config] = registerTool.mock.calls[0] as [
      string,
      {
        annotations: Record<string, boolean>;
        description: string;
        inputSchema: unknown;
        outputSchema: unknown;
      },
    ];
    expect(name).toBe("manage_artist_workspace");
    expect(config.inputSchema).toBe(manageArtistWorkspaceSchema);
    expect(config.outputSchema).toBe(artistWorkspaceReceiptSchema);
    expect(config.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(config.description).toContain("ALLOW_EXEC=0");
    expect(config.description).toContain("never opens arbitrary UI");
    expect(config.description).toContain("never");
    expect(config.description).not.toContain("raw Python fallback");
  });
});
