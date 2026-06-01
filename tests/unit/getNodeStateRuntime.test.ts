import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  buildNodeStateRuntimeScript,
  getNodeStateRuntimeImpl,
  getNodeStateRuntimeSchema,
} from "../../src/tools/layer3/getNodeStateRuntime.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

// ---------------------------------------------------------------------------
// MSW server — onUnhandledRequest:"error" catches unexpected calls
// ---------------------------------------------------------------------------
const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeCtx(): ToolContext {
  return {
    client: new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
}

// Decode the base64 payload embedded in the Python script
interface Payload {
  path: string;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("no base64 payload found in script");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Payload;
}

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return { client: { executePythonScript: exec }, logger: silentLogger } as unknown as ToolContext;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------
describe("getNodeStateRuntimeSchema", () => {
  it("accepts a valid path", () => {
    expect(() => getNodeStateRuntimeSchema.parse({ path: "/project1/noise1" })).not.toThrow();
  });

  it("accepts opt-in Info CHOP sampling", () => {
    expect(() =>
      getNodeStateRuntimeSchema.parse({
        path: "/project1/noise1",
        include_info_chop: true,
      }),
    ).not.toThrow();
  });

  it("rejects missing path", () => {
    expect(() => getNodeStateRuntimeSchema.parse({})).toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildNodeStateRuntimeScript — payload round-trip (pure, no bridge)
// ---------------------------------------------------------------------------
describe("buildNodeStateRuntimeScript", () => {
  it("embeds the path in the base64 payload", () => {
    const script = buildNodeStateRuntimeScript({ path: "/project1/blur1" });
    const payload = decodePayload(script);
    expect(payload.path).toBe("/project1/blur1");
  });

  it("handles paths with spaces and unicode without breaking Python quoting", () => {
    const script = buildNodeStateRuntimeScript({ path: '/project1/my node "üñícode"' });
    const payload = decodePayload(script);
    expect(payload.path).toBe('/project1/my node "üñícode"');
  });
});

// ---------------------------------------------------------------------------
// Happy path — full TOP report (cook time + resolution + errors empty)
// ---------------------------------------------------------------------------
describe("getNodeStateRuntimeImpl — happy path (TOP)", () => {
  it("decodes the payload correctly and returns a structured result with summary", async () => {
    let capturedScript = "";

    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script: string };
        capturedScript = body.script;
        return HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({
              path: "/project1/noise1",
              type: "noiseTOP",
              family: "TOP",
              cook_time_ms: 1.25,
              cook_count: 420,
              last_cook_frame: 300,
              resolution: [1920, 1080],
              gpu_memory: 8388608,
              errors: [],
              warnings: [],
              extra: {
                cookTime: 0.00125,
                totalCooks: 420,
                cookAbsFrame: 300,
                width: 1920,
                height: 1080,
                gpuMemory: 8388608,
              },
            }),
          },
        });
      }),
    );

    const result = await getNodeStateRuntimeImpl(makeCtx(), { path: "/project1/noise1" });

    // Confirm the payload that was sent to TD
    const payload = decodePayload(capturedScript);
    expect(payload.path).toBe("/project1/noise1");

    // Must not be an error
    expect(result.isError).toBeFalsy();

    // Summary should include key metrics
    const summary = textOf(result);
    expect(summary).toContain("/project1/noise1");
    expect(summary).toContain("noiseTOP");
    expect(summary).toContain("1.25ms");
    expect(summary).toContain("1920");
    expect(summary).toContain("1080");

    // Structured content should carry all fields
    const sc = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
    expect(sc).toBeDefined();
    expect(sc?.path).toBe("/project1/noise1");
    expect(sc?.type).toBe("noiseTOP");
    expect(sc?.family).toBe("TOP");
    expect(sc?.cook_count).toBe(420);
    expect(sc?.gpu_memory).toBe(8388608);
    expect(Array.isArray(sc?.errors)).toBe(true);
    expect((sc?.errors as string[]).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Happy path — CHOP report (num_chans + num_samples)
// ---------------------------------------------------------------------------
describe("getNodeStateRuntimeImpl — happy path (CHOP)", () => {
  it("surfaces num_chans and num_samples and includes them in the summary", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({
              path: "/project1/audioin1",
              type: "audiodeviceinCHOP",
              family: "CHOP",
              cook_time_ms: 0.3,
              cook_count: 100,
              num_chans: 2,
              num_samples: 512,
              errors: [],
              warnings: [],
            }),
          },
        }),
      ),
    );

    const result = await getNodeStateRuntimeImpl(makeCtx(), { path: "/project1/audioin1" });
    expect(result.isError).toBeFalsy();

    const summary = textOf(result);
    expect(summary).toContain("2 ch");

    const sc = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
    expect(sc?.num_chans).toBe(2);
    expect(sc?.num_samples).toBe(512);
  });
});

