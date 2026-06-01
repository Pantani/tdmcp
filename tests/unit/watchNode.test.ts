import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerWatchNode,
  watchNodeImpl,
  watchNodeSchema,
} from "../../src/tools/layer3/watchNode.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return { client: { executePythonScript: exec }, logger: silentLogger } as unknown as ToolContext;
}

function dataOf(result: CallToolResult) {
  return (result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
}

describe("watchNodeSchema", () => {
  it("validates sampling bounds and applies deterministic defaults", () => {
    expect(watchNodeSchema.parse({ path: "/project1/noise1" })).toMatchObject({
      path: "/project1/noise1",
      samples: 3,
      interval_ms: 100,
    });

    expect(() => watchNodeSchema.parse({ path: "/project1/noise1", samples: 0 })).toThrow();
    expect(() => watchNodeSchema.parse({ path: "/project1/noise1", samples: 241 })).toThrow();
    expect(() => watchNodeSchema.parse({ path: "/project1/noise1", interval_ms: 15 })).toThrow();
    expect(() => watchNodeSchema.parse({ path: "/project1/noise1", interval_ms: 2001 })).toThrow();
  });
});

describe("watchNodeImpl", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("samples runtime state, parameters, and channels across deterministic intervals", async () => {
    const exec = vi
      .fn()
      .mockImplementationOnce(async () => {
        vi.advanceTimersByTime(7);
        return {
          stdout: JSON.stringify({
            path: "/project1/audio1",
            type: "audiodeviceinCHOP",
            family: "CHOP",
            state: {
              cook_time_ms: 0.5,
              cook_count: 10,
              num_chans: 2,
              num_samples: 512,
              errors: [],
            },
            parameters: { active: true, gain: 0.8 },
            channels: { chan1: 0.25, chan2: 0.75 },
            warnings: [],
          }),
        };
      })
      .mockImplementationOnce(async () => {
        vi.advanceTimersByTime(11);
        return {
          stdout: JSON.stringify({
            path: "/project1/audio1",
            type: "audiodeviceinCHOP",
            family: "CHOP",
            state: {
              cook_time_ms: 0.75,
              cook_count: 11,
              num_chans: 2,
              num_samples: 512,
              errors: [],
            },
            parameters: { active: true, gain: 0.8 },
            channels: { chan1: 0.3, chan2: 0.7 },
            warnings: [],
          }),
        };
      });

    const promise = watchNodeImpl(fakeCtx(exec), {
      path: "/project1/audio1",
      samples: 2,
      interval_ms: 50,
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.isError).toBeFalsy();
    expect(exec).toHaveBeenCalledTimes(2);
    expect(String(exec.mock.calls[0]?.[0])).not.toContain("* 1000.0");

    const data = dataOf(result) as {
      path: string;
      collected_samples: number;
      interval_ms: number;
      window_ms: number;
      snapshots: Array<{
        sample_index: number;
        elapsed_ms: number;
        state: Record<string, unknown>;
        parameters: Record<string, unknown>;
        channels: Record<string, number>;
      }>;
    };

    expect(data.path).toBe("/project1/audio1");
    expect(data.collected_samples).toBe(2);
    expect(data.interval_ms).toBe(50);
    expect(data.window_ms).toBe(68);
    expect(data.snapshots.map((s) => s.elapsed_ms)).toEqual([7, 68]);
    expect(data.snapshots[0]).toMatchObject({
      sample_index: 0,
      state: { cook_count: 10, num_chans: 2 },
      parameters: { gain: 0.8 },
      channels: { chan1: 0.25 },
    });
    expect(data.snapshots[1]).toMatchObject({
      sample_index: 1,
      state: { cook_count: 11 },
      channels: { chan2: 0.7 },
    });
  });

  it("falls forward when channel and runtime attributes are absent", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        path: "/project1/text1",
        type: "textDAT",
        family: "DAT",
        state: { errors: [] },
        parameters: {},
        warnings: ["cookTime unavailable", "channels unavailable: operator has no chans() method"],
      }),
    }));

    const result = await watchNodeImpl(fakeCtx(exec), {
      path: "/project1/text1",
      samples: 1,
      interval_ms: 16,
    });

    expect(result.isError).toBeFalsy();
    const data = dataOf(result) as {
      warnings: string[];
      snapshots: Array<{
        state: Record<string, unknown>;
        parameters: Record<string, unknown>;
        channels: Record<string, number>;
        warnings: string[];
      }>;
    };

    expect(data.snapshots).toHaveLength(1);
    expect(data.snapshots[0]?.state).toEqual({ errors: [] });
    expect(data.snapshots[0]?.parameters).toEqual({});
    expect(data.snapshots[0]?.channels).toEqual({});
    expect(data.snapshots[0]?.warnings).toEqual(expect.arrayContaining(["cookTime unavailable"]));
    expect(data.warnings).toEqual(
      expect.arrayContaining(["channels unavailable: operator has no chans() method"]),
    );
  });

  it("returns a tool error when no sample can be collected", async () => {
    const exec = vi.fn(async () => {
      throw new Error("bridge unavailable");
    });

    const result = await watchNodeImpl(fakeCtx(exec), {
      path: "/project1/noise1",
      samples: 2,
      interval_ms: 16,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("No samples collected"),
    });
  });
});

describe("registerWatchNode", () => {
  it("registers watch_node as a read-only tool", () => {
    const registerTool = vi.fn();
    const server = { registerTool };
    const ctx = fakeCtx(vi.fn());

    registerWatchNode(server as never, ctx);

    expect(registerTool).toHaveBeenCalledTimes(1);
    const [name, config] = registerTool.mock.calls[0] as [string, { annotations: unknown }];
    expect(name).toBe("watch_node");
    expect(config.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
  });
});
