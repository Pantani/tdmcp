import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  computeTypeDefaults,
  snapshotTdGraphImpl,
  toCompactNodes,
} from "../../src/tools/layer3/snapshotTdGraph.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

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

function decodePayload(script: string): Record<string, unknown> {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (!b64) throw new Error("No b64decode payload found");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<string, unknown>;
}

describe("computeTypeDefaults / toCompactNodes (pure)", () => {
  const nodes = [
    { path: "/p/a", type: "noiseTOP", name: "a", parameters: { period: 1, amp: 1 } },
    { path: "/p/b", type: "noiseTOP", name: "b", parameters: { period: 1, amp: 9 } },
    { path: "/p/c", type: "noiseTOP", name: "c", parameters: { period: 1, amp: 1 } },
    { path: "/p/d", type: "blurTOP", name: "d", parameters: { size: 4 } },
  ];

  it("hoists each type's most-common value per parameter", () => {
    const defaults = computeTypeDefaults(nodes);
    // period is always 1; amp is 1 in two of three noiseTOPs → mode is 1.
    expect(defaults.noiseTOP).toEqual({ period: 1, amp: 1 });
    expect(defaults.blurTOP).toEqual({ size: 4 });
  });

  it("delta-encodes nodes and drops parameters that match the type default", () => {
    const defaults = computeTypeDefaults(nodes);
    const compact = toCompactNodes(nodes, defaults);
    const a = compact.find((n) => n.name === "a");
    const b = compact.find((n) => n.name === "b");
    // a matches the default exactly → no parameters block at all.
    expect(a?.parameters).toBeUndefined();
    // b only differs in amp → just that delta is kept.
    expect(b?.parameters).toEqual({ amp: 9 });
  });

  it("keeps nodes without parameters intact", () => {
    const compact = toCompactNodes([{ path: "/p/x", type: "nullTOP", name: "x" }], {});
    expect(compact[0]).toEqual({ path: "/p/x", type: "nullTOP", name: "x" });
  });
});

