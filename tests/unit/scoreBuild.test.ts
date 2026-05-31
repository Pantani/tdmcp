import { deflateSync } from "node:zlib";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { scoreBuildImpl, scoreBuildSchema } from "../../src/tools/layer3/scoreBuild.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeCtx(extra: Partial<ToolContext> = {}): ToolContext {
  return {
    client: new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 }),
    logger: silentLogger,
    ...extra,
  } as unknown as ToolContext;
}

const ok = (data: unknown) => HttpResponse.json({ ok: true, data });

// --- Tiny PNG encoder (RGB-8, no filter, no interlace) for fixtures ---
function crc32(buf: Buffer): number {
  let c: number;
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = (table[(crc ^ b) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function encodePngRgb(
  width: number,
  height: number,
  fill: (x: number, y: number) => [number, number, number],
): string {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bitDepth
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fill(x, y);
      raw[p++] = r;
      raw[p++] = g;
      raw[p++] = b;
    }
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

const PNG_BLACK = encodePngRgb(8, 8, () => [0, 0, 0]);
const PNG_VIVID = encodePngRgb(8, 8, (x, y) => {
  // 4 distinct vivid quadrants
  if (x < 4 && y < 4) return [255, 30, 30];
  if (x >= 4 && y < 4) return [30, 255, 60];
  if (x < 4 && y >= 4) return [40, 50, 255];
  return [255, 230, 30];
});
const PNG_VIVID_SHIFTED = encodePngRgb(8, 8, (x, y) => {
  if (x < 4 && y < 4) return [30, 255, 60];
  if (x >= 4 && y < 4) return [40, 50, 255];
  if (x < 4 && y >= 4) return [255, 230, 30];
  return [255, 30, 30];
});

// --- helpers to install fixtures ---
function useErrors(errors: { path: string; message: string }[]) {
  server.use(http.get(`${TD_BASE}/api/network/:seg/errors`, () => ok({ errors })));
}
function usePerf(nodes: { path: string; cook_time_ms: number }[], total?: number) {
  server.use(
    http.get(`${TD_BASE}/api/network/:seg/performance`, () =>
      ok({ nodes, total_cook_time_ms: total ?? nodes.reduce((s, n) => s + n.cook_time_ms, 0) }),
    ),
  );
}
function useTopology(nodes: { path: string; type: string; name: string }[]) {
  server.use(
    http.get(`${TD_BASE}/api/network/:seg/topology`, () => ok({ nodes, connections: [] })),
  );
}
function usePreview(framesB64: string[]) {
  let i = 0;
  server.use(
    http.get(`${TD_BASE}/api/preview/:seg`, ({ params }) => {
      const raw = params.seg;
      const path = decodeURIComponent(Array.isArray(raw) ? (raw[0] ?? "") : String(raw));
      const b64 = framesB64[Math.min(i, framesB64.length - 1)] ?? framesB64[0] ?? "";
      i++;
      return ok({ path, width: 8, height: 8, format: "png", base64: b64 });
    }),
  );
}
function useInfo(play = true) {
  server.use(
    http.get(`${TD_BASE}/api/info`, () =>
      ok({ td_version: "2023", bridge_version: "0.3.0", time: { play } }),
    ),
  );
}

function fullArgs(over: Partial<Parameters<typeof scoreBuildImpl>[1]> = {}) {
  return {
    scopePath: "/project1",
    criteria: ["palette", "motion", "complexity", "errors", "perf"] as const,
    targetFps: 60,
    llmCritique: false,
    ...over,
  } as Parameters<typeof scoreBuildImpl>[1];
}

describe("scoreBuildImpl", () => {
  it("clean build → final = 100 across all criteria", async () => {
    useErrors([]);
    usePerf([{ path: "/project1/noise1", cook_time_ms: 0.5 }]);
    useTopology(
      Array.from({ length: 20 }, (_, i) => ({
        path: `/project1/n${i}`,
        type: "noiseTOP",
        name: `n${i}`,
      })).concat([{ path: "/project1/out1", type: "outTOP", name: "out1" }]),
    );
    usePreview([PNG_VIVID, PNG_VIVID_SHIFTED]);
    useInfo(true);

    const result = await scoreBuildImpl(makeCtx(), fullArgs());
    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as {
      final: number;
      perCriterion: Record<string, number>;
      warnings: string[];
    };
    expect(out.perCriterion.errors).toBe(100);
    expect(out.perCriterion.complexity).toBe(100);
    expect(out.perCriterion.perf).toBe(100);
    expect(out.perCriterion.palette).toBeGreaterThanOrEqual(80);
    expect(out.perCriterion.motion).toBeGreaterThan(0);
    expect(out.final).toBeGreaterThanOrEqual(85);
  });

  it("one error → errors sub-score = 60", async () => {
    useErrors([{ path: "/project1/x", message: "boom" }]);
    usePerf([{ path: "/project1/x", cook_time_ms: 0.1 }]);
    useTopology([{ path: "/project1/x", type: "noiseTOP", name: "x" }]);
    const result = await scoreBuildImpl(makeCtx(), fullArgs({ criteria: ["errors"] }));
    const out = result.structuredContent as {
      perCriterion: Record<string, number>;
      final: number;
      suggestions: string[];
    };
    expect(out.perCriterion.errors).toBe(60);
    expect(out.final).toBe(60);
    expect(out.suggestions.join(" ")).toMatch(/error cluster/);
  });

  it("over-budget perf → perf sub-score = 0 and suggestion mentions optimize_performance", async () => {
    const budget = 1000 / 60;
    usePerf([{ path: "/project1/big", cook_time_ms: budget * 2 }], budget * 2);
    const result = await scoreBuildImpl(makeCtx(), fullArgs({ criteria: ["perf"] }));
    const out = result.structuredContent as {
      perCriterion: Record<string, number>;
      suggestions: string[];
    };
    expect(out.perCriterion.perf).toBe(0);
    expect(out.suggestions.join(" ")).toMatch(/optimize_performance/);
  });

  it("complexity sweet-spot: n=20 → 100, n=2 → 55, n=200 → ~28", async () => {
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        path: `/project1/n${i}`,
        type: "noiseTOP",
        name: `n${i}`,
      }));
    useTopology(mk(20));
    let r = await scoreBuildImpl(makeCtx(), fullArgs({ criteria: ["complexity"] }));
    expect(
      (r.structuredContent as { perCriterion: { complexity: number } }).perCriterion.complexity,
    ).toBe(100);

    useTopology(mk(2));
    r = await scoreBuildImpl(makeCtx(), fullArgs({ criteria: ["complexity"] }));
    expect(
      (r.structuredContent as { perCriterion: { complexity: number } }).perCriterion.complexity,
    ).toBe(55);

    useTopology(mk(200));
    r = await scoreBuildImpl(makeCtx(), fullArgs({ criteria: ["complexity"] }));
    const c200 = (r.structuredContent as { perCriterion: { complexity: number } }).perCriterion
      .complexity;
    expect(c200).toBeGreaterThanOrEqual(0);
    expect(c200).toBeLessThanOrEqual(60);
  });

  it("static preview → motion = 0", async () => {
    useTopology([{ path: "/project1/out1", type: "outTOP", name: "out1" }]);
    usePreview([PNG_VIVID, PNG_VIVID]);
    useInfo(true);
    const result = await scoreBuildImpl(makeCtx(), fullArgs({ criteria: ["motion"] }));
    const out = result.structuredContent as {
      perCriterion: Record<string, number>;
      suggestions: string[];
    };
    expect(out.perCriterion.motion).toBe(0);
    expect(out.suggestions.join(" ")).toMatch(/bind_to_channel|feedback/);
  });

  it("monochrome PNG → palette near 0, vivid PNG → palette high", async () => {
    useTopology([{ path: "/project1/out1", type: "outTOP", name: "out1" }]);
    usePreview([PNG_BLACK, PNG_BLACK]);
    useInfo(true);
    let r = await scoreBuildImpl(makeCtx(), fullArgs({ criteria: ["palette"] }));
    expect(
      (r.structuredContent as { perCriterion: { palette: number } }).perCriterion.palette,
    ).toBeLessThanOrEqual(5);

    usePreview([PNG_VIVID, PNG_VIVID]);
    r = await scoreBuildImpl(makeCtx(), fullArgs({ criteria: ["palette"] }));
    expect(
      (r.structuredContent as { perCriterion: { palette: number } }).perCriterion.palette,
    ).toBeGreaterThanOrEqual(80);
  });

  it("criteria=['errors'] → only errors evaluated, no perf/topology calls", async () => {
    useErrors([]);
    let perfCalled = false;
    let topoCalled = false;
    server.use(
      http.get(`${TD_BASE}/api/network/:seg/performance`, () => {
        perfCalled = true;
        return ok({ nodes: [] });
      }),
      http.get(`${TD_BASE}/api/network/:seg/topology`, () => {
        topoCalled = true;
        return ok({ nodes: [], connections: [] });
      }),
    );
    const result = await scoreBuildImpl(makeCtx(), fullArgs({ criteria: ["errors"] }));
    const out = result.structuredContent as {
      perCriterion: Record<string, number>;
      final: number;
    };
    expect(perfCalled).toBe(false);
    expect(topoCalled).toBe(false);
    expect(out.perCriterion.errors).toBe(100);
    expect(out.final).toBe(100);
  });

  it("TOP not resolvable → palette+motion omitted, warning, final = mean of rest", async () => {
    useErrors([]);
    usePerf([{ path: "/project1/x", cook_time_ms: 0.1 }]);
    useTopology([]); // no TOPs at all
    const result = await scoreBuildImpl(makeCtx(), fullArgs());
    const out = result.structuredContent as {
      perCriterion: Record<string, number | undefined>;
      warnings: string[];
      final: number;
    };
    expect(out.perCriterion.palette).toBeUndefined();
    expect(out.perCriterion.motion).toBeUndefined();
    expect(out.warnings.join(" ")).toMatch(/preview TOP/);
    expect(out.final).toBeGreaterThan(0);
  });

  it("llmCritique=true with mock LLM populates critique, no warning", async () => {
    useErrors([]);
    usePerf([{ path: "/project1/x", cook_time_ms: 0.1 }]);
    useTopology([{ path: "/project1/x", type: "noiseTOP", name: "x" }]);
    const llm = {
      chatStream: async () => ({ role: "assistant" as const, content: "" }),
      complete: async () => ({ text: "Add a color grade." }),
    };
    const result = await scoreBuildImpl(
      makeCtx({ llm }),
      fullArgs({ criteria: ["errors"], llmCritique: true }),
    );
    const out = result.structuredContent as { critique?: string; warnings: string[] };
    expect(out.critique).toBe("Add a color grade.");
    expect(out.warnings.find((w) => w.includes("LLM critique"))).toBeUndefined();
  });

  it("llmCritique=true with throwing LLM → critique undefined, warning recorded", async () => {
    useErrors([]);
    useTopology([{ path: "/project1/x", type: "noiseTOP", name: "x" }]);
    const llm = {
      chatStream: async () => ({ role: "assistant" as const, content: "" }),
      complete: async () => {
        throw new Error("boom");
      },
    };
    const result = await scoreBuildImpl(
      makeCtx({ llm }),
      fullArgs({ criteria: ["errors"], llmCritique: true }),
    );
    const out = result.structuredContent as { critique?: string; warnings: string[] };
    expect(out.critique).toBeUndefined();
    expect(out.warnings.some((w) => w.startsWith("LLM critique unavailable"))).toBe(true);
  });

  it("llmCritique=true with no ctx.llm → silent no-op", async () => {
    useErrors([]);
    const result = await scoreBuildImpl(
      makeCtx(),
      fullArgs({ criteria: ["errors"], llmCritique: true }),
    );
    const out = result.structuredContent as { critique?: string; warnings: string[] };
    expect(out.critique).toBeUndefined();
    expect(out.warnings.find((w) => w.includes("LLM critique"))).toBeUndefined();
  });

  it("TD offline → errorResult, never throws", async () => {
    server.use(http.get(`${TD_BASE}/api/network/:seg/errors`, () => HttpResponse.error()));
    const result = await scoreBuildImpl(makeCtx(), fullArgs({ criteria: ["errors"] }));
    expect(result.isError).toBe(true);
  });

  it("schema defaults are sane", () => {
    const parsed = scoreBuildSchema.parse({});
    expect(parsed.scopePath).toBe("/project1");
    expect(parsed.targetFps).toBe(60);
    expect(parsed.llmCritique).toBe(false);
    expect(parsed.criteria).toHaveLength(5);
  });
});
