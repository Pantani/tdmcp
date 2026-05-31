import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { TdConnectionError } from "../../src/td-client/types.js";
import {
  buildSopChainScript,
  buildSopGeometryImpl,
  buildSopGeometrySchema,
} from "../../src/tools/layer2/buildSopGeometry.js";
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

describe("buildSopGeometrySchema", () => {
  it("rejects an empty ops array", () => {
    const r = buildSopGeometrySchema.safeParse({ name: "rig", ops: [] });
    expect(r.success).toBe(false);
  });

  it("rejects a non-SOP operator type via the /SOP$/i refinement", () => {
    const r = buildSopGeometrySchema.safeParse({
      name: "rig",
      ops: [{ type: "mathCHOP" }],
    });
    expect(r.success).toBe(false);
  });

  it("accepts SOP types case-insensitively and defaults parent to /project1", () => {
    const r = buildSopGeometrySchema.parse({
      name: "rig",
      ops: [{ type: "boxSOP" }, { type: "noisesop" }],
    });
    expect(r.parent).toBe("/project1");
    expect(r.ops).toHaveLength(2);
  });
});

describe("buildSopChainScript", () => {
  it("round-trips parent, name, and ops as base64 JSON", () => {
    const script = buildSopChainScript({
      parent: "/project1",
      name: "rig",
      ops: [{ type: "boxSOP" }, { type: "noiseSOP", params: { amp: 0.2 } }],
    });
    const payload = decodePayload(script);
    expect(payload.parent).toBe("/project1");
    expect(payload.name).toBe("rig");
    expect(payload.ops[0]?.type).toBe("boxSOP");
    expect(payload.ops[1]?.params).toEqual({ amp: 0.2 });
  });

  it("uses sop-stem stripping (3 chars) in the script body", () => {
    const script = buildSopChainScript({ parent: "/project1", name: "x", ops: [] });
    expect(script).toContain('endswith("sop")');
    expect(script).toContain("_stem[:-3]");
    expect(script).toContain("getattr(td,");
    expect(script).toContain("inputConnectors[0].connect");
  });
});

describe("buildSopGeometryImpl", () => {
  it("happy path — 3-op chain returns created list and output_path", async () => {
    const exec = okExec({
      container: "/project1",
      created: [
        { name: "rig_0_box", path: "/project1/rig_0_box", type: "boxSOP" },
        { name: "rig_1_noise", path: "/project1/rig_1_noise", type: "noiseSOP" },
        { name: "rig_2_null", path: "/project1/rig_2_null", type: "nullSOP" },
      ],
      output_path: "/project1/rig_2_null",
      warnings: [],
    });
    const args = buildSopGeometrySchema.parse({
      name: "rig",
      ops: [{ type: "boxSOP" }, { type: "noiseSOP", params: { amp: 0.2 } }, { type: "nullSOP" }],
    });
    const result = await buildSopGeometryImpl(fakeCtx(exec), args);

    expect(exec).toHaveBeenCalledTimes(1);
    const payload = decodePayload(scriptArg(exec));
    expect(payload.parent).toBe("/project1");
    expect(payload.ops.map((o) => o.type)).toEqual(["boxSOP", "noiseSOP", "nullSOP"]);
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toContain('Built SOP geometry "rig" under /project1: 3/3 op(s) created');
    expect(textOf(result)).toContain("/project1/rig_2_null");
  });

  it("preserves explicit op name in the payload", async () => {
    const exec = okExec({
      container: "/project1",
      created: [{ name: "src", path: "/project1/src", type: "boxSOP" }],
      output_path: "/project1/src",
      warnings: [],
    });
    const args = buildSopGeometrySchema.parse({
      name: "s",
      ops: [{ type: "boxSOP", name: "src" }],
    });
    await buildSopGeometryImpl(fakeCtx(exec), args);
    const payload = decodePayload(scriptArg(exec));
    expect(payload.ops[0]?.name).toBe("src");
  });

  it("sibling-name reference reaches the script verbatim", async () => {
    const exec = okExec({
      container: "/project1",
      created: [
        { name: "src", path: "/project1/src", type: "boxSOP" },
        { name: "s_1_transform", path: "/project1/s_1_transform", type: "transformSOP" },
      ],
      output_path: "/project1/s_1_transform",
      warnings: [],
    });
    const args = buildSopGeometrySchema.parse({
      name: "s",
      ops: [
        { type: "boxSOP", name: "src" },
        { type: "transformSOP", params: { sop: "src" } },
      ],
    });
    const result = await buildSopGeometryImpl(fakeCtx(exec), args);
    const script = scriptArg(exec);
    expect(script).toContain("_name_to_path");
    expect(result.isError).not.toBe(true);
    const payload = decodePayload(script);
    expect(payload.ops[1]?.params).toEqual({ sop: "src" });
  });

  it("warning surfaces in the summary text", async () => {
    const exec = okExec({
      container: "/project1",
      created: [
        { name: "c_0_box", path: "/project1/c_0_box", type: "boxSOP" },
        { name: "c_2_null", path: "/project1/c_2_null", type: "nullSOP" },
      ],
      output_path: "/project1/c_2_null",
      warnings: ["create[1] fakeSOP failed: module 'td' has no attribute 'fakeSOP'"],
    });
    const args = buildSopGeometrySchema.parse({
      name: "c",
      ops: [{ type: "boxSOP" }, { type: "fakeSOP" }, { type: "nullSOP" }],
    });
    const result = await buildSopGeometryImpl(fakeCtx(exec), args);
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toContain("1 warning(s)");
  });

  it("TD offline → friendly isError result, not a throw", async () => {
    const exec = vi.fn(async () => {
      throw new TdConnectionError("bridge unreachable");
    });
    const args = buildSopGeometrySchema.parse({
      name: "x",
      ops: [{ type: "nullSOP" }],
    });
    const result = await buildSopGeometryImpl(fakeCtx(exec), args);
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
    const args = buildSopGeometrySchema.parse({
      parent: "/missing",
      name: "x",
      ops: [{ type: "nullSOP" }],
    });
    const result = await buildSopGeometryImpl(fakeCtx(exec), args);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Could not build SOP geometry");
    expect(textOf(result)).toContain("Parent not found");
  });
});
