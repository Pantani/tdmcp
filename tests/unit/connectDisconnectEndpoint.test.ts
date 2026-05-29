import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { TdApiError, TdConnectionError } from "../../src/td-client/types.js";
import { connectNodesViaBridge } from "../../src/tools/layer2/connectHelper.js";

// ---------------------------------------------------------------------------
// connect_disconnect_endpoint — Builder 2 (isolated)
//
// The first-class POST /api/connect + /api/disconnect endpoints survive
// TDMCP_BRIDGE_ALLOW_EXEC=0. The tool rewires (connectHelper.ts /
// disconnectNodes.ts / touchDesignerClient.ts / validators.ts) are INTEGRATOR
// work — this builder cannot edit those shared files, so this test cannot depend
// on them. Instead it pins down exactly what Builder 2 owns:
//   1. the response SHAPES (ConnectResultSchema / DisconnectResultSchema, copied
//      verbatim from design §3.6) parse a canonical bridge response, including
//      the actual_input != requested_input packing case;
//   2. the request-body SHAPES the new client methods must send (design §3.2 /
//      §3.5) — including null-coalescing the optional disconnect fields.
//
// Keeping these here (rather than importing the post-integration validators)
// gives the integrator a frozen contract to paste into validators.ts and a
// behavioral test that is GREEN IN ISOLATION today. The post-integration tool
// rewire tests are documented in _workspace/02_build_connect-endpoint.md for the
// integrator to add once connectHelper.ts / disconnectNodes.ts are wired.
// ---------------------------------------------------------------------------

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
// These mirror exactly the body the new touchDesignerClient methods build, so a
// builder-side test can assert the REST contract (§3.2) without editing the
// shared client. The integrator's client methods must produce these same bodies.
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
// connectNodesViaBridge — the integrator rewire (endpoint → batch → python)
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

  it("falls back to batch on TdApiError, then python when batch reports not-ok", async () => {
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
});