describe("snapshotTdGraphImpl", () => {
  it("returns a plain snapshot by default (no typeDefaults)", async () => {
    const result = await snapshotTdGraphImpl(makeCtx(), {
      path: "/project1",
      include_params: false,
      compact: false,
      include_parameter_modes: false,
    });
    expect(result.isError).toBeFalsy();
    const data = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
    expect(data?.compact).toBeUndefined();
    expect(data?.typeDefaults).toBeUndefined();
    expect(data?.nodeCount).toBe(1);
  });

  it("compact mode hoists type defaults and marks compact:true", async () => {
    // Compact mode implies wantModes=true. The default exec mock returns an
    // empty stdout which would fail JSON parsing and (post-fix) surface as a
    // real error instead of being silently swallowed; provide a valid empty
    // parameters payload so the modes read degrades cleanly.
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({
          ok: true,
          data: { result: null, stdout: JSON.stringify({ parameters: [] }) },
        }),
      ),
    );
    const result = await snapshotTdGraphImpl(makeCtx(), {
      path: "/project1",
      include_params: false,
      compact: true,
      include_parameter_modes: false,
    });
    expect(result.isError).toBeFalsy();
    const data = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
    expect(data?.compact).toBe(true);
    // The mock node is a noiseTOP with params {period, amplitude}; they hoist into typeDefaults
    // and the single node carries no delta.
    const typeDefaults = data?.typeDefaults as Record<string, Record<string, unknown>>;
    expect(Object.keys(typeDefaults)).toContain("noiseTOP");
    const nodes = data?.nodes as Array<{ name: string; parameters?: unknown }>;
    expect(nodes[0]?.parameters).toBeUndefined();
  });

  it("compact mode preserves reactive parameter state when available", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: string };
        capturedScript = body.script ?? "";
        return HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({
              path: "/project1/noise1",
              parameters: {
                period: { name: "period", mode: "EXPRESSION", expression: "absTime.seconds" },
                amplitude: { name: "amplitude", mode: "CONSTANT", value: 1 },
              },
              warnings: [],
            }),
          },
        });
      }),
    );
    const result = await snapshotTdGraphImpl(makeCtx(), {
      path: "/project1",
      include_params: false,
      compact: true,
      include_parameter_modes: false,
    });
    expect(result.isError).toBeFalsy();
    const payload = decodePayload(capturedScript);
    expect(payload.non_default_only).toBe(true);
    const data = result.structuredContent as {
      nodes: Array<{ parameter_modes?: Record<string, unknown> }>;
    };
    expect(data.nodes[0]?.parameter_modes).toEqual({
      period: { name: "period", mode: "EXPRESSION", expression: "absTime.seconds" },
    });
  });

  it("non-compact parameter-mode snapshots keep full mode reads", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: string };
        capturedScript = body.script ?? "";
        return HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({
              path: "/project1/noise1",
              parameters: {
                period: { name: "period", mode: "EXPRESSION", expression: "absTime.seconds" },
                amplitude: { name: "amplitude", mode: "CONSTANT", value: 1 },
              },
              warnings: [],
            }),
          },
        });
      }),
    );
    const result = await snapshotTdGraphImpl(makeCtx(), {
      path: "/project1",
      include_params: false,
      compact: false,
      include_parameter_modes: true,
    });
    expect(result.isError).toBeFalsy();
    const payload = decodePayload(capturedScript);
    expect(payload.non_default_only).toBe(false);
    const data = result.structuredContent as {
      nodes: Array<{ parameter_modes?: Record<string, unknown> }>;
    };
    expect(data.nodes[0]?.parameter_modes).toEqual({
      period: { name: "period", mode: "EXPRESSION", expression: "absTime.seconds" },
      amplitude: { name: "amplitude", mode: "CONSTANT", value: 1 },
    });
  });

  it("compact mode also accepts read_parameter_modes array output", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({
              path: "/project1/noise1",
              type: "noiseTOP",
              name: "noise1",
              parameters: [
                { name: "period", mode: "EXPRESSION", expr: "absTime.seconds" },
                { name: "amplitude", mode: "CONSTANT", value: 1 },
              ],
              warnings: [],
            }),
          },
        }),
      ),
    );
    const result = await snapshotTdGraphImpl(makeCtx(), {
      path: "/project1",
      include_params: false,
      compact: true,
      include_parameter_modes: false,
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as {
      nodes: Array<{ parameter_modes?: Record<string, unknown> }>;
    };
    expect(data.nodes[0]?.parameter_modes).toEqual({
      period: { name: "period", mode: "EXPRESSION", expr: "absTime.seconds" },
    });
  });

  // ---------------------------------------------------------------------
  // REST-first parameter-modes path (G4 bridge promotion, wave-1)
  // ---------------------------------------------------------------------
  it("prefers /api/nodes/:seg/params (REST) over /api/exec for parameter modes", async () => {
    let execCalled = false;
    server.use(
      http.get(`${TD_BASE}/api/nodes/:seg/params`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            path: "/project1/noise1",
            type: "noiseTOP",
            name: "noise1",
            parameters: [
              { name: "period", mode: "EXPRESSION", expr: "absTime.seconds" },
              { name: "amplitude", mode: "CONSTANT", value: 1 },
            ],
            warnings: [],
          },
        }),
      ),
      http.post(`${TD_BASE}/api/exec`, () => {
        execCalled = true;
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );

    const result = await snapshotTdGraphImpl(makeCtx(), {
      path: "/project1",
      include_params: false,
      compact: false,
      include_parameter_modes: true,
    });

    expect(result.isError).toBeFalsy();
    expect(execCalled).toBe(false); // exec must NOT be hit on the REST-first path
    const data = result.structuredContent as {
      nodes: Array<{ parameter_modes?: Record<string, unknown> }>;
    };
    expect(data.nodes[0]?.parameter_modes).toEqual({
      period: { name: "period", mode: "EXPRESSION", expr: "absTime.seconds" },
      amplitude: { name: "amplitude", mode: "CONSTANT", value: 1 },
    });
  });

  it("falls back to /api/exec when the REST endpoint is missing (older bridge)", async () => {
    let execCalled = false;
    server.use(
      // Default 404 stays for /api/nodes/:seg/params, so tryEndpoint falls back.
      http.post(`${TD_BASE}/api/exec`, () => {
        execCalled = true;
        return HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({
              path: "/project1/noise1",
              parameters: {
                period: { name: "period", mode: "EXPRESSION", expression: "absTime.seconds" },
              },
              warnings: [],
            }),
          },
        });
      }),
    );

    const result = await snapshotTdGraphImpl(makeCtx(), {
      path: "/project1",
      include_params: false,
      compact: false,
      include_parameter_modes: true,
    });

    expect(result.isError).toBeFalsy();
    expect(execCalled).toBe(true);
    const data = result.structuredContent as {
      nodes: Array<{ parameter_modes?: Record<string, unknown> }>;
    };
    expect(data.nodes[0]?.parameter_modes).toEqual({
      period: { name: "period", mode: "EXPRESSION", expression: "absTime.seconds" },
    });
  });

  // Non-404 errors on the REST endpoint must NOT silently fall back to /api/exec —
  // tryEndpoint only treats endpoint-missing (404) as a fallback signal; anything
  // else (400/500/etc.) is a real error and should surface as such.
  it("does not fall back to /api/exec when /api/nodes/:seg/params returns 400", async () => {
    let execCalled = false;
    server.use(
      http.get(`${TD_BASE}/api/nodes/:seg/params`, () =>
        HttpResponse.json({ ok: false, error: "bad request" }, { status: 400 }),
      ),
      http.post(`${TD_BASE}/api/exec`, () => {
        execCalled = true;
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );

    await snapshotTdGraphImpl(makeCtx(), {
      path: "/project1",
      include_params: false,
      compact: false,
      include_parameter_modes: true,
    });

    // The non-404 must surface as an error (or at least not be papered over by
    // the exec fallback). The critical invariant is exec was NOT called.
    expect(execCalled).toBe(false);
  });

  it("reports parameter-mode truncation separately from parameter-value truncation", async () => {
    server.use(
      http.get(`${TD_BASE}/api/network/:seg/topology`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            nodes: Array.from({ length: 61 }, (_, i) => ({
              path: `/project1/node${i}`,
              type: "noiseTOP",
              name: `node${i}`,
            })),
            connections: [],
          },
        }),
      ),
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({
              parameters: {
                period: { name: "period", mode: "CONSTANT", value: 1 },
              },
            }),
          },
        }),
      ),
    );

    const result = await snapshotTdGraphImpl(makeCtx(), {
      path: "/project1",
      include_params: false,
      compact: false,
      include_parameter_modes: true,
    });

    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as {
      params_truncated: boolean;
      parameter_modes_truncated?: boolean;
      nodes: Array<{ parameter_modes_unfetched?: boolean }>;
    };
    expect(data.params_truncated).toBe(false);
    expect(data.parameter_modes_truncated).toBe(true);
    expect(data.nodes.filter((node) => node.parameter_modes_unfetched)).toHaveLength(1);
  });
});
