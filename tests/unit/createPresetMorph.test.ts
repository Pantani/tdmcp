import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildPresetMorphScript,
  createPresetMorphImpl,
  createPresetMorphSchema,
  normalizeWeights,
} from "../../src/tools/layer2/createPresetMorph.js";
import { MORPH_HOOK } from "../../src/tools/layer2/manageCue.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  action: string;
  parent_path: string;
  name: string;
  target_path?: string;
  include?: string[];
  slot?: string;
  weights?: Record<string, number>;
  morph_seconds: number;
  quantize: string;
  interpolation: string;
  morph_text: string;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("no base64 payload found in script");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Payload;
}

type ExecMock = ReturnType<typeof vi.fn<(script: string, captureStdout?: boolean) => unknown>>;

function fakeCtx(exec: ExecMock): ToolContext {
  return {
    client: { executePythonScript: exec },
    logger: silentLogger,
  } as unknown as ToolContext;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

const reportMock = (over: Record<string, unknown>): ExecMock =>
  vi.fn(async (_script: string, _capture?: boolean) => ({
    stdout: JSON.stringify({
      action: "build",
      container: "/project1/preset_morph",
      target: "/raymarch1",
      warnings: [],
      ...over,
    }),
  }));

const DEFAULTS = {
  parent_path: "/project1",
  name: "preset_morph",
  morph_seconds: 0,
  quantize: "off" as const,
  interpolation: "linear" as const,
};

describe("buildPresetMorphScript", () => {
  it("embeds the topology operators + target + MORPH_HOOK in the payload/template", () => {
    const script = buildPresetMorphScript({
      action: "build",
      parent_path: "/project1",
      name: "preset_morph",
      target_path: "/raymarch1",
      morph_seconds: 0,
      quantize: "off",
      interpolation: "linear",
      morph_text: MORPH_HOOK,
    });
    // The Python template carries the topology op-types and the JSON payload carries target_path.
    for (const opType of [
      "td.baseCOMP",
      "td.tableDAT",
      "td.datToCHOP",
      "td.lagCHOP",
      "td.lookupCHOP",
      "td.scriptCHOP",
      "td.nullCHOP",
      "td.executeDAT",
    ]) {
      expect(script).toContain(opType);
    }
    const payload = decodePayload(script);
    expect(payload.target_path).toBe("/raymarch1");
    expect(payload.morph_text).toBe(MORPH_HOOK);
  });
});

describe("normalizeWeights", () => {
  it("clips negatives and normalizes to sum 1", () => {
    const out = normalizeWeights({ a: 0.5, b: 0.5, c: -1 });
    expect(out.c).toBe(0);
    expect((out.a ?? 0) + (out.b ?? 0)).toBeCloseTo(1, 6);
    expect(out.a).toBeCloseTo(0.5, 6);
    expect(out.b).toBeCloseTo(0.5, 6);
  });

  it("leaves an all-zero vector at zero (no division by zero)", () => {
    const out = normalizeWeights({ a: 0, b: -2 });
    expect(out.a).toBe(0);
    expect(out.b).toBe(0);
  });
});

describe("createPresetMorphImpl — schema", () => {
  it("applies defaults", () => {
    const parsed = createPresetMorphSchema.parse({});
    expect(parsed.action).toBe("build");
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.name).toBe("preset_morph");
    expect(parsed.morph_seconds).toBe(0);
    expect(parsed.quantize).toBe("off");
    expect(parsed.interpolation).toBe("linear");
  });
});

