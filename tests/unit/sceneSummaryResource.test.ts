import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchSceneCurrent,
  fetchSceneErrors,
  fetchSceneOperators,
  groupErrors,
  SceneCurrentSchema,
  SceneErrorsSchema,
  SceneOperatorsSchema,
} from "../../src/resources/sceneSummary.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// Clear module-level cache between tests by resetting timers and re-fetching
// (vitest fake timers let us advance time to expire TTL)
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function makeClient(): TouchDesignerClient {
  return new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 });
}

const ROOT = "/project1";

// ---------------------------------------------------------------------------
// groupErrors helper
// ---------------------------------------------------------------------------
describe("groupErrors", () => {
  it("clusters identical messages and sorts by count", () => {
    const errors = [
      { path: "/a", message: "cook error" },
      { path: "/b", message: "cook error" },
      { path: "/c", message: "other error" },
    ];
    const groups = groupErrors(errors);
    expect(groups[0]?.key).toBe("cook error");
    expect(groups[0]?.count).toBe(2);
    expect(groups[0]?.sample.path).toBe("/a");
    expect(groups[1]?.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Happy path: current view
// ---------------------------------------------------------------------------
describe("fetchSceneCurrent — happy path", () => {
  beforeEach(() => {
    vi.useRealTimers();
    // override topology to have two different families
    server.use(
      http.get(`${TD_BASE}/api/info`, () =>
        HttpResponse.json({
          ok: true,
          data: { td_version: "2023.12000", project: "myshow.toe" },
        }),
      ),
      http.get(`${TD_BASE}/api/network/:seg/topology`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            nodes: [
              { path: `${ROOT}/noise1`, type: "noiseTOP", name: "noise1" },
              { path: `${ROOT}/lfo1`, type: "lfoCHOP", name: "lfo1" },
              { path: `${ROOT}/geo1`, type: "geoCOMP", name: "geo1" },
            ],
            connections: [
              {
                source_path: `${ROOT}/noise1`,
                source_output: 0,
                target_path: `${ROOT}/lfo1`,
                target_input: 0,
              },
            ],
          },
        }),
      ),
      http.get(`${TD_BASE}/api/network/:seg/errors`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            errors: [
              { path: `${ROOT}/noise1`, message: "cook error" },
              { path: `${ROOT}/lfo1`, message: "cook error" },
              { path: `${ROOT}/geo1`, message: "missing input" },
              { path: `${ROOT}/extra`, message: "another error" },
            ],
          },
        }),
      ),
      http.get(`${TD_BASE}/api/network/:seg/performance`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            nodes: [{ path: `${ROOT}/noise1`, cook_time_ms: 0.2 }],
            total_cook_time_ms: 0.2,
          },
        }),
      ),
    );
  });

  it("returns a schema-valid payload with correct topology counts", async () => {
    const data = await fetchSceneCurrent(makeClient(), ROOT);
    const parsed = SceneCurrentSchema.safeParse(data);
    expect(parsed.success).toBe(true);
    expect(data.bridge.reachable).toBe(true);
    expect(data.bridge.tdVersion).toBe("2023.12000");
    expect(data.topology.nodeCount).toBe(3);
    expect(data.topology.connectionCount).toBe(1);
    expect(data.topology.families.TOP).toBe(1);
    expect(data.topology.families.CHOP).toBe(1);
  });

  it("caps topGroups at 3 and puts highest-count first", async () => {
    const data = await fetchSceneCurrent(makeClient(), ROOT);
    expect(data.errors.topGroups.length).toBeLessThanOrEqual(3);
    expect(data.errors.topGroups[0]?.key).toBe("cook error");
    expect(data.errors.topGroups[0]?.count).toBe(2);
  });

  it("cachedAt is a valid ISO-8601 string", async () => {
    const data = await fetchSceneCurrent(makeClient(), ROOT);
    expect(() => new Date(data.cachedAt).toISOString()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Operators view
// ---------------------------------------------------------------------------
describe("fetchSceneOperators — grouping by family", () => {
  beforeEach(() => {
    vi.useRealTimers();
    server.use(
      http.get(`${TD_BASE}/api/network/:seg/topology`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            nodes: [
              { path: `${ROOT}/noise1`, type: "noiseTOP", name: "noise1" },
              { path: `${ROOT}/null1`, type: "nullTOP", name: "null1" },
              { path: `${ROOT}/lfo1`, type: "lfoCHOP", name: "lfo1" },
            ],
            connections: [],
          },
        }),
      ),
    );
  });

  it("groups nodes by family and totals count correctly", async () => {
    const data = await fetchSceneOperators(makeClient(), ROOT);
    const parsed = SceneOperatorsSchema.safeParse(data);
    expect(parsed.success).toBe(true);
    expect(data.count).toBe(3);
    expect(data.families.TOP?.length).toBe(2);
    expect(data.families.CHOP?.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Errors view
// ---------------------------------------------------------------------------
describe("fetchSceneErrors — clustering", () => {
  beforeEach(() => {
    vi.useRealTimers();
    server.use(
      http.get(`${TD_BASE}/api/network/:seg/errors`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            errors: [
              { path: `${ROOT}/a`, message: "cook error" },
              { path: `${ROOT}/b`, message: "cook error" },
              { path: `${ROOT}/c`, message: "unique error" },
            ],
          },
        }),
      ),
    );
  });

  it("clusters identical messages with correct count and sample", async () => {
    const data = await fetchSceneErrors(makeClient(), ROOT);
    const parsed = SceneErrorsSchema.safeParse(data);
    expect(parsed.success).toBe(true);
    expect(data.groups[0]?.count).toBe(2);
    expect(data.groups[0]?.sample.path).toBe(`${ROOT}/a`);
    expect(data.total).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 5s cache
// ---------------------------------------------------------------------------
describe("5s cache", () => {
  let callCount = 0;

  beforeEach(() => {
    callCount = 0;
    server.use(
      http.get(`${TD_BASE}/api/network/:seg/topology`, () => {
        callCount++;
        return HttpResponse.json({
          ok: true,
          data: { nodes: [], connections: [] },
        });
      }),
    );
  });

  it("second read within TTL does not re-fetch topology", async () => {
    const client = makeClient();
    // use unique root so we avoid hitting cached entries from other tests
    const uniqueRoot = `/project_cache_${Date.now()}`;
    await fetchSceneCurrent(client, uniqueRoot);
    const firstCount = callCount;
    await fetchSceneCurrent(client, uniqueRoot);
    expect(callCount).toBe(firstCount); // no new calls
  });

  it("read after TTL expiry re-fetches", async () => {
    const client = makeClient();
    const uniqueRoot = `/project_cache_expire_${Date.now()}`;
    await fetchSceneCurrent(client, uniqueRoot);
    const firstCount = callCount;
    // advance time past TTL
    vi.advanceTimersByTime(6000);
    await fetchSceneCurrent(client, uniqueRoot);
    expect(callCount).toBeGreaterThan(firstCount);
  });
});

// ---------------------------------------------------------------------------
// Offline fallback
// ---------------------------------------------------------------------------
describe("offline fallback", () => {
  beforeEach(() => {
    vi.useRealTimers();
    server.use(
      http.get(`${TD_BASE}/api/info`, () => HttpResponse.error()),
      http.get(`${TD_BASE}/api/network/:seg/topology`, () => HttpResponse.error()),
      http.get(`${TD_BASE}/api/network/:seg/errors`, () => HttpResponse.error()),
      http.get(`${TD_BASE}/api/network/:seg/performance`, () => HttpResponse.error()),
    );
  });

  it("current view — returns valid schema-conforming payload when offline", async () => {
    const data = await fetchSceneCurrent(makeClient(), "/project_offline");
    const parsed = SceneCurrentSchema.safeParse(data);
    expect(parsed.success).toBe(true);
    expect(data.bridge.reachable).toBe(false);
    expect(data.warnings.some((w) => w.includes("not reachable"))).toBe(true);
    expect(data.cachedAt).toBeTruthy();
  });

  it("operators view — offline returns empty families", async () => {
    const data = await fetchSceneOperators(makeClient(), "/project_offline_ops");
    const parsed = SceneOperatorsSchema.safeParse(data);
    expect(parsed.success).toBe(true);
    expect(data.count).toBe(0);
    expect(Object.keys(data.families).length).toBe(0);
  });

  it("errors view — offline returns empty groups", async () => {
    const data = await fetchSceneErrors(makeClient(), "/project_offline_errs");
    const parsed = SceneErrorsSchema.safeParse(data);
    expect(parsed.success).toBe(true);
    expect(data.total).toBe(0);
    expect(data.groups.length).toBe(0);
  });

  it("short 1s TTL for offline — second read hits cache immediately, third after 1.1s re-fetches", async () => {
    // This test relies on real time (offline describe already calls vi.useRealTimers).
    // We verify via unique root that a second immediate read is cached (same call count),
    // then wait 1.1s and confirm the expired entry triggers a new fetch.
    let infoCallCount = 0;
    server.use(
      http.get(`${TD_BASE}/api/info`, () => {
        infoCallCount++;
        return HttpResponse.error();
      }),
    );
    const uniqueRoot = `/project_offline_ttl_${Date.now()}`;
    await fetchSceneCurrent(makeClient(), uniqueRoot);
    const afterFirst = infoCallCount;
    // immediate second read — should be cached
    await fetchSceneCurrent(makeClient(), uniqueRoot);
    expect(infoCallCount).toBe(afterFirst);
    // wait past the 1s offline TTL
    await new Promise((r) => setTimeout(r, 1100));
    await fetchSceneCurrent(makeClient(), uniqueRoot);
    expect(infoCallCount).toBeGreaterThan(afterFirst);
  }, 10000);
});

// ---------------------------------------------------------------------------
// Partial failure
// ---------------------------------------------------------------------------
describe("partial failure — perf fetch fails", () => {
  beforeEach(() => {
    vi.useRealTimers();
    server.use(
      http.get(`${TD_BASE}/api/info`, () =>
        HttpResponse.json({
          ok: true,
          data: { td_version: "2023.12000" },
        }),
      ),
      http.get(`${TD_BASE}/api/network/:seg/topology`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            nodes: [{ path: `${ROOT}/noise1`, type: "noiseTOP", name: "noise1" }],
            connections: [],
          },
        }),
      ),
      http.get(`${TD_BASE}/api/network/:seg/errors`, () =>
        HttpResponse.json({ ok: true, data: { errors: [] } }),
      ),
      http.get(`${TD_BASE}/api/network/:seg/performance`, () => HttpResponse.error()),
    );
  });

  it("returns valid payload with zeroed perf and a warning", async () => {
    const uniqueRoot = `/project_partial_${Date.now()}`;
    const data = await fetchSceneCurrent(makeClient(), uniqueRoot);
    const parsed = SceneCurrentSchema.safeParse(data);
    expect(parsed.success).toBe(true);
    expect(data.bridge.reachable).toBe(true);
    expect(data.topology.nodeCount).toBe(1);
    expect(data.performance.overBudgetNodes).toBe(0);
    expect(data.performance.totalCookMs).toBe(0);
    expect(data.warnings.some((w) => w.toLowerCase().includes("performance"))).toBe(true);
  });
});