// ---------------------------------------------------------------------------
// Optional Info CHOP telemetry
// ---------------------------------------------------------------------------
describe("getNodeStateRuntimeImpl — Info CHOP telemetry", () => {
  it("surfaces sampled Info CHOP channels when include_info_chop is true", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({
              path: "/project1/noise1",
              type: "noiseTOP",
              family: "TOP",
              cook_time_ms: 0.5,
              errors: [],
              warnings: [],
              info_chop: {
                channels: {
                  cook_time: 0.0005,
                  total_cooks: 12,
                },
                warnings: [],
              },
            }),
          },
        }),
      ),
    );

    const result = await getNodeStateRuntimeImpl(makeCtx(), {
      path: "/project1/noise1",
      include_info_chop: true,
    });

    expect(result.isError).toBeFalsy();
    const summary = textOf(result);
    expect(summary).toContain("Info CHOP");
    const sc = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
    expect(sc?.info_chop).toMatchObject({
      channels: { cook_time: 0.0005, total_cooks: 12 },
      warnings: [],
    });
  });
});

// ---------------------------------------------------------------------------
// Cook errors surfaced
// ---------------------------------------------------------------------------
describe("getNodeStateRuntimeImpl — cook errors", () => {
  it("forwards cook errors and includes error count in the summary", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({
              path: "/project1/glsl1",
              type: "glslTOP",
              family: "TOP",
              errors: ["Fragment shader compile error: undefined variable 'foo'"],
              warnings: [],
            }),
          },
        }),
      ),
    );

    const result = await getNodeStateRuntimeImpl(makeCtx(), { path: "/project1/glsl1" });
    expect(result.isError).toBeFalsy();

    const summary = textOf(result);
    expect(summary).toContain("1 error(s)");

    const sc = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
    const errs = sc?.errors as string[];
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("undefined variable");
  });
});

// ---------------------------------------------------------------------------
// Fatal — operator not found → isError, no throw
// ---------------------------------------------------------------------------
describe("getNodeStateRuntimeImpl — fatal", () => {
  it("returns isError when bridge reports operator not found and does not throw", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({
              path: "/project1/does_not_exist",
              errors: [],
              warnings: [],
              fatal: "Operator not found: /project1/does_not_exist",
            }),
          },
        }),
      ),
    );

    const result = await getNodeStateRuntimeImpl(makeCtx(), {
      path: "/project1/does_not_exist",
    });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("not found");
    // Must not have thrown — result is a proper CallToolResult
    expect(Array.isArray(result.content)).toBe(true);
  });

  it("does not throw when executePythonScript rejects (TD offline)", async () => {
    const exec = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await getNodeStateRuntimeImpl(fakeCtx(exec), { path: "/project1/noise1" });
    expect(result.isError).toBe(true);
    // guardTd converts the error; handler must not propagate
    expect(Array.isArray(result.content)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bad input — schema rejects missing path
// ---------------------------------------------------------------------------
describe("getNodeStateRuntimeSchema — bad input", () => {
  it("throws when path is missing", () => {
    expect(() => getNodeStateRuntimeSchema.parse({})).toThrow();
  });

  it("throws when path is not a string", () => {
    expect(() => getNodeStateRuntimeSchema.parse({ path: 42 })).toThrow();
  });
});
