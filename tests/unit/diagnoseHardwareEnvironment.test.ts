import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { TdConnectionError } from "../../src/td-client/types.js";
import {
  diagnoseHardwareEnvironmentImpl,
  diagnoseHardwareEnvironmentOutputSchema,
  diagnoseHardwareEnvironmentSchema,
} from "../../src/tools/layer3/diagnoseHardwareEnvironment.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

function fakeCtx(overrides: {
  getDatText?: ReturnType<typeof vi.fn>;
  getInfo?: ReturnType<typeof vi.fn>;
  getSystemInfo?: ReturnType<typeof vi.fn>;
}): ToolContext {
  return {
    client: {
      endpoint: "http://127.0.0.1:9980",
      getDatText: overrides.getDatText ?? vi.fn(),
      getInfo: overrides.getInfo ?? vi.fn(),
      getSystemInfo: overrides.getSystemInfo ?? vi.fn(),
    },
    logger: silentLogger,
  } as unknown as ToolContext;
}

function resultJson(result: CallToolResult): Record<string, unknown> {
  if (result.structuredContent) return result.structuredContent;
  const text = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  const match = /```json\n([\s\S]+?)\n```/.exec(text);
  if (!match?.[1]) throw new Error("result did not contain JSON block");
  return JSON.parse(match[1]) as Record<string, unknown>;
}

function expectOutputSchema(data: Record<string, unknown>) {
  expect(() => diagnoseHardwareEnvironmentOutputSchema.parse(data)).not.toThrow();
}

describe("diagnose_hardware_environment", () => {
  it("returns a fail report without throwing when TouchDesigner is offline", async () => {
    const ctx = fakeCtx({
      getInfo: vi.fn().mockRejectedValue(new TdConnectionError("connect ECONNREFUSED")),
    });

    const result = await diagnoseHardwareEnvironmentImpl(ctx, {
      include: ["bridge"],
      status_paths: [],
    });

    expect(result.isError).not.toBe(true);
    const data = resultJson(result);
    expectOutputSchema(data);
    expect(data.overall).toBe("fail");
    expect(data.connected).toBe(false);
    expect(data.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "bridge", status: "fail" })]),
    );
  });

  it("passes when bridge, display and status DATs are healthy", async () => {
    const ctx = fakeCtx({
      getInfo: vi.fn().mockResolvedValue({
        td_version: "2025.32820",
        bridge_version: "0.10.0",
      }),
      getSystemInfo: vi.fn().mockResolvedValue({
        monitors: [{ index: 0, width: 1920, height: 1080, refreshRate: 60, isPrimary: true }],
        performMode: true,
      }),
      getDatText: vi.fn().mockResolvedValue({
        path: "/project1/live_source/source_status",
        text: JSON.stringify({
          ok: true,
          sourceKind: "camera",
          stale: false,
          state: "running",
          width: 1280,
          height: 720,
        }),
      }),
    });

    const result = await diagnoseHardwareEnvironmentImpl(ctx, {
      expected_min_monitors: 1,
      include: ["bridge", "display", "status_surfaces"],
      status_paths: ["/project1/live_source/source_status"],
    });

    const data = resultJson(result);
    expectOutputSchema(data);
    expect(data.overall).toBe("pass");
    expect(data.connected).toBe(true);
    expect(data.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "bridge", status: "pass" }),
        expect.objectContaining({ id: "display", status: "pass" }),
        expect.objectContaining({
          id: "status:/project1/live_source/source_status",
          status: "pass",
        }),
      ]),
    );
  });

  it("warns when the room has fewer displays than expected", async () => {
    const ctx = fakeCtx({
      getInfo: vi.fn().mockResolvedValue({ td_version: "2025.32820" }),
      getSystemInfo: vi.fn().mockResolvedValue({
        monitors: [{ index: 0, width: 1920, height: 1080 }],
      }),
    });

    const result = await diagnoseHardwareEnvironmentImpl(ctx, {
      expected_min_monitors: 2,
      include: ["bridge", "display"],
      status_paths: [],
    });

    const data = resultJson(result);
    expectOutputSchema(data);
    expect(data.overall).toBe("warning");
    expect(data.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "display", status: "warning" })]),
    );
  });

  it("fails a stale or unhealthy generated status DAT", async () => {
    const ctx = fakeCtx({
      getInfo: vi.fn().mockResolvedValue({ td_version: "2025.32820" }),
      getDatText: vi.fn().mockResolvedValue({
        path: "/project1/kinect_wall_harp/bridge_status",
        text: JSON.stringify({
          ok: false,
          stale: true,
          state: "stalled",
          error: "no frames received",
        }),
      }),
    });

    const result = await diagnoseHardwareEnvironmentImpl(ctx, {
      include: ["bridge", "status_surfaces"],
      status_paths: ["/project1/kinect_wall_harp/bridge_status"],
    });

    const data = resultJson(result);
    expectOutputSchema(data);
    expect(data.overall).toBe("fail");
    expect(data.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "status:/project1/kinect_wall_harp/bridge_status",
          status: "fail",
        }),
      ]),
    );
  });

  it("schema rejects an empty include list", () => {
    expect(() => diagnoseHardwareEnvironmentSchema.parse({ include: [] })).toThrow();
  });
});
