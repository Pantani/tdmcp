import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { TdApiError, TdConnectionError } from "../../src/td-client/types.js";
import {
  registerSearchTdCode,
  searchTdCodeImpl,
  searchTdCodeSchema,
} from "../../src/tools/layer3/searchTdCode.js";
import type { ToolContext } from "../../src/tools/types.js";

const report = {
  query: "reset feedback buffer",
  root_path: "/project1/live",
  max_depth: 3,
  source_kinds: ["dat_text", "parameter_expression"] as const,
  results: [
    {
      op: "/project1/live/callbacks",
      type: "textDAT",
      family: "DAT" as const,
      source_kind: "dat_text" as const,
      field: "text",
      line: 7,
      column: 5,
      excerpt: "reset_feedback_buffer()",
      score: 4.25,
      rank_sources: ["literal", "bm25"] as const,
    },
  ],
  scanned_nodes: 4,
  scanned_documents: 7,
  scanned_parameters: 120,
  scanned_bytes: 2048,
  matched: 1,
  returned: 1,
  limit: 50,
  truncated: false,
  scan_truncated: false,
  count_complete: true,
  unreadable_documents: 0,
  skipped_documents: 2,
  redacted_documents: 1,
  stop_reason: "completed" as const,
  elapsed_ms: 4,
};

function ctx(searchCode: (request: unknown) => Promise<unknown>): ToolContext {
  return { client: { searchCode } } as unknown as ToolContext;
}

function text(result: Awaited<ReturnType<typeof searchTdCodeImpl>>) {
  const block = result.content[0];
  return block?.type === "text" ? block.text : "";
}

describe("search_td_code", () => {
  it("maps every bounded filter to the structured client and returns structured content", async () => {
    const searchCode = vi.fn(async () => report);
    const result = await searchTdCodeImpl(ctx(searchCode), {
      query: "reset feedback buffer",
      root_path: "/project1/live",
      max_depth: 4,
      source_kinds: ["dat_text"],
      node_pattern: "control",
      node_name_glob: "callback*",
      node_path_glob: "*/callbacks",
      type: "textDAT",
      type_match: "exact",
      family: "DAT",
      limit: 20,
      node_scan_limit: 900,
      document_scan_limit: 8_000,
      parameter_scan_limit: 12_000,
      byte_scan_limit: 1_048_576,
      time_budget_ms: 800,
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(report);
    expect(text(result)).toContain("1 code match(es)");
    expect(searchCode).toHaveBeenCalledWith({
      query: "reset feedback buffer",
      rootPath: "/project1/live",
      maxDepth: 4,
      sourceKinds: ["dat_text"],
      nodePattern: "control",
      nodeNameGlob: "callback*",
      nodePathGlob: "*/callbacks",
      type: "textDAT",
      typeMatch: "exact",
      family: "DAT",
      limit: 20,
      nodeScanLimit: 900,
      documentScanLimit: 8_000,
      parameterScanLimit: 12_000,
      byteScanLimit: 1_048_576,
      timeBudgetMs: 800,
    });
  });

  it("uses bounded defaults and marks incomplete counts honestly", async () => {
    const searchCode = vi.fn(async () => ({
      ...report,
      root_path: "/project1",
      matched: 7,
      returned: 1,
      truncated: true,
      scan_truncated: true,
      count_complete: false,
      stop_reason: "document_scan_limit" as const,
    }));
    const result = await searchTdCodeImpl(ctx(searchCode), { query: "feedback" });

    expect(searchCode).toHaveBeenCalledWith(
      expect.objectContaining({
        rootPath: "/project1",
        maxDepth: 3,
        sourceKinds: ["dat_text", "parameter_expression"],
        limit: 50,
        nodeScanLimit: 1_000,
        documentScanLimit: 10_000,
        parameterScanLimit: 25_000,
        byteScanLimit: 2 * 1_024 * 1_024,
        timeBudgetMs: 1_000,
      }),
    );
    expect(text(result)).toBe("At least 7 code match(es) under /project1; returning 1.");
  });

  it("returns typed update guidance when the structured route is missing", async () => {
    const searchCode = vi.fn(async () => {
      throw new TdApiError("Unsupported POST /api/code/search", {
        status: 404,
        apiCode: "not_found",
      });
    });
    const result = await searchTdCodeImpl(ctx(searchCode), { query: "feedback" });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Update or reinstall");
    expect(text(result)).toContain("will not fall back to raw Python");
    expect(result.structuredContent).toEqual({
      status: "failed",
      error: {
        code: "BRIDGE_UPDATE_REQUIRED",
        route: "POST /api/code/search",
        action: "update_or_reinstall_bridge",
      },
    });
    expect(searchCode).toHaveBeenCalledOnce();
  });

  it("surfaces current bridge failures without a second request", async () => {
    const disconnected = vi.fn(async () => {
      throw new TdConnectionError("TouchDesigner bridge unavailable");
    });
    const result = await searchTdCodeImpl(ctx(disconnected), { query: "feedback" });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("bridge unavailable");
    expect(disconnected).toHaveBeenCalledOnce();
  });

  it("rejects unsafe inputs and invalid bounds", () => {
    expect(searchTdCodeSchema.safeParse({ query: "" }).success).toBe(false);
    expect(searchTdCodeSchema.safeParse({ query: "***" }).success).toBe(false);
    expect(searchTdCodeSchema.safeParse({ query: "feedback\nsecret" }).success).toBe(false);
    expect(searchTdCodeSchema.safeParse({ query: "feedback", source_kinds: [] }).success).toBe(
      false,
    );
    expect(
      searchTdCodeSchema.safeParse({ query: "feedback", node_name_glob: "bad?glob" }).success,
    ).toBe(false);
    expect(searchTdCodeSchema.safeParse({ query: "feedback", time_budget_ms: 2_501 }).success).toBe(
      false,
    );
  });

  it("registers as read-only, bounded, and embedding-independent", () => {
    const registerTool = vi.fn();
    registerSearchTdCode(
      { registerTool } as unknown as McpServer,
      ctx(async () => report),
    );

    expect(registerTool).toHaveBeenCalledOnce();
    const [name, config] = registerTool.mock.calls[0] as [
      string,
      { annotations: Record<string, boolean>; description: string },
    ];
    expect(name).toBe("search_td_code");
    expect(config.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(config.description).toContain("redacted excerpts");
    expect(config.description).toContain("ALLOW_EXEC=0");
    expect(config.description).toContain("never falls back to raw Python");
    expect(config.description).toContain("embedding service");
  });
});
