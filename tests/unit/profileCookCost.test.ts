import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { profileCookCostImpl } from "../../src/tools/layer3/profileCookCost.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface NodeEntry {
  path: string;
  cook_time_ms: number;
  cook_count?: number;
}

interface PerfResponse {
  nodes: NodeEntry[];
}

function fakeCtx(snapshots: PerfResponse[]): ToolContext {
  let call = 0;
  const getNetworkPerformance = vi.fn(async () => {
    const snap = snapshots[call % snapshots.length];
    call++;
    return snap ?? { nodes: [] };
  });
  return {
    client: { getNetworkPerformance },
    logger: silentLogger,
  } as unknown as ToolContext;
}

function fakeCtxRejectOn(snapshots: PerfResponse[], rejectAt: number): ToolContext {
  let call = 0;
  const getNetworkPerformance = vi.fn(async () => {
    const idx = call++;
    if (idx >= rejectAt) throw new Error("bridge unavailable");
    return snapshots[idx] ?? { nodes: [] };
  });
  return {
    client: { getNetworkPerformance },
    logger: silentLogger,
  } as unknown as ToolContext;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function dataOf(result: CallToolResult) {
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (structured !== undefined) return structured as ReturnType<typeof JSON.parse>;
  const text = textOf(result);
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("profileCookCostImpl", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rolling-window aggregation: mean, p95, max, ranking", async () => {
    // A: [10, 10, 10, 10, 100] → mean=28, p95=100, max=100
    // B: [5, 5, 5, 5, 5] → mean=5, p95=5
    const snapshots: PerfResponse[] = [
      {
        nodes: [
          { path: "/p/A", cook_time_ms: 10 },
          { path: "/p/B", cook_time_ms: 5 },
        ],
      },
      {
        nodes: [
          { path: "/p/A", cook_time_ms: 10 },
          { path: "/p/B", cook_time_ms: 5 },
        ],
      },
      {
        nodes: [
          { path: "/p/A", cook_time_ms: 10 },
          { path: "/p/B", cook_time_ms: 5 },
        ],
      },
      {
        nodes: [
          { path: "/p/A", cook_time_ms: 10 },
          { path: "/p/B", cook_time_ms: 5 },
        ],
      },
      {
        nodes: [
          { path: "/p/A", cook_time_ms: 100 },
          { path: "/p/B", cook_time_ms: 5 },
        ],
      },
    ];

    const ctx = fakeCtx(snapshots);
    const promise = profileCookCostImpl(ctx, {
      scopePath: "/p",
      samples: 5,
      intervalMs: 100,
      topN: 15,
      targetFps: 60,
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.isError).toBeFalsy();
    const data = dataOf(result);
    const A = data.hotspots.find((h: { path: string }) => h.path === "/p/A");
    const B = data.hotspots.find((h: { path: string }) => h.path === "/p/B");

    expect(A).toBeDefined();
    expect(A.meanCookMs).toBeCloseTo(28, 5);
    expect(A.p95CookMs).toBe(100);
    expect(A.maxCookMs).toBe(100);

    expect(B).toBeDefined();
    expect(B.meanCookMs).toBe(5);
    expect(B.p95CookMs).toBe(5);

    // A ranks above B (higher p95)
    expect(data.hotspots[0].path).toBe("/p/A");
  });

  it("ranking determinism: identical p95 + mean breaks ties by path ascending", async () => {
    const snapshots: PerfResponse[] = [
      {
        nodes: [
          { path: "/p/Z", cook_time_ms: 10 },
          { path: "/p/A", cook_time_ms: 10 },
        ],
      },
      {
        nodes: [
          { path: "/p/Z", cook_time_ms: 10 },
          { path: "/p/A", cook_time_ms: 10 },
        ],
      },
    ];

    const run = async () => {
      const ctx = fakeCtx(snapshots);
      const promise = profileCookCostImpl(ctx, {
        scopePath: "/p",
        samples: 2,
        intervalMs: 100,
        topN: 15,
        targetFps: 60,
      });
      await vi.runAllTimersAsync();
      return promise;
    };

    const r1 = dataOf(await run());
    const r2 = dataOf(await run());

    expect(r1.hotspots.map((h: { path: string }) => h.path)).toEqual(
      r2.hotspots.map((h: { path: string }) => h.path),
    );
    // /p/A < /p/Z alphabetically
    expect(r1.hotspots[0].path).toBe("/p/A");
    expect(r1.hotspots[1].path).toBe("/p/Z");
  });

  it("topN slicing: 20 nodes, topN=5 returns exactly 5 with monotone p95", async () => {
    const nodes: NodeEntry[] = Array.from({ length: 20 }, (_, i) => ({
      path: `/p/node${String(i).padStart(2, "0")}`,
      cook_time_ms: (20 - i) * 2, // descending cook times
    }));

    const snapshots: PerfResponse[] = [{ nodes }, { nodes }];
    const ctx = fakeCtx(snapshots);
    const promise = profileCookCostImpl(ctx, {
      scopePath: "/p",
      samples: 2,
      intervalMs: 100,
      topN: 5,
      targetFps: 60,
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    const data = dataOf(result);

    expect(data.hotspots).toHaveLength(5);
    for (let i = 1; i < data.hotspots.length; i++) {
      expect(data.hotspots[i - 1].p95CookMs).toBeGreaterThanOrEqual(data.hotspots[i].p95CookMs);
    }
  });

  it("late-arrival node appears with correct sampleCount", async () => {
    const snapshots: PerfResponse[] = [
      { nodes: [{ path: "/p/A", cook_time_ms: 5 }] },
      { nodes: [{ path: "/p/A", cook_time_ms: 5 }] },
      { nodes: [{ path: "/p/A", cook_time_ms: 5 }] },
      {
        nodes: [
          { path: "/p/A", cook_time_ms: 5 },
          { path: "/p/C", cook_time_ms: 20 },
        ],
      },
      {
        nodes: [
          { path: "/p/A", cook_time_ms: 5 },
          { path: "/p/C", cook_time_ms: 20 },
        ],
      },
    ];

    const ctx = fakeCtx(snapshots);
    const promise = profileCookCostImpl(ctx, {
      scopePath: "/p",
      samples: 5,
      intervalMs: 100,
      topN: 15,
      targetFps: 60,
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    const data = dataOf(result);
    const C = data.hotspots.find((h: { path: string }) => h.path === "/p/C");

    expect(C).toBeDefined();
    expect(C.sampleCount).toBe(2);
    expect(C.meanCookMs).toBe(20);
  });

  it("bridge error mid-run: fail-forward with warning, partial samples, no throw", async () => {
    const snapshots: PerfResponse[] = [
      { nodes: [{ path: "/p/A", cook_time_ms: 10 }] },
      { nodes: [{ path: "/p/A", cook_time_ms: 10 }] },
    ];

    const ctx = fakeCtxRejectOn(snapshots, 2); // rejects on call index >= 2
    const promise = profileCookCostImpl(ctx, {
      scopePath: "/p",
      samples: 5,
      intervalMs: 100,
      topN: 15,
      targetFps: 60,
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.isError).toBeFalsy();
    const data = dataOf(result);
    expect(data.samples).toBe(2);
    expect(data.warnings.length).toBeGreaterThan(0);
    expect(data.warnings[0]).toMatch(/2\/5/);
    expect(data.hotspots.length).toBeGreaterThan(0);
  });

  it("overBudget flag: p95>16.67ms → true, p95<16.67ms → false", async () => {
    const snapshots: PerfResponse[] = [
      {
        nodes: [
          { path: "/p/slow", cook_time_ms: 20 },
          { path: "/p/fast", cook_time_ms: 10 },
        ],
      },
      {
        nodes: [
          { path: "/p/slow", cook_time_ms: 20 },
          { path: "/p/fast", cook_time_ms: 10 },
        ],
      },
    ];

    const ctx = fakeCtx(snapshots);
    const promise = profileCookCostImpl(ctx, {
      scopePath: "/p",
      samples: 2,
      intervalMs: 100,
      topN: 15,
      targetFps: 60,
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    const data = dataOf(result);

    const slow = data.hotspots.find((h: { path: string }) => h.path === "/p/slow");
    const fast = data.hotspots.find((h: { path: string }) => h.path === "/p/fast");

    expect(slow.overBudget).toBe(true);
    expect(fast.overBudget).toBe(false);
  });

  it("schema defaults applied: calling with empty object uses all defaults", async () => {
    const snapshots: PerfResponse[] = Array.from({ length: 30 }, () => ({ nodes: [] }));
    const ctx = fakeCtx(snapshots);
    const promise = profileCookCostImpl(ctx, {
      scopePath: "/project1",
      samples: 30,
      intervalMs: 100,
      topN: 15,
      targetFps: 60,
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    const data = dataOf(result);

    expect(data.path).toBe("/project1");
    expect(data.samples).toBe(30);
    expect(data.intervalMs).toBe(100);
    expect(data.targetFps).toBe(60);
    expect(data.frameBudgetMs).toBeCloseTo(1000 / 60, 5);
  });
});
