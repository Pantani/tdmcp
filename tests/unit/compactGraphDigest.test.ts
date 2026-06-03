import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  _resetDigestCache,
  buildDigest,
  GraphDigestSchema,
} from "../../src/resources/graphDigest.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { compactGraphDigestImpl } from "../../src/tools/layer3/compactGraphDigest.js";
import type { ToolContext } from "../../src/tools/types.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  _resetDigestCache();
});
afterAll(() => server.close());

function makeClient(): TouchDesignerClient {
  return new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 });
}

function makeCtx(client: TouchDesignerClient): ToolContext {
  return {
    client,
    knowledge: {} as ToolContext["knowledge"],
    recipes: {} as ToolContext["recipes"],
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as ToolContext["logger"],
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const ROOT = "/project1";

interface FakeNode {
  path: string;
  type: string;
  name: string;
}
interface FakeConn {
  source_path: string;
  source_output: number;
  target_path: string;
  target_input: number;
}

function smallFixture(): { nodes: FakeNode[]; connections: FakeConn[] } {
  const nodes: FakeNode[] = [
    { path: `${ROOT}/noise1`, type: "noiseTOP", name: "noise1" },
    { path: `${ROOT}/level1`, type: "levelTOP", name: "level1" },
    { path: `${ROOT}/blur1`, type: "blurTOP", name: "blur1" },
    { path: `${ROOT}/out1`, type: "outTOP", name: "out1" },
    { path: `${ROOT}/lfo1`, type: "lfoCHOP", name: "lfo1" },
    { path: `${ROOT}/math1`, type: "mathCHOP", name: "math1" },
    { path: `${ROOT}/grid1`, type: "gridSOP", name: "grid1" },
    { path: `${ROOT}/geo1`, type: "geoCOMP", name: "geo1" },
  ];
  const connections: FakeConn[] = [
    {
      source_path: `${ROOT}/noise1`,
      source_output: 0,
      target_path: `${ROOT}/level1`,
      target_input: 0,
    },
    {
      source_path: `${ROOT}/level1`,
      source_output: 0,
      target_path: `${ROOT}/blur1`,
      target_input: 0,
    },
    {
      source_path: `${ROOT}/blur1`,
      source_output: 0,
      target_path: `${ROOT}/out1`,
      target_input: 0,
    },
    {
      source_path: `${ROOT}/lfo1`,
      source_output: 0,
      target_path: `${ROOT}/math1`,
      target_input: 0,
    },
    {
      source_path: `${ROOT}/grid1`,
      source_output: 0,
      target_path: `${ROOT}/geo1`,
      target_input: 0,
    },
    {
      source_path: `${ROOT}/math1`,
      source_output: 0,
      target_path: `${ROOT}/noise1`,
      target_input: 0,
    },
  ];
  return { nodes, connections };
}

function bigFixture(nodeCount: number, errorKeys: number) {
  const nodes: FakeNode[] = [];
  const connections: FakeConn[] = [];
  const types = ["noiseTOP", "levelTOP", "blurTOP", "compositeTOP", "rampTOP"];
  for (let i = 0; i < nodeCount; i++) {
    const type = types[i % types.length] ?? "noiseTOP";
    nodes.push({ path: `${ROOT}/n${i}`, type, name: `n${i}` });
    if (i > 0) {
      connections.push({
        source_path: `${ROOT}/n${i - 1}`,
        source_output: 0,
        target_path: `${ROOT}/n${i}`,
        target_input: 0,
      });
    }
  }
  const errors = [];
  for (let i = 0; i < errorKeys * 4; i++) {
    errors.push({ path: `${ROOT}/n${i}`, message: `error kind ${i % errorKeys}` });
  }
  return { nodes, connections, errors };
}

function mockTopology(data: { nodes: FakeNode[]; connections: FakeConn[] }, onCall?: () => void) {
  server.use(
    http.get(`${TD_BASE}/api/network/:seg/topology`, () => {
      onCall?.();
      return HttpResponse.json({ ok: true, data });
    }),
  );
}

function mockErrors(errors: Array<{ path: string; message: string }>) {
  server.use(
    http.get(`${TD_BASE}/api/network/:seg/errors`, () =>
      HttpResponse.json({ ok: true, data: { errors } }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Small fixture
// ---------------------------------------------------------------------------
describe("buildDigest — small fixture", () => {
  it("returns valid schema, correct header, families, primary output, no warnings", async () => {
    mockTopology(smallFixture());
    mockErrors([]);
    const digest = await buildDigest(makeClient(), ROOT);
    expect(GraphDigestSchema.safeParse(digest).success).toBe(true);
    expect(digest.nodeCount).toBe(8);
    expect(digest.connectionCount).toBe(6);
    expect(digest.header).toContain("8 nodes");
    expect(digest.header).toContain("6 wires");
    expect(digest.primaryOutput?.path).toBe(`${ROOT}/out1`);
    expect(digest.primaryOutput?.type).toBe("outTOP");
    // families present
    expect(digest.families.TOP?.count).toBe(4);
    expect(digest.families.CHOP?.count).toBe(2);
    expect(digest.families.SOP?.count).toBe(1);
    expect(digest.families.COMP?.count).toBe(1);
    // output chain ends at out1, walked upstream
    const chain = digest.outputChain.map((n) => n.path);
    expect(chain[chain.length - 1]).toBe(`${ROOT}/out1`);
    expect(chain).toContain(`${ROOT}/blur1`);
    expect(digest.warnings).toEqual([]);
    expect(digest.approxTokens).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// Medium fixture: primary output by no-outbound + fan-in
// ---------------------------------------------------------------------------
describe("buildDigest — medium fixture", () => {
  it("falls back to no-outbound TOP when out1 missing; errors grouped", async () => {
    const nodes: FakeNode[] = [
      { path: `${ROOT}/a`, type: "noiseTOP", name: "a" },
      { path: `${ROOT}/b`, type: "blurTOP", name: "b" },
      { path: `${ROOT}/c`, type: "compositeTOP", name: "c" }, // sink — no outbound
      { path: `${ROOT}/lfo`, type: "lfoCHOP", name: "lfo" },
    ];
    const connections: FakeConn[] = [
      { source_path: `${ROOT}/a`, source_output: 0, target_path: `${ROOT}/b`, target_input: 0 },
      { source_path: `${ROOT}/b`, source_output: 0, target_path: `${ROOT}/c`, target_input: 0 },
      { source_path: `${ROOT}/a`, source_output: 0, target_path: `${ROOT}/c`, target_input: 1 },
    ];
    mockTopology({ nodes, connections });
    mockErrors([
      { path: `${ROOT}/a`, message: "missing input" },
      { path: `${ROOT}/b`, message: "missing input" },
      { path: `${ROOT}/c`, message: "shader compile failed" },
    ]);
    const digest = await buildDigest(makeClient(), ROOT, {
      maxTokens: 500,
      includeErrors: true,
      includeOutputChain: true,
      outputChainDepth: 6,
      familyTopTypes: 3,
    });
    expect(digest.primaryOutput?.path).toBe(`${ROOT}/c`);
    expect(digest.errors.total).toBe(3);
    expect(digest.errors.topGroups.length).toBe(2);
    expect(digest.errors.topGroups[0]?.key).toBe("missing input");
    expect(digest.errors.topGroups[0]?.count).toBe(2);
    expect(digest.outputChain.length).toBeLessThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// Big fixture — truncation
// ---------------------------------------------------------------------------
describe("buildDigest — big fixture (truncation)", () => {
  it("respects max_tokens ceiling and records warnings", async () => {
    const fx = bigFixture(400, 25);
    mockTopology({ nodes: fx.nodes, connections: fx.connections });
    mockErrors(fx.errors);
    const digest = await buildDigest(makeClient(), ROOT, {
      maxTokens: 500,
      includeErrors: true,
      includeOutputChain: true,
      outputChainDepth: 6,
      familyTopTypes: 3,
    });
    expect(digest.approxTokens).toBeLessThanOrEqual(500);
    expect(Object.keys(digest.families).length).toBeGreaterThan(0);
    // No throw, schema valid even on big inputs
    expect(GraphDigestSchema.safeParse(digest).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Offline
// ---------------------------------------------------------------------------
describe("buildDigest — offline", () => {
  it("returns friendly empty payload with offline warning, no throw", async () => {
    server.use(
      http.get(`${TD_BASE}/api/network/:seg/topology`, () => HttpResponse.error()),
      http.get(`${TD_BASE}/api/network/:seg/errors`, () => HttpResponse.error()),
    );
    const digest = await buildDigest(makeClient(), ROOT);
    expect(digest.nodeCount).toBe(0);
    expect(digest.primaryOutput).toBeNull();
    expect(digest.warnings.some((w) => w.includes("not reachable"))).toBe(true);
    expect(GraphDigestSchema.safeParse(digest).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// max_tokens floor
// ---------------------------------------------------------------------------
describe("buildDigest — max_tokens=100 floor", () => {
  it("returns a digest and records truncation warnings", async () => {
    const fx = bigFixture(200, 10);
    mockTopology({ nodes: fx.nodes, connections: fx.connections });
    mockErrors(fx.errors);
    const digest = await buildDigest(makeClient(), ROOT, {
      maxTokens: 100,
      includeErrors: true,
      includeOutputChain: true,
      outputChainDepth: 6,
      familyTopTypes: 3,
    });
    expect(digest.warnings.length).toBeGreaterThan(0);
    expect(GraphDigestSchema.safeParse(digest).success).toBe(true);
  });

  it("flags overBudget=true with a friendly warning when budget cannot be met", async () => {
    const fx = bigFixture(200, 10);
    mockTopology({ nodes: fx.nodes, connections: fx.connections });
    mockErrors(fx.errors);
    const digest = await buildDigest(makeClient(), ROOT, {
      maxTokens: 1,
      includeErrors: true,
      includeOutputChain: true,
      outputChainDepth: 6,
      familyTopTypes: 3,
    });
    expect(digest.overBudget).toBe(true);
    expect(digest.warnings.some((w) => w.includes("Could not fit within maxTokens"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
describe("buildDigest — cache", () => {
  it("two identical calls trigger one topology fetch", async () => {
    let topoCalls = 0;
    mockTopology(smallFixture(), () => topoCalls++);
    mockErrors([]);
    const client = makeClient();
    await buildDigest(client, "/project_cache_a");
    const firstCount = topoCalls;
    await buildDigest(client, "/project_cache_a");
    expect(topoCalls).toBe(firstCount);
  });
});

// ---------------------------------------------------------------------------
// Tool wrapper
// ---------------------------------------------------------------------------
describe("compactGraphDigestImpl", () => {
  it("returns structuredResult with the digest as structuredContent", async () => {
    mockTopology(smallFixture());
    mockErrors([]);
    const ctx = makeCtx(makeClient());
    const res = await compactGraphDigestImpl(ctx, {
      path: "/project_tool_a",
      max_tokens: 500,
      include_errors: true,
      include_output_chain: true,
      output_chain_depth: 6,
      family_top_types: 3,
    });
    expect(res.isError).not.toBe(true);
    expect(res.structuredContent).toBeDefined();
    const parsed = GraphDigestSchema.safeParse(res.structuredContent);
    expect(parsed.success).toBe(true);
  });

  it("never throws — surfaces offline as a structured digest, not an error", async () => {
    server.use(
      http.get(`${TD_BASE}/api/network/:seg/topology`, () => HttpResponse.error()),
      http.get(`${TD_BASE}/api/network/:seg/errors`, () => HttpResponse.error()),
    );
    const ctx = makeCtx(makeClient());
    const res = await compactGraphDigestImpl(ctx, {
      path: "/project_tool_off",
      max_tokens: 500,
      include_errors: true,
      include_output_chain: true,
      output_chain_depth: 6,
      family_top_types: 3,
    });
    // Offline still returns a friendly digest payload (not isError)
    expect(res.isError).not.toBe(true);
    expect(res.structuredContent).toBeDefined();
  });
});