describe("createPresetMorphImpl — build", () => {
  it("calls executePythonScript with the target_path in the payload and returns structured content", async () => {
    const exec = reportMock({ action: "build", slots: [], interpolation: "linear" });
    const result = await createPresetMorphImpl(fakeCtx(exec), {
      ...DEFAULTS,
      action: "build",
      target_path: "/raymarch1",
    });
    expect(result.isError).toBeFalsy();
    expect(exec).toHaveBeenCalledTimes(1);
    const script = exec.mock.calls[0]?.[0];
    if (typeof script !== "string") throw new Error("no script");
    const payload = decodePayload(script);
    expect(payload.target_path).toBe("/raymarch1");
    expect(textOf(result)).toContain("Built preset morph");
  });

  it("rejects build without target_path before touching the bridge", async () => {
    const exec = vi.fn();
    const result = await createPresetMorphImpl(fakeCtx(exec), { ...DEFAULTS, action: "build" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("target_path");
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("createPresetMorphImpl — store", () => {
  it("forwards slot, target_path, and include filter", async () => {
    const exec = reportMock({
      action: "store",
      slot: "dawn",
      target: "/raymarch1",
      captured: ["Speed", "Hue"],
      skipped: [],
      slots: ["dawn"],
    });
    const result = await createPresetMorphImpl(fakeCtx(exec), {
      ...DEFAULTS,
      action: "store",
      target_path: "/raymarch1",
      slot: "dawn",
      include: ["Speed", "Hue"],
    });
    expect(result.isError).toBeFalsy();
    const script = exec.mock.calls[0]?.[0];
    if (typeof script !== "string") throw new Error("no script");
    const payload = decodePayload(script);
    expect(payload.slot).toBe("dawn");
    expect(payload.target_path).toBe("/raymarch1");
    expect(payload.include).toEqual(["Speed", "Hue"]);
    expect(textOf(result)).toContain('Stored preset "dawn"');
  });

  it("store without slot returns isError and never calls the bridge", async () => {
    const exec = vi.fn();
    const result = await createPresetMorphImpl(fakeCtx(exec), {
      ...DEFAULTS,
      action: "store",
      target_path: "/raymarch1",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("slot");
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("createPresetMorphImpl — set_weights", () => {
  it("clips negatives + normalizes client-side before sending", async () => {
    const exec = reportMock({
      action: "set_weights",
      weights: { a: 0.5, b: 0.5, c: 0 },
      slots: ["a", "b", "c"],
    });
    await createPresetMorphImpl(fakeCtx(exec), {
      ...DEFAULTS,
      action: "set_weights",
      weights: { a: 0.5, b: 0.5, c: -1 },
    });
    const script = exec.mock.calls[0]?.[0];
    if (typeof script !== "string") throw new Error("no script");
    const payload = decodePayload(script);
    expect(payload.weights).toBeDefined();
    const w = payload.weights as Record<string, number>;
    expect(w.c).toBe(0);
    expect((w.a ?? 0) + (w.b ?? 0)).toBeCloseTo(1, 6);
  });
});

describe("createPresetMorphImpl — recall", () => {
  it("forwards morph_seconds and quantize; payload carries MORPH_HOOK", async () => {
    const exec = reportMock({
      action: "recall",
      slot: "dawn",
      restored: ["Speed"],
      morph_seconds: 1.0,
      quantize: "beat",
      scheduled_in: 0.42,
    });
    const result = await createPresetMorphImpl(fakeCtx(exec), {
      ...DEFAULTS,
      action: "recall",
      slot: "dawn",
      morph_seconds: 1.0,
      quantize: "beat",
    });
    expect(result.isError).toBeFalsy();
    const script = exec.mock.calls[0]?.[0];
    if (typeof script !== "string") throw new Error("no script");
    const payload = decodePayload(script);
    expect(payload.morph_seconds).toBe(1.0);
    expect(payload.quantize).toBe("beat");
    expect(payload.morph_text).toBe(MORPH_HOOK);
    const text = textOf(result);
    expect(text).toContain('"dawn"');
    expect(text).toContain("next beat");
  });
});

describe("createPresetMorphImpl — TD-down friendly error", () => {
  it("surfaces a friendly error when the bridge throws and returns isError", async () => {
    const exec: ExecMock = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:9980");
    });
    const result = await createPresetMorphImpl(fakeCtx(exec), {
      ...DEFAULTS,
      action: "build",
      target_path: "/raymarch1",
    });
    expect(result.isError).toBe(true);
  });
});
