import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { TdApiError, TdConnectionError } from "../../src/td-client/types.js";
import {
  findTdParametersImpl,
  findTdParametersSchema,
  registerFindTdParameters,
} from "../../src/tools/layer3/findTdParameters.js";
import type { ToolContext } from "../../src/tools/types.js";

const report = {
  root_path: "/project1/live",
  max_depth: 3,
  results: [
    {
      op: "/project1/live/noise1",
      type: "noiseTOP",
      family: "TOP" as const,
      par: "amplitude",
      value: 0.75,
      expr: "absTime.seconds",
      mode: "EXPRESSION" as const,
      non_default: true,
    },
  ],
  scanned_nodes: 4,
  scanned_parameters: 120,
  matched: 1,
  returned: 1,
  limit: 100,
  truncated: false,
  scan_truncated: false,
  count_complete: true,
  unreadable_parameters: 0,
  skipped_parameters: 2,
  redacted_parameters: 0,
  stop_reason: "completed" as const,
  elapsed_ms: 4,
};

function ctx(searchParameters: (request: unknown) => Promise<unknown>): ToolContext {
  return { client: { searchParameters } } as unknown as ToolContext;
}

function text(result: Awaited<ReturnType<typeof findTdParametersImpl>>) {
  const block = result.content[0];
  return block?.type === "text" ? block.text : "";
}

describe("find_td_parameters", () => {
  it("maps every bounded filter to the structured client and returns structured content", async () => {
    const searchParameters = vi.fn(async () => report);
    const result = await findTdParametersImpl(ctx(searchParameters), {
      root_path: "/project1/live",
      max_depth: 4,
      node_pattern: "noise",
      node_name_glob: "noise*",
      node_path_glob: "*/noise1",
      type: "noiseTOP",
      type_match: "exact",
      family: "TOP",
      parameter_glob: "amp*",
      value_glob: "0.*",
      expression_glob: "*seconds",
      mode: "EXPRESSION",
      non_default_only: true,
      limit: 20,
      node_scan_limit: 900,
      parameter_scan_limit: 12_000,
      time_budget_ms: 800,
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(report);
    expect(text(result)).toContain("1 parameter match(es)");
    expect(searchParameters).toHaveBeenCalledOnce();
    expect(searchParameters).toHaveBeenCalledWith({
      rootPath: "/project1/live",
      maxDepth: 4,
      nodePattern: "noise",
      nodeNameGlob: "noise*",
      nodePathGlob: "*/noise1",
      type: "noiseTOP",
      typeMatch: "exact",
      family: "TOP",
      parameterGlob: "amp*",
      valueGlob: "0.*",
      expressionGlob: "*seconds",
      mode: "EXPRESSION",
      nonDefaultOnly: true,
      limit: 20,
      nodeScanLimit: 900,
      parameterScanLimit: 12_000,
      timeBudgetMs: 800,
    });
  });

  it("uses bounded defaults and marks an incomplete count honestly", async () => {
    const searchParameters = vi.fn(async () => ({
      ...report,
      root_path: "/project1",
      matched: 7,
      returned: 1,
      truncated: true,
      scan_truncated: true,
      count_complete: false,
      stop_reason: "parameter_scan_limit" as const,
    }));
    const result = await findTdParametersImpl(ctx(searchParameters), {});

    expect(searchParameters).toHaveBeenCalledWith(
      expect.objectContaining({
        rootPath: "/project1",
        maxDepth: 3,
        limit: 100,
        nodeScanLimit: 1_000,
        parameterScanLimit: 25_000,
        timeBudgetMs: 1_000,
      }),
    );
    expect(text(result)).toBe("At least 7 parameter match(es) under /project1; returning 1.");
  });

  it("returns typed update guidance when the structured route is missing", async () => {
    const searchParameters = vi.fn(async () => {
      throw new TdApiError("Unsupported POST /api/params/search", {
        status: 400,
        apiCode: "invalid_input",
      });
    });
    const result = await findTdParametersImpl(ctx(searchParameters), { parameter_glob: "gain*" });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Update or reinstall");
    expect(text(result)).toContain("will not fall back to raw Python");
    expect(result.structuredContent).toEqual({
      status: "failed",
      error: {
        code: "BRIDGE_UPDATE_REQUIRED",
        route: "POST /api/params/search",
        action: "update_or_reinstall_bridge",
      },
    });
    expect(searchParameters).toHaveBeenCalledOnce();
  });

  it("surfaces current validation and connection failures without a second request", async () => {
    const validation = vi.fn(async () => {
      throw new TdApiError("limit must be between 1 and 200", {
        status: 400,
        apiCode: "invalid_input",
      });
    });
    const rejected = await findTdParametersImpl(ctx(validation), { parameter_glob: "gain*" });
    expect(rejected.isError).toBe(true);
    expect(text(rejected)).toContain("[invalid_input]");
    expect(validation).toHaveBeenCalledOnce();

    const disconnected = vi.fn(async () => {
      throw new TdConnectionError("TouchDesigner bridge unavailable");
    });
    const unavailable = await findTdParametersImpl(ctx(disconnected), {
      parameter_glob: "gain*",
    });
    expect(unavailable.isError).toBe(true);
    expect(text(unavailable)).toContain("bridge unavailable");
    expect(disconnected).toHaveBeenCalledOnce();
  });

  it("rejects unsafe globs, invalid bounds and an unscoped broad root", () => {
    expect(findTdParametersSchema.safeParse({ parameter_glob: "bad?glob" }).success).toBe(false);
    expect(findTdParametersSchema.safeParse({ time_budget_ms: 2_501 }).success).toBe(false);
    expect(findTdParametersSchema.safeParse({ root_path: "/" }).success).toBe(false);
    expect(
      findTdParametersSchema.safeParse({ root_path: "/", parameter_glob: "gain*" }).success,
    ).toBe(true);
  });

  it("registers as read-only and open-world", () => {
    const registerTool = vi.fn();
    registerFindTdParameters(
      { registerTool } as unknown as McpServer,
      ctx(async () => report),
    );

    expect(registerTool).toHaveBeenCalledOnce();
    const [name, config] = registerTool.mock.calls[0] as [
      string,
      { annotations: Record<string, boolean>; description: string },
    ];
    expect(name).toBe("find_td_parameters");
    expect(config.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(config.description).toContain("point-in-time");
    expect(config.description).toContain("redacted");
    expect(config.description).toContain("never falls back to raw Python");
  });
});
