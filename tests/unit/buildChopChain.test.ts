import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { TdConnectionError } from "../../src/td-client/types.js";
import {
  buildChainScript,
  buildChopChainImpl,
  buildChopChainSchema,
} from "../../src/tools/layer2/buildChopChain.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  parent: string;
  name: string;
  ops: Array<{ type: string; name?: string; params?: Record<string, string | number> }>;
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

describe("buildChopChainSchema", () => {
  it("rejects an empty ops array", () => {
    const r = buildChopChainSchema.safeParse({ name: "chain", ops: [] });
    expect(r.success).toBe(false);
  });

  it("rejects a non-CHOP operator type via the /CHOP$/i refinement", () => {
    const r = buildChopChainSchema.safeParse({
      name: "chain",
      ops: [{ type: "constantTOP" }],
    });
    expect(r.success).toBe(false);
  });

  it("accepts CHOP types case-insensitively and defaults parent to /project1", () => {
    const r = buildChopChainSchema.parse({
      name: "chain",
      ops: [{ type: "mathCHOP" }, { type: "lagchop" }],
    });
    expect(r.parent).toBe("/project1");
    expect(r.ops).toHaveLength(2);
  });
});

describe("buildChainScript", () => {
  it("round-trips parent, name, and ops as base64 JSON", () => {
    const script = buildChainScript({
      parent: "/project1",
      name: "audio",
      ops: [{ type: "audiofileinCHOP" }, { type: "mathCHOP", params: { gain: 2 } }],
    });
    const payload = decodePayload(script);
    expect(payload.parent).toBe("/project1");
    expect(payload.name).toBe("audio");
    expect(payload.ops[0]?.type).toBe("audiofileinCHOP");
    expect(payload.ops[1]?.params).toEqual({ gain: 2 });
  });

  it("emits getattr(td, …) creation and input-0 wiring", () => {
    const script = buildChainScript({ parent: "/project1", name: "x", ops: [] });
    expect(script).toContain("getattr(td,");
    expect(script).toContain("inputConnectors[0].connect");
    expect(script).toContain("outputConnectors[0]");
  });
});

describe("buildChopChainImpl", () => {
  it("happy path — ordered build returns created list and output_path", async () => {
    const exec = okExec({
      container: "/project1",
      created: [
        {
          name: "audio_0_audiofilein",
          path: "/project1/audio_0_audiofilein",
          type: "audiofileinCHOP",
        },
        { name: "audio_1_math", path: "/project1/audio_1_math", type: "mathCHOP" },
        { name: "audio_2_lag", path: "/project1/audio_2_lag", type: "lagCHOP" },
        { name: "audio_3_null", path: "/project1/audio_3_null", type: "nullCHOP" },
      ],
      output_path: "/project1/audio_3_null",
      warnings: [],
    });
    const args = buildChopChainSchema.parse({
      parent: "/project1",
      name: "audio",
      ops: [
        { type: "audiofileinCHOP" },
        { type: "mathCHOP", params: { gain: 2 } },
        { type: "lagCHOP", params: { lag1: 0.1 } },
        { type: "nullCHOP" },
      ],
    });
    const result = await buildChopChainImpl(fakeCtx(exec), args);

    expect(exec).toHaveBeenCalledTimes(1);
    const payload = decodePayload(scriptArg(exec));
    expect(payload.ops.map((o) => o.type)).toEqual([
      "audiofileinCHOP",
      "mathCHOP",
      "lagCHOP",
      "nullCHOP",
    ]);
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toContain("/project1/audio_3_null");
  });

  it("per-op create failure is swallowed — chain continues with warnings", async () => {
    const exec = okExec({
      container: "/project1",
      created: [
        { name: "c_0_audiofilein", path: "/project1/c_0_audiofilein", type: "audiofileinCHOP" },
        { name: "c_2_null", path: "/project1/c_2_null", type: "nullCHOP" },
      ],
      output_path: "/project1/c_2_null",
      warnings: [
        "create[1] bogusCHOP failed: module 'td' has no attribute 'bogusCHOP'",
        "connect[1->2] failed: prev is None",
      ],
    });
    const args = buildChopChainSchema.parse({
      name: "c",
      ops: [{ type: "audiofileinCHOP" }, { type: "bogusCHOP" }, { type: "nullCHOP" }],
    });
    const result = await buildChopChainImpl(fakeCtx(exec), args);
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toContain("bogusCHOP failed");
  });

  it("param failure is swallowed and surfaces in warnings", async () => {
    const exec = okExec({
      container: "/project1",
      created: [{ name: "p_0_lag", path: "/project1/p_0_lag", type: "lagCHOP" }],
      output_path: "/project1/p_0_lag",
      warnings: ["param[0].lag1 failed: invalid float"],
    });
    const args = buildChopChainSchema.parse({
      name: "p",
      ops: [{ type: "lagCHOP", params: { lag1: "bad" } }],
    });
    const result = await buildChopChainImpl(fakeCtx(exec), args);
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toContain("lag1 failed");
  });

  it("sibling-name resolution is emitted in the script (name_to_path lookup)", async () => {
    const exec = okExec({
      container: "/project1",
      created: [
        { name: "src", path: "/project1/src", type: "noiseCHOP" },
        { name: "s_1_math", path: "/project1/s_1_math", type: "mathCHOP" },
      ],
      output_path: "/project1/s_1_math",
      warnings: [],
    });
    const args = buildChopChainSchema.parse({
      name: "s",
      ops: [
        { type: "noiseCHOP", name: "src" },
        { type: "mathCHOP", params: { chop: "src" } },
      ],
    });
    const result = await buildChopChainImpl(fakeCtx(exec), args);
    const script = scriptArg(exec);
    expect(script).toContain("_name_to_path");
    expect(result.isError).not.toBe(true);
    const payload = decodePayload(script);
    expect(payload.ops[1]?.params).toEqual({ chop: "src" });
  });

  it("TD offline → friendly isError result, not a throw", async () => {
    const exec = vi.fn(async () => {
      throw new TdConnectionError("bridge unreachable");
    });
    const args = buildChopChainSchema.parse({
      name: "x",
      ops: [{ type: "nullCHOP" }],
    });
    const result = await buildChopChainImpl(fakeCtx(exec), args);
    expect(result.isError).toBe(true);
  });

  it("fatal report → isError result with structured data", async () => {
    const exec = okExec({
      container: "/missing",
      created: [],
      output_path: null,
      warnings: [],
      fatal: "Parent not found: /missing",
    });
    const args = buildChopChainSchema.parse({
      parent: "/missing",
      name: "x",
      ops: [{ type: "nullCHOP" }],
    });
    const result = await buildChopChainImpl(fakeCtx(exec), args);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Parent not found");
  });
});
