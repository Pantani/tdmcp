import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { TdConnectionError } from "../../src/td-client/types.js";
import {
  buildPopChainImpl,
  buildPopChainSchema,
  buildPopChainScript,
  POP_KIND_DEFAULTS,
  POP_KINDS,
} from "../../src/tools/layer2/buildPopChain.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Payload {
  parent: string;
  name: string;
  chain: Array<{
    type: string;
    name?: string;
    params?: Record<string, string | number | boolean>;
    extra_inputs?: string[];
  }>;
  defaults_map: Record<
    string,
    { optype: string; defaults: Record<string, string | number | boolean> }
  >;
  unverified_note: string;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("no base64 payload in script");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return { client: { executePythonScript: exec }, logger: silentLogger } as unknown as ToolContext;
}

function scriptArg(exec: ReturnType<typeof vi.fn>): string {
  const s = exec.mock.calls[0]?.[0];
  if (typeof s !== "string") throw new Error("executePythonScript not called with a string");
  return s;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

const okExec = (report: Record<string, unknown>) =>
  vi.fn(async (_script: string, _capture?: boolean) => ({
    stdout: JSON.stringify(report),
  }));

// ---------------------------------------------------------------------------
// Schema tests
// ---------------------------------------------------------------------------

describe("buildPopChainSchema", () => {
  it("rejects an empty chain array", () => {
    const r = buildPopChainSchema.safeParse({ name: "c", chain: [] });
    expect(r.success).toBe(false);
  });

  it("rejects a non-chainable POP kind (cplusplus_pop excluded from enum)", () => {
    const r = buildPopChainSchema.safeParse({
      name: "c",
      chain: [{ type: "cplusplus_pop" }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects a non-POP type (mathCHOP)", () => {
    const r = buildPopChainSchema.safeParse({
      name: "c",
      chain: [{ type: "mathCHOP" }],
    });
    expect(r.success).toBe(false);
  });

  it("accepts a 3-kind chain and defaults parent to /project1", () => {
    const r = buildPopChainSchema.parse({
      name: "c",
      chain: [{ type: "point_generator_pop" }, { type: "noise_pop" }, { type: "null_pop" }],
    });
    expect(r.parent).toBe("/project1");
    expect(r.chain).toHaveLength(3);
  });

  it("accepts a single-node chain", () => {
    const r = buildPopChainSchema.safeParse({ name: "c", chain: [{ type: "null_pop" }] });
    expect(r.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Script / payload encoding tests
// ---------------------------------------------------------------------------

describe("buildPopChainScript", () => {
  it("round-trips parent, name, chain, and defaults_map as base64 JSON", () => {
    const script = buildPopChainScript({
      parent: "/project1",
      name: "flock",
      chain: [{ type: "noise_pop", params: { amp: 0.7 } }],
      defaults_map: { noise_pop: POP_KIND_DEFAULTS.noise_pop },
      unverified_note: "test",
    });
    const payload = decodePayload(script);
    expect(payload.parent).toBe("/project1");
    expect(payload.name).toBe("flock");
    expect(payload.chain[0]?.type).toBe("noise_pop");
    expect(payload.defaults_map.noise_pop?.defaults.amp).toBe(0.3);
  });

  it("emits getattr(td, …) creation, input-0 wiring, and extra_inputs wiring", () => {
    const script = buildPopChainScript({
      parent: "/project1",
      name: "x",
      chain: [],
      defaults_map: {},
      unverified_note: "test",
    });
    expect(script).toContain("getattr(td,");
    expect(script).toContain("inputConnectors[0].connect");
    expect(script).toContain("inputConnectors[_j + 1].connect");
    expect(script).toContain("outputConnectors[0]");
  });

  it("emits the kind-defaults overlay before the user params loop", () => {
    const script = buildPopChainScript({
      parent: "/project1",
      name: "x",
      chain: [],
      defaults_map: {},
      unverified_note: "test",
    });
    const defaultsIdx = script.indexOf('_kd["defaults"]');
    const paramsIdx = script.indexOf('_spec.get("params")');
    expect(defaultsIdx).toBeGreaterThan(-1);
    expect(paramsIdx).toBeGreaterThan(-1);
    expect(defaultsIdx).toBeLessThan(paramsIdx);
  });
});

// ---------------------------------------------------------------------------
// POP_KINDS sanity
// ---------------------------------------------------------------------------

describe("POP_KINDS", () => {
  it("exports exactly 77 curated POP kinds", () => {
    expect(POP_KINDS).toHaveLength(77);
  });

  it("includes null_pop as the chain terminator", () => {
    expect(POP_KINDS).toContain("null_pop");
  });

  it("POP_KIND_DEFAULTS has an entry for every kind in POP_KINDS", () => {
    for (const kind of POP_KINDS) {
      expect(POP_KIND_DEFAULTS[kind]).toBeDefined();
    }
  });

  it("noise_pop default amp is 0.3", () => {
    expect(POP_KIND_DEFAULTS.noise_pop?.defaults.amp).toBe(0.3);
  });
});

// ---------------------------------------------------------------------------
// Impl tests
// ---------------------------------------------------------------------------

describe("buildPopChainImpl", () => {
  it("happy path 3-kind chain → created list, connections, output_path, no warnings", async () => {
    const exec = okExec({
      container: "/project1",
      created: [
        {
          name: "sim_0_pointgenerator",
          path: "/project1/sim_0_pointgenerator",
          type: "pointgeneratorPOP",
        },
        { name: "sim_1_noise", path: "/project1/sim_1_noise", type: "noisePOP" },
        { name: "sim_2_field", path: "/project1/sim_2_field", type: "fieldPOP" },
      ],
      connections: [
        {
          from: "/project1/sim_0_pointgenerator",
          to: "/project1/sim_1_noise",
          fromOut: 0,
          toIn: 0,
        },
        { from: "/project1/sim_1_noise", to: "/project1/sim_2_field", fromOut: 0, toIn: 0 },
      ],
      output_path: "/project1/sim_2_field",
      warnings: [],
      unverified: "POPs are Experimental",
    });
    const args = buildPopChainSchema.parse({
      parent: "/project1",
      name: "sim",
      chain: [{ type: "point_generator_pop" }, { type: "noise_pop" }, { type: "field_pop" }],
    });
    const result = await buildPopChainImpl(fakeCtx(exec), args);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(result.isError).not.toBe(true);
    const text = textOf(result);
    expect(text).toContain("/project1/sim_2_field");
  });

  it("default application: user supplies no params, defaults_map in payload contains them", async () => {
    const exec = okExec({
      container: "/project1",
      created: [{ name: "c_0_noise", path: "/project1/c_0_noise", type: "noisePOP" }],
      connections: [],
      output_path: "/project1/c_0_noise",
      warnings: [],
      unverified: "POPs are Experimental",
    });
    const args = buildPopChainSchema.parse({
      name: "c",
      chain: [{ type: "noise_pop" }],
    });
    await buildPopChainImpl(fakeCtx(exec), args);
    const payload = decodePayload(scriptArg(exec));
    expect(payload.defaults_map.noise_pop?.defaults.amp).toBe(0.3);
    expect(payload.defaults_map.noise_pop?.defaults.period).toBe(1.0);
  });

  it("user params overlay defaults: user amp=0.7 encoded in chain params, default amp=0.3 still in defaults_map", async () => {
    const exec = okExec({
      container: "/project1",
      created: [{ name: "c_0_noise", path: "/project1/c_0_noise", type: "noisePOP" }],
      connections: [],
      output_path: "/project1/c_0_noise",
      warnings: [],
      unverified: "POPs are Experimental",
    });
    const args = buildPopChainSchema.parse({
      name: "c",
      chain: [{ type: "noise_pop", params: { amp: 0.7 } }],
    });
    await buildPopChainImpl(fakeCtx(exec), args);
    const payload = decodePayload(scriptArg(exec));
    // Default map ships intact (Python does the overlay)
    expect(payload.defaults_map.noise_pop?.defaults.amp).toBe(0.3);
    // User value is in the chain entry
    expect(payload.chain[0]?.params?.amp).toBe(0.7);
  });

  it("unknown par name → warning, not isError", async () => {
    const exec = okExec({
      container: "/project1",
      created: [{ name: "c_0_noise", path: "/project1/c_0_noise", type: "noisePOP" }],
      connections: [],
      output_path: "/project1/c_0_noise",
      warnings: ["param[0].bogus failed: 'NoneType' object has no attribute 'val'"],
      unverified: "POPs are Experimental",
    });
    const args = buildPopChainSchema.parse({
      name: "c",
      chain: [{ type: "noise_pop", params: { bogus: 42 } }],
    });
    const result = await buildPopChainImpl(fakeCtx(exec), args);
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toContain("bogus failed");
  });

  it("single-node chain (no connections) returns output_path === created[0]", async () => {
    const exec = okExec({
      container: "/project1",
      created: [{ name: "c_0_null", path: "/project1/c_0_null", type: "nullPOP" }],
      connections: [],
      output_path: "/project1/c_0_null",
      warnings: [],
      unverified: "POPs are Experimental",
    });
    const args = buildPopChainSchema.parse({
      name: "c",
      chain: [{ type: "null_pop" }],
    });
    const result = await buildPopChainImpl(fakeCtx(exec), args);
    expect(result.isError).not.toBe(true);
    const text = textOf(result);
    expect(text).toContain("/project1/c_0_null");
  });

  it("extra_inputs encoded in payload; missing path surfaced as warning not isError", async () => {
    const exec = okExec({
      container: "/project1",
      created: [
        {
          name: "p_0_pointgenerator",
          path: "/project1/p_0_pointgenerator",
          type: "pointgeneratorPOP",
        },
        { name: "p_1_merge", path: "/project1/p_1_merge", type: "mergePOP" },
      ],
      connections: [
        { from: "/project1/p_0_pointgenerator", to: "/project1/p_1_merge", fromOut: 0, toIn: 0 },
      ],
      output_path: "/project1/p_1_merge",
      warnings: ["extra[1.1] /project1/missingSrc failed: op() returned None"],
      unverified: "POPs are Experimental",
    });
    const args = buildPopChainSchema.parse({
      name: "p",
      chain: [
        { type: "point_generator_pop" },
        { type: "merge_pop", extra_inputs: ["/project1/missingSrc"] },
      ],
    });
    const result = await buildPopChainImpl(fakeCtx(exec), args);
    expect(result.isError).not.toBe(true);
    const payload = decodePayload(scriptArg(exec));
    expect(payload.chain[1]?.extra_inputs).toEqual(["/project1/missingSrc"]);
    expect(textOf(result)).toContain("extra[1.1]");
  });

  it("sibling-name resolution: TS encodes params untouched (Python pass does the rewrite)", async () => {
    const exec = okExec({
      container: "/project1",
      created: [
        { name: "src", path: "/project1/src", type: "pointgeneratorPOP" },
        { name: "s_1_feedback", path: "/project1/s_1_feedback", type: "feedbackPOP" },
      ],
      connections: [{ from: "/project1/src", to: "/project1/s_1_feedback", fromOut: 0, toIn: 0 }],
      output_path: "/project1/s_1_feedback",
      warnings: [],
      unverified: "POPs are Experimental",
    });
    const args = buildPopChainSchema.parse({
      name: "s",
      chain: [
        { type: "point_generator_pop", name: "src" },
        { type: "feedback_pop", params: { pop: "src" } },
      ],
    });
    await buildPopChainImpl(fakeCtx(exec), args);
    const payload = decodePayload(scriptArg(exec));
    // TS ships the raw name; Python resolves it via _name_to_path
    expect(payload.chain[1]?.params?.pop).toBe("src");
  });

  it("TD offline → friendly isError result, not a throw", async () => {
    const exec = vi.fn(async () => {
      throw new TdConnectionError("bridge unreachable");
    });
    const args = buildPopChainSchema.parse({
      name: "x",
      chain: [{ type: "null_pop" }],
    });
    const result = await buildPopChainImpl(fakeCtx(exec), args);
    expect(result.isError).toBe(true);
  });

  it("fatal 'parent not found' → isError with structured data", async () => {
    const exec = okExec({
      container: "/missing",
      created: [],
      connections: [],
      output_path: null,
      warnings: [],
      unverified: "POPs are Experimental",
      fatal: "Parent not found: /missing",
    });
    const args = buildPopChainSchema.parse({
      parent: "/missing",
      name: "x",
      chain: [{ type: "null_pop" }],
    });
    const result = await buildPopChainImpl(fakeCtx(exec), args);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Parent not found");
  });
});
