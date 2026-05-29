import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { isMissingEndpoint, TdApiError, TdConnectionError } from "../../src/td-client/types.js";
import { connectNodesViaBridge } from "../../src/tools/layer2/connectHelper.js";
import { connectNodesImpl } from "../../src/tools/layer2/connectNodes.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

// ---------------------------------------------------------------------------
// connect_disconnect_endpoint
//
// The first-class POST /api/connect + /api/disconnect endpoints survive
// TDMCP_BRIDGE_ALLOW_EXEC=0. This file pins down three layers:
//   1. the response SHAPES (ConnectResultSchema / DisconnectResultSchema, design
//      §3.6) and the request-body SHAPES the client methods send (design §3.2);
//   2. the connectNodesViaBridge fallback chain (endpoint → batch → python) via
//      direct client mocks — endpoint-success + connection-error propagation;
//   3. the integrated batch-error surfacing through the real client + msw mock
//      (the merged tdMock 404s /api/connect, so the endpoint cleanly falls
//      through to the batch path these tests exercise).
// ---------------------------------------------------------------------------

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeClient(): TouchDesignerClient {
  return new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 });
}

function makeCtx(): ToolContext {
  return {
    client: makeClient(),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/**
 * `/api/batch` resolves (HTTP 200) but reports the connect op failed inside the
 * batch — the case the helper used to swallow before falling through to Python.
 */
function batchReportsConnectFailure(error?: string) {
  return http.post(`${TD_BASE}/api/batch`, () =>
    HttpResponse.json({
      ok: true,
      data: { results: [{ action: "connect", ok: false, ...(error ? { error } : {}) }] },
    }),
  );
}

// --- Response schemas (verbatim from design §3.6) --------------------------
const ConnectResultSchema = z.object({
  source_path: z.string(),
  target_path: z.string(),
  requested_input: z.number().int().optional(),
  actual_input: z.number().int().optional(),
  source_output: z.number().int().default(0),
  connected: z.boolean().default(true),
});

const DisconnectResultSchema = z.object({
  to_path: z.string(),
  from_path: z.string().nullable().optional(),
  to_input: z.number().int().nullable().optional(),
  removed: z.array(z.object({ input: z.number().int(), from: z.string() })).default([]),
  warnings: z.array(z.string()).default([]),
});

// --- Request-body shapers (the contract the client methods §3.5 must send) --
interface ConnectBody {
  source_path: string;
  target_path: string;
  source_output: number;
  target_input: number;
}

function connectBody(
  sourcePath: string,
  targetPath: string,
  sourceOutput = 0,
  targetInput = 0,
): ConnectBody {
  return {
    source_path: sourcePath,
    target_path: targetPath,
    source_output: sourceOutput,
    target_input: targetInput,
  };
}

interface DisconnectBody {
  to_path: string;
  from_path: string | null;
  to_input: number | null;
}

function disconnectBody(toPath: string, fromPath?: string, toInput?: number): DisconnectBody {
  return {
    to_path: toPath,
    from_path: fromPath ?? null,
    to_input: toInput ?? null,
  };
}

// ---------------------------------------------------------------------------
// ConnectResultSchema
// ---------------------------------------------------------------------------

describe("ConnectResultSchema", () => {
  it("parses a canonical /api/connect response", () => {
    const parsed = ConnectResultSchema.parse({
      source_path: "/project1/noise1",
      target_path: "/project1/blur1",
      requested_input: 0,
      actual_input: 0,
      source_output: 0,
      connected: true,
    });
    expect(parsed.source_path).toBe("/project1/noise1");
    expect(parsed.target_path).toBe("/project1/blur1");
    expect(parsed.requested_input).toBe(0);
    expect(parsed.actual_input).toBe(0);
    expect(parsed.connected).toBe(true);
  });

  it("preserves actual_input != requested_input (multi-input packing, §0.2)", () => {
    // A compositeTOP wired into requested slot 2 packs down to slot 1; the
    // endpoint reports the slot TD actually used.
    const parsed = ConnectResultSchema.parse({
      source_path: "/project1/src2",
      target_path: "/project1/comp1",
      requested_input: 2,
      actual_input: 1,
      source_output: 0,
      connected: true,
    });
    expect(parsed.requested_input).toBe(2);
    expect(parsed.actual_input).toBe(1);
    expect(parsed.actual_input).not.toBe(parsed.requested_input);
  });

  it("defaults source_output and connected when omitted", () => {
    const parsed = ConnectResultSchema.parse({
      source_path: "/a",
      target_path: "/b",
    });
    expect(parsed.source_output).toBe(0);
    expect(parsed.connected).toBe(true);
    expect(parsed.actual_input).toBeUndefined();
  });

  it("rejects a non-integer actual_input (guards a malformed bridge reply)", () => {
    expect(() =>
      ConnectResultSchema.parse({
        source_path: "/a",
        target_path: "/b",
        actual_input: 1.5,
      }),
    ).toThrow();
  });

  it("rejects a response missing the required paths", () => {
    expect(() => ConnectResultSchema.parse({ connected: true })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// DisconnectResultSchema
// ---------------------------------------------------------------------------

describe("DisconnectResultSchema", () => {
  it("parses a canonical /api/disconnect response with removed wires", () => {
    const parsed = DisconnectResultSchema.parse({
      to_path: "/project1/blur1",
      from_path: "/project1/noise1",
      to_input: 0,
      removed: [{ input: 0, from: "/project1/noise1" }],
      warnings: [],
    });
    expect(parsed.to_path).toBe("/project1/blur1");
    expect(parsed.from_path).toBe("/project1/noise1");
    expect(parsed.removed).toEqual([{ input: 0, from: "/project1/noise1" }]);
  });

  it("accepts null from_path / to_input (remove-all semantics) and defaults arrays", () => {
    const parsed = DisconnectResultSchema.parse({
      to_path: "/project1/composite1",
      from_path: null,
      to_input: null,
    });
    expect(parsed.from_path).toBeNull();
    expect(parsed.to_input).toBeNull();
    expect(parsed.removed).toEqual([]);
    expect(parsed.warnings).toEqual([]);
  });

  it("carries fail-forward per-wire warnings", () => {
    const parsed = DisconnectResultSchema.parse({
      to_path: "/project1/comp1",
      removed: [{ input: 1, from: "/project1/src2" }],
      warnings: ["disconnect failed for inputConnectors[0] from /project1/src1: ..."],
    });
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.removed).toHaveLength(1);
  });

  it("rejects a removed entry whose input is not an integer", () => {
    expect(() =>
      DisconnectResultSchema.parse({
        to_path: "/x",
        removed: [{ input: 0.5, from: "/y" }],
      }),
    ).toThrow();
  });

  it("rejects a response missing to_path", () => {
    expect(() => DisconnectResultSchema.parse({ removed: [] })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Request-body shaping (the REST contract §3.2 the client must send)
// ---------------------------------------------------------------------------

describe("connectBody", () => {
  it("shapes the POST /api/connect body with explicit indices", () => {
    expect(connectBody("/project1/src1", "/project1/dst1", 1, 2)).toEqual({
      source_path: "/project1/src1",
      target_path: "/project1/dst1",
      source_output: 1,
      target_input: 2,
    });
  });

  it("defaults source_output and target_input to 0", () => {
    expect(connectBody("/a", "/b")).toEqual({
      source_path: "/a",
      target_path: "/b",
      source_output: 0,
      target_input: 0,
    });
  });

  it("round-trips through ConnectResultSchema's input contract", () => {
    // The body keys are the exact keys §3.2 names for the request; the response
    // schema shares source_path/target_path/source_output — sanity-check overlap.
    const body = connectBody("/a", "/b", 0, 3);
    const echoed = ConnectResultSchema.parse({
      source_path: body.source_path,
      target_path: body.target_path,
      requested_input: body.target_input,
      actual_input: body.target_input,
      source_output: body.source_output,
      connected: true,
    });
    expect(echoed.requested_input).toBe(3);
  });
});

describe("disconnectBody", () => {
  it("null-coalesces omitted from_path and to_input (remove-all)", () => {
    expect(disconnectBody("/project1/blur1")).toEqual({
      to_path: "/project1/blur1",
      from_path: null,
      to_input: null,
    });
  });

  it("passes through an explicit from_path and to_input", () => {
    expect(disconnectBody("/project1/blur1", "/project1/noise1", 0)).toEqual({
      to_path: "/project1/blur1",
      from_path: "/project1/noise1",
      to_input: 0,
    });
  });

  it("keeps to_input 0 distinct from omitted (0 is a real slot, not null)", () => {
    expect(disconnectBody("/x", undefined, 0).to_input).toBe(0);
    expect(disconnectBody("/x").to_input).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// connectNodesViaBridge — direct-mock fallback chain (endpoint → batch → python)
// ---------------------------------------------------------------------------
describe("connectNodesViaBridge — fallback chain", () => {
  it("uses the /api/connect endpoint first and reports method 'endpoint'", async () => {
    const connectNodes = vi.fn(async () => ({
      source_path: "/p/a",
      target_path: "/p/b",
      actual_input: 0,
      source_output: 0,
      connected: true,
    }));
    const batch = vi.fn();
    const executePythonScript = vi.fn();
    const client = { connectNodes, batch, executePythonScript } as never;

    const result = await connectNodesViaBridge(client, "/p/a", "/p/b");
    expect(result.method).toBe("endpoint");
    expect(connectNodes).toHaveBeenCalledOnce();
    expect(batch).not.toHaveBeenCalled();
    expect(executePythonScript).not.toHaveBeenCalled();
  });

  it("falls back to batch on a 404 (missing route), then python when batch reports not-ok", async () => {
    const connectNodes = vi.fn(async () => {
      throw new TdApiError("no endpoint", { status: 404 });
    });
    // batch resolves but the op did not succeed -> python fallback fires.
    const batch = vi.fn(async () => ({ results: [{ action: "connect", ok: false }] }));
    const executePythonScript = vi.fn(async () => ({ stdout: "" }));
    const client = { connectNodes, batch, executePythonScript } as never;

    const result = await connectNodesViaBridge(client, "/p/a", "/p/b");
    expect(result.method).toBe("python");
    expect(batch).toHaveBeenCalledOnce();
    expect(executePythonScript).toHaveBeenCalledOnce();
  });

  it("propagates a TdConnectionError from the endpoint (does not fall back)", async () => {
    const connectNodes = vi.fn(async () => {
      throw new TdConnectionError("offline");
    });
    const batch = vi.fn();
    const client = { connectNodes, batch, executePythonScript: vi.fn() } as never;

    await expect(connectNodesViaBridge(client, "/p/a", "/p/b")).rejects.toBeInstanceOf(
      TdConnectionError,
    );
    expect(batch).not.toHaveBeenCalled();
  });

  it("propagates a validation TdApiError (400) instead of falling back", async () => {
    // A current bridge rejecting the wire (e.g. cross-container) returns 400 with
    // a specific message — NOT a missing route — so it must surface, not silently
    // retry via batch/python (which would reintroduce the old no-op behavior).
    const connectNodes = vi.fn(async () => {
      throw new TdApiError("connect: cannot wire across containers", { status: 400 });
    });
    const batch = vi.fn();
    const client = { connectNodes, batch, executePythonScript: vi.fn() } as never;

    await expect(connectNodesViaBridge(client, "/p/a", "/p/b")).rejects.toThrow(
      /cannot wire across containers/,
    );
    expect(batch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// connect endpoint fallback chain — integrated (real client + msw, /api/connect
// 404s so the batch path runs) — proves the batch error is surfaced, not dropped
// ---------------------------------------------------------------------------
describe("connect endpoint fallback chain", () => {
  it("happy path: a clean batch connect reports method 'batch' and no batchError", async () => {
    const result = await connectNodesViaBridge(makeClient(), "/project1/a", "/project1/b");
    expect(result.method).toBe("batch");
    expect(result.batchError).toBeUndefined();
  });

  it("captures the batch op error on the recovered ConnectResult", async () => {
    server.use(batchReportsConnectFailure("connect op not supported by batch"));
    const result = await connectNodesViaBridge(makeClient(), "/project1/a", "/project1/b");
    expect(result.method).toBe("python");
    expect(result.batchError).toBe("connect op not supported by batch");
  });

  it("connect_nodes mentions the batch error in its output when Python recovers", async () => {
    server.use(batchReportsConnectFailure("cannot wire across containers"));
    const result = await connectNodesImpl(makeCtx(), {
      source_path: "/project1/a",
      target_path: "/project1/b",
      source_output: 0,
      target_input: 0,
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("via python");
    expect(text).toContain("cannot wire across containers");
  });

  it("folds the batch error into the thrown message when the Python fallback also fails", async () => {
    server.use(
      batchReportsConnectFailure("batch connect rejected"),
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({ ok: false, error: { message: "python connect raised" } }),
      ),
    );
    const result = await connectNodesImpl(makeCtx(), {
      source_path: "/project1/a",
      target_path: "/project1/b",
      source_output: 0,
      target_input: 0,
    });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    // Both the Python error and the discarded batch reason are surfaced.
    expect(text).toContain("python connect raised");
    expect(text).toContain("batch connect rejected");
  });

  it("does not invent a batchError when the batch op fails without an error string", async () => {
    server.use(batchReportsConnectFailure(undefined));
    const result = await connectNodesViaBridge(makeClient(), "/project1/a", "/project1/b");
    expect(result.method).toBe("python");
    expect(result.batchError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isMissingEndpoint — the shared signal that gates every endpoint→exec fallback
// ---------------------------------------------------------------------------
describe("isMissingEndpoint", () => {
  it("treats HTTP 404 as a missing endpoint (older bridge / proxy)", () => {
    expect(isMissingEndpoint(new TdApiError("nope", { status: 404 }))).toBe(true);
  });

  it("treats a 400 'Unsupported <METHOD> <path>' as a missing endpoint", () => {
    // The bridge router answers an unmatched route with this exact 400 message.
    expect(
      isMissingEndpoint(new TdApiError("Unsupported POST /api/connect", { status: 400 })),
    ).toBe(true);
  });

  it("does NOT treat a real validation 400 as missing (it must surface)", () => {
    expect(
      isMissingEndpoint(new TdApiError("connect: cannot wire across containers", { status: 400 })),
    ).toBe(false);
    expect(isMissingEndpoint(new TdApiError("No such parameter: foo", { status: 400 }))).toBe(
      false,
    );
  });

  it("returns false for connection/timeout/other errors (they propagate)", () => {
    expect(isMissingEndpoint(new TdConnectionError("offline"))).toBe(false);
    expect(isMissingEndpoint(new Error("x"))).toBe(false);
    expect(isMissingEndpoint(undefined)).toBe(false);
  });
});
