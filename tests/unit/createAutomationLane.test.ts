import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildAutomationLaneScript,
  createAutomationLaneImpl,
  createAutomationLaneSchema,
} from "../../src/tools/layer1/createAutomationLane.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  name: string;
  parent: string;
  target: string;
  bars: number;
  bpm: number;
  mode: string;
  samples: number;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return { client: { executePythonScript: exec }, logger: silentLogger } as unknown as ToolContext;
}

function scriptArg(exec: ReturnType<typeof vi.fn>): string {
  const script = exec.mock.calls[0]?.[0];
  if (typeof script !== "string")
    throw new Error("executePythonScript was not called with a script");
  return script;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

const okReport = (over: Record<string, unknown> = {}) =>
  vi.fn(async () => ({
    stdout: JSON.stringify({
      container: "/project1/auto_lane_filter",
      mode: "record",
      samples: 256,
      target: "/project1/filter1:cutoff",
      warnings: [],
      exists: false,
      ...over,
    }),
  }));

// ─── schema defaults ──────────────────────────────────────────────────────────

describe("createAutomationLaneSchema", () => {
  it("defaults mode=record, bars=4, bpm=120", () => {
    const parsed = createAutomationLaneSchema.parse({
      name: "lane1",
      targetParam: "/project1/filter1:cutoff",
    });
    expect(parsed.mode).toBe("record");
    expect(parsed.bars).toBe(4);
    expect(parsed.bpm).toBe(120);
  });

  it("rejects bars=3 (not in union)", () => {
    expect(() =>
      createAutomationLaneSchema.parse({
        name: "lane1",
        targetParam: "/project1/filter1:cutoff",
        bars: 3,
      }),
    ).toThrow();
  });
});

// ─── buildAutomationLaneScript ────────────────────────────────────────────────

describe("buildAutomationLaneScript", () => {
  it("embeds Beat, Lookup, Table, Script in the payload script", () => {
    const script = buildAutomationLaneScript({
      name: "auto_lane_filter",
      parent: "/project1",
      target: "/project1/filter1:cutoff",
      bars: 4,
      bpm: 120,
      mode: "record",
      samples: 256,
    });
    expect(script).toContain("beatCHOP");
    expect(script).not.toContain("tempoCHOP");
    expect(script).toContain("rampbar");
    expect(script).toContain("bpm");
    expect(script).toContain("lookupCHOP");
    expect(script).toContain("tableDAT");
    expect(script).toContain("scriptCHOP");
    expect(script).toContain("buffer_dat");
  });

  it("embeds samples=256 for bars=4 in the payload", () => {
    const script = buildAutomationLaneScript({
      name: "lane",
      parent: "/",
      target: "/project1/op1:par1",
      bars: 4,
      bpm: 120,
      mode: "record",
      samples: 256,
    });
    const payload = decodePayload(script);
    expect(payload.samples).toBe(256);
  });
});

// ─── createAutomationLaneImpl ─────────────────────────────────────────────────

describe("createAutomationLaneImpl", () => {
  it("sends the correct target path in the payload", async () => {
    const exec = okReport();
    await createAutomationLaneImpl(fakeCtx(exec), {
      name: "auto_lane_filter",
      parent: "/project1",
      targetParam: "/project1/filter1:cutoff",
      bars: 4,
      bpm: 120,
      mode: "record",
    });
    const payload = decodePayload(scriptArg(exec));
    expect(payload.target).toBe("/project1/filter1:cutoff");
  });

  it("record mode — payload includes bindExpr='' and bindMode=0", async () => {
    const exec = okReport({ mode: "record" });
    await createAutomationLaneImpl(fakeCtx(exec), {
      name: "auto_lane_filter",
      parent: "/project1",
      targetParam: "/project1/filter1:cutoff",
      bars: 4,
      bpm: 120,
      mode: "record",
    });
    const script = scriptArg(exec);
    expect(script).toContain('bindExpr = ""');
    expect(script).toContain("bindMode = 0");
  });

  it("loop mode — payload includes bindExpr referencing null_out and bindMode=1", async () => {
    const exec = okReport({ mode: "loop" });
    await createAutomationLaneImpl(fakeCtx(exec), {
      name: "auto_lane_filter",
      parent: "/project1",
      targetParam: "/project1/filter1:cutoff",
      bars: 4,
      bpm: 120,
      mode: "loop",
    });
    const script = scriptArg(exec);
    expect(script).toContain("null_out");
    expect(script).toContain("bindExpr");
    expect(script).toContain("bindMode = 1");
  });

  it("re-entrant flip: when bridge returns exists=true, script still present (mode flip only)", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        container: "/project1/auto_lane_filter",
        mode: "loop",
        samples: 256,
        target: "/project1/filter1:cutoff",
        warnings: [],
        exists: true,
      }),
    }));
    const result = await createAutomationLaneImpl(fakeCtx(exec), {
      name: "auto_lane_filter",
      parent: "/project1",
      targetParam: "/project1/filter1:cutoff",
      bars: 4,
      bpm: 120,
      mode: "loop",
    });
    expect(result.isError).toBeFalsy();
    // The script still runs; the bridge decides whether to rebuild based on _exists
    const script = scriptArg(exec);
    expect(script).toContain("_exists");
  });

  it("targetParam without colon returns friendly error without calling TD", async () => {
    const exec = vi.fn();
    const result = await createAutomationLaneImpl(fakeCtx(exec), {
      name: "lane1",
      parent: "/project1",
      targetParam: "/project1/filter1",
      bars: 4,
      bpm: 120,
      mode: "record",
    });
    expect(result.isError).toBe(true);
    expect(exec).not.toHaveBeenCalled();
    const text = textOf(result);
    expect(text).toContain("targetParam");
  });

  it("summarizes container and mode from the TD report", async () => {
    const exec = okReport({ mode: "loop", samples: 128 });
    const result = await createAutomationLaneImpl(fakeCtx(exec), {
      name: "auto_lane_filter",
      parent: "/project1",
      targetParam: "/project1/filter1:cutoff",
      bars: 2,
      bpm: 120,
      mode: "loop",
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/auto_lane_filter");
    expect(text).toContain("loop");
  });

  it("propagates warnings from the bridge without isError", async () => {
    const exec = okReport({ warnings: ["Target par not found: badpar"] });
    const result = await createAutomationLaneImpl(fakeCtx(exec), {
      name: "lane_warn",
      parent: "/project1",
      targetParam: "/project1/filter1:badpar",
      bars: 4,
      bpm: 120,
      mode: "record",
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("warning");
  });
});
