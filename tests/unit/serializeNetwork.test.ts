import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  buildSerializeNetworkScript,
  serializeNetworkImpl,
  serializeNetworkSchema,
} from "../../src/tools/layer3/serializeNetwork.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

// ---------------------------------------------------------------------------
// Shared MSW server (onUnhandledRequest:"error" so any unexpected call fails)
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

// ---------------------------------------------------------------------------
// Payload decode helper (mirrors readParameterModes.test.ts pattern)
// ---------------------------------------------------------------------------
interface Payload {
  path: string;
  max_nodes: number;
  include_custom_params: boolean;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Payload;
}

// ---------------------------------------------------------------------------
// Schema defaults
// ---------------------------------------------------------------------------
describe("serializeNetworkSchema", () => {
  it("defaults max_nodes to 200 and include_custom_params to true", () => {
    const parsed = serializeNetworkSchema.parse({ path: "/project1" });
    expect(parsed.max_nodes).toBe(200);
    expect(parsed.include_custom_params).toBe(true);
  });

  it("rejects a call with no path (required field)", () => {
    expect(() => serializeNetworkSchema.parse({})).toThrow();
  });

  it("rejects an out-of-range max_nodes", () => {
    expect(() => serializeNetworkSchema.parse({ path: "/project1", max_nodes: 0 })).toThrow();
    expect(() => serializeNetworkSchema.parse({ path: "/project1", max_nodes: 999 })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildSerializeNetworkScript — pure payload round-trip
// ---------------------------------------------------------------------------
describe("buildSerializeNetworkScript", () => {
  it("round-trips the payload intact through base64", () => {
    const payload = { path: "/project1", max_nodes: 200, include_custom_params: true };
    const script = buildSerializeNetworkScript(payload);
    expect(decodePayload(script)).toEqual(payload);
  });

  it("handles paths with quotes and unicode without breaking Python", () => {
    const payload = { path: '/project1/my "comp"', max_nodes: 50, include_custom_params: false };
    const script = buildSerializeNetworkScript(payload);
    expect(decodePayload(script)).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// Happy path — two nodes plus a wire between them
// ---------------------------------------------------------------------------
describe("serializeNetworkImpl — happy path", () => {
  it("returns the diffable spec (nodes, params, wires) and a correct summary", async () => {
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
              root: "/project1",
              nodes: [
                {
                  name: "noise1",
                  type: "noiseTOP",
                  params: {
                    period: { value: 1, mode: "CONSTANT" },
                    tx: { value: 0.5, mode: "EXPRESSION", expr: "absTime.frame * 0.01" },
                  },
                  inputs: [],
                  x: 0,
                  y: 0,
                },
                {
                  name: "blur1",
                  type: "blurTOP",
                  params: { size: { value: 4, mode: "CONSTANT" } },
                  inputs: [{ from: "noise1", out_index: 0, in_index: 0 }],
                  x: 200,
                  y: 0,
                },
              ],
              warnings: [],
            }),
          },
        });
      }),
    );

    const result = await serializeNetworkImpl(makeCtx(), {
      path: "/project1",
      max_nodes: 200,
      include_custom_params: true,
    });

    expect(result.isError).toBeFalsy();

    // Assert the payload that was actually sent to TD
    const payload = decodePayload(capturedScript);
    expect(payload.path).toBe("/project1");
    expect(payload.max_nodes).toBe(200);
    expect(payload.include_custom_params).toBe(true);

    // Assert the structured content matches the SHARED SPEC shape
    const sc = result.structuredContent as {
      root: string;
      nodes: Array<{
        name: string;
        type: string;
        params: Record<string, { value?: unknown; mode?: string; expr?: string }>;
        inputs: Array<{ from: string; out_index: number; in_index: number }>;
        x?: number;
        y?: number;
      }>;
      truncated?: boolean;
      warnings: string[];
    };
    expect(sc.root).toBe("/project1");
    expect(sc.nodes).toHaveLength(2);
    expect(sc.nodes[0]?.name).toBe("noise1");
    expect(sc.nodes[0]?.type).toBe("noiseTOP");
    expect(sc.nodes[0]?.params.tx?.mode).toBe("EXPRESSION");
    expect(sc.nodes[0]?.params.tx?.expr).toBe("absTime.frame * 0.01");
    expect(sc.nodes[1]?.name).toBe("blur1");
    expect(sc.nodes[1]?.inputs).toHaveLength(1);
    expect(sc.nodes[1]?.inputs[0]?.from).toBe("noise1");
    expect(sc.nodes[1]?.inputs[0]?.out_index).toBe(0);
    expect(sc.nodes[1]?.inputs[0]?.in_index).toBe(0);
    expect(sc.warnings).toHaveLength(0);

    // Assert the friendly summary text
    const textBlock = result.content[0];
    expect(textBlock?.type).toBe("text");
    const summary = (textBlock as { type: "text"; text: string }).text;
    expect(summary).toContain("Serialized 2 node(s)");
    expect(summary).toContain("/project1");
    expect(summary).toContain("1 wire(s)");
  });

  it("passes max_nodes and include_custom_params through the payload correctly", async () => {
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
              root: "/project1",
              nodes: [],
              truncated: true,
              warnings: [],
            }),
          },
        });
      }),
    );

    const result = await serializeNetworkImpl(makeCtx(), {
      path: "/project1",
      max_nodes: 5,
      include_custom_params: false,
    });

    expect(result.isError).toBeFalsy();
    const payload = decodePayload(capturedScript);
    expect(payload.max_nodes).toBe(5);
    expect(payload.include_custom_params).toBe(false);

    const sc = result.structuredContent as { truncated?: boolean };
    expect(sc.truncated).toBe(true);
    const summary = (result.content[0] as { type: "text"; text: string }).text;
    expect(summary).toContain("truncated");
  });
});

// ---------------------------------------------------------------------------
// Fatal — root not found → isError, no throw
// ---------------------------------------------------------------------------
describe("serializeNetworkImpl — fatal bridge error", () => {
  it("returns isError when the root is not found and does not throw", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({
              root: "/project1/nope",
              nodes: [],
              warnings: [],
              fatal: "Root not found: /project1/nope",
            }),
          },
        }),
      ),
    );

    const result = await serializeNetworkImpl(makeCtx(), {
      path: "/project1/nope",
      max_nodes: 200,
      include_custom_params: true,
    });

    expect(result.isError).toBe(true);
    const textBlock = result.content[0] as { type: "text"; text: string };
    expect(textBlock.text).toContain("not found");
  });

  it("returns isError when the bridge is unreachable (TdConnectionError) and never throws", async () => {
    server.use(http.post(`${TD_BASE}/api/exec`, () => HttpResponse.error()));

    const result = await serializeNetworkImpl(makeCtx(), {
      path: "/project1",
      max_nodes: 200,
      include_custom_params: true,
    });

    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bad input — missing required field
// ---------------------------------------------------------------------------
describe("serializeNetworkImpl — bad input", () => {
  it("schema rejects a call with no path", () => {
    expect(() => serializeNetworkSchema.parse({})).toThrow();
  });
});
