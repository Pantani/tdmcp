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

// ---------------------------------------------------------------------------
// wave-9 — REST custom_params endpoint promotion (partial, custom_params only)
// ---------------------------------------------------------------------------
describe("serializeNetworkImpl — REST custom_params promotion", () => {
  // Skeleton report the exec script returns when skip_custom_in_script=true.
  const SKELETON = {
    root: "/project1",
    nodes: [
      { name: "noise1", type: "noiseTOP", params: {}, inputs: [] },
      { name: "blur1", type: "blurTOP", params: {}, inputs: [] },
    ],
    warnings: [],
  };

  it("REST-first: prefers /custom_params endpoint per node and skips the in-script readout", async () => {
    let execHits = 0;
    let capturedScript = "";
    const restHits: string[] = [];
    server.use(
      http.get(`${TD_BASE}/api/nodes/:seg/custom_params`, ({ params }) => {
        const seg = decodeURIComponent(params.seg as string);
        restHits.push(seg);
        return HttpResponse.json({
          ok: true,
          data: {
            params: [{ name: "Speed", page: "Custom", style: "Float", default: 1.0, value: 1.0 }],
            warnings: [],
          },
        });
      }),
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        execHits += 1;
        const body = (await request.json()) as { script: string };
        capturedScript = body.script;
        return HttpResponse.json({
          ok: true,
          data: { result: null, stdout: JSON.stringify(SKELETON) },
        });
      }),
    );

    const result = await serializeNetworkImpl(makeCtx(), {
      path: "/project1",
      max_nodes: 200,
      include_custom_params: true,
    });

    expect(result.isError).toBeFalsy();
    // Exec is called exactly once (skeleton), NOT a second time after REST succeeded.
    expect(execHits).toBe(1);
    // The exec script was instructed to skip the in-script custom_params readout.
    const payload = JSON.parse(
      Buffer.from(/b64decode\("([^"]+)"\)/.exec(capturedScript)?.[1] ?? "", "base64").toString(
        "utf8",
      ),
    ) as { skip_custom_in_script?: boolean };
    expect(payload.skip_custom_in_script).toBe(true);
    // REST endpoint was called once per node, with the child path.
    expect(restHits).toEqual(["/project1/noise1", "/project1/blur1"]);
    // The endpoint params were mapped onto each node in the SerializedCustomPar shape.
    const sc = result.structuredContent as {
      nodes: Array<{ name: string; custom_params?: Array<Record<string, unknown>> }>;
    };
    expect(sc.nodes[0]?.custom_params).toEqual([
      { name: "Speed", page: "Custom", style: "Float", default: 1.0 },
    ]);
    expect(sc.nodes[1]?.custom_params).toEqual([
      { name: "Speed", page: "Custom", style: "Float", default: 1.0 },
    ]);
  });

  it("falls back to in-script custom_params readout when the REST endpoint is absent (404)", async () => {
    // tdMock default already returns 404 for /api/nodes/:seg/custom_params.
    let execHits = 0;
    const capturedScripts: string[] = [];
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        execHits += 1;
        const body = (await request.json()) as { script: string };
        capturedScripts.push(body.script);
        return HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({
              ...SKELETON,
              nodes: [
                {
                  ...SKELETON.nodes[0],
                  custom_params: [{ name: "Speed", page: "Custom", style: "Float", default: 1.0 }],
                },
                { ...SKELETON.nodes[1] },
              ],
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
    // First call: skeleton (skip=true). Second call (fallback after 404 on first node): skip=false.
    expect(execHits).toBe(2);
    const firstPayload = JSON.parse(
      Buffer.from(
        /b64decode\("([^"]+)"\)/.exec(capturedScripts[0] ?? "")?.[1] ?? "",
        "base64",
      ).toString("utf8"),
    ) as { skip_custom_in_script?: boolean };
    const secondPayload = JSON.parse(
      Buffer.from(
        /b64decode\("([^"]+)"\)/.exec(capturedScripts[1] ?? "")?.[1] ?? "",
        "base64",
      ).toString("utf8"),
    ) as { skip_custom_in_script?: boolean };
    expect(firstPayload.skip_custom_in_script).toBe(true);
    expect(secondPayload.skip_custom_in_script).toBe(false);
    // Output shape preserved: in-script custom_params come through unchanged.
    const sc = result.structuredContent as {
      nodes: Array<{ name: string; custom_params?: Array<Record<string, unknown>> }>;
    };
    expect(sc.nodes[0]?.custom_params).toEqual([
      { name: "Speed", page: "Custom", style: "Float", default: 1.0 },
    ]);
  });
});
