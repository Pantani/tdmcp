import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { TdConnectionError } from "../../src/td-client/types.js";
import { showPreflightReportImpl } from "../../src/tools/layer3/showPreflightReport.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

function makeCtx(overrides: Record<string, unknown> = {}): ToolContext {
  return {
    client: {
      getInfo: vi.fn(async () => ({ td_version: "2025.32820", bridge_version: "0.13.0" })),
      getNetworkErrors: vi.fn(async () => ({ errors: [] })),
      getNetworkTopology: vi.fn(async () => ({
        nodes: [{ path: "/project1/out1", type: "nullTOP", name: "out1" }],
        connections: [],
      })),
      getNetworkPerformance: vi.fn(async () => ({
        nodes: [{ path: "/project1/out1", cook_time_ms: 0.5 }],
        total_cook_time_ms: 0.5,
      })),
      getSystemInfo: vi.fn(async () => ({
        gpu: { name: "GPU" },
        monitors: [{ index: 0, width: 1920, height: 1080, refreshRate: 60, isPrimary: true }],
        performMode: true,
      })),
      ...overrides,
    },
    logger: silentLogger,
  } as unknown as ToolContext;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

describe("showPreflightReportImpl", () => {
  it("returns a PASS report when all read-only checks are clean", async () => {
    const result = await showPreflightReportImpl(makeCtx(), {
      root_path: "/project1",
      target_fps: 60,
      recursive: true,
      include_displays: true,
      include_performance: true,
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("PASS");
    expect(result.structuredContent).toMatchObject({
      status: "pass",
      summary: { fail: 0, warn: 0, unverified: 0 },
    });
  });

  it("fails the report when TD is offline but still returns structured diagnostics", async () => {
    const result = await showPreflightReportImpl(
      makeCtx({
        getInfo: vi.fn(async () => {
          throw new TdConnectionError("Cannot reach TouchDesigner");
        }),
      }),
      {
        root_path: "/project1",
        target_fps: 60,
        recursive: true,
        include_displays: false,
        include_performance: false,
      },
    );
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("FAIL");
    expect(result.structuredContent).toMatchObject({ status: "fail" });
  });

  it("warns when performance exceeds the frame budget", async () => {
    const result = await showPreflightReportImpl(
      makeCtx({
        getNetworkPerformance: vi.fn(async () => ({
          nodes: [{ path: "/project1/heavy", cook_time_ms: 30 }],
          total_cook_time_ms: 30,
        })),
      }),
      {
        root_path: "/project1",
        target_fps: 60,
        recursive: true,
        include_displays: false,
        include_performance: true,
      },
    );
    expect(result.structuredContent).toMatchObject({ status: "warn" });
    expect(textOf(result)).toContain("WARN");
  });

  it("marks performance as unverified instead of warn when no cooked samples exist yet", async () => {
    const result = await showPreflightReportImpl(
      makeCtx({
        getNetworkPerformance: vi.fn(async () => ({
          nodes: [{ path: "/project1/fresh", cook_time_ms: 30, cook_count: 0 }],
          total_cook_time_ms: 30,
        })),
      }),
      {
        root_path: "/project1",
        target_fps: 60,
        recursive: true,
        include_displays: false,
        include_performance: true,
      },
    );
    expect(result.structuredContent).toMatchObject({
      status: "unverified",
      summary: { warn: 0, fail: 0, unverified: 1 },
    });
    expect(textOf(result)).toContain("UNVERIFIED");
  });

  it("marks unavailable display topology as unverified instead of warn", async () => {
    const result = await showPreflightReportImpl(
      makeCtx({
        getSystemInfo: vi.fn(async () => ({
          gpu: { name: null },
          monitors: { error: "app.monitors unavailable on this TD build" },
          performMode: null,
        })),
      }),
      {
        root_path: "/project1",
        target_fps: 60,
        recursive: true,
        include_displays: true,
        include_performance: false,
      },
    );
    expect(result.structuredContent).toMatchObject({
      status: "unverified",
      summary: { warn: 0, fail: 0, unverified: 1 },
    });
    expect(textOf(result)).toContain("UNVERIFIED");
  });
});
