import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildAutoMontageScript,
  createAutoMontageImpl,
  createAutoMontageSchema,
} from "../../src/tools/layer2/createAutoMontage.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  parent_path: string;
  name: string;
  folder: string;
  extensions: string[];
  max_clips: number;
  resolution: number[];
  mode: string;
  clock: string;
  bpm: number;
  division: number;
  interval_s: number;
  crossfade: number;
  autoplay: boolean;
  seed: number | null;
  engine_text: string;
  ramp_text: string;
  advance_text: string;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("no base64 payload found in script");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Payload;
}

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return {
    client: { executePythonScript: exec },
    logger: silentLogger,
  } as unknown as ToolContext;
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

function structured(result: CallToolResult): Record<string, unknown> {
  const text = textOf(result);
  const m = /```json\n([\s\S]*?)\n```/.exec(text);
  if (!m) throw new Error("no json fence in result text");
  return JSON.parse(m[1] as string) as Record<string, unknown>;
}

function happyReport(
  overrides: Partial<{
    container: string;
    output_path: string;
    state_chop: string;
    switch_path: string;
    clock_path: string;
    engine: string;
    ramp: string;
    advance: string;
    clips: string[];
    files: string[];
    files_found: number;
    files_scanned: number;
    warnings: string[];
  }> = {},
): string {
  return JSON.stringify({
    container: overrides.container ?? "/project1/auto_montage",
    output_path: overrides.output_path ?? "/project1/auto_montage/out1",
    state_chop: overrides.state_chop ?? "/project1/auto_montage/state_out",
    switch_path: overrides.switch_path ?? "/project1/auto_montage/switch",
    clock_path: overrides.clock_path ?? "/project1/auto_montage/clock",
    engine: overrides.engine ?? "/project1/auto_montage/engine",
    ramp: overrides.ramp ?? "/project1/auto_montage/ramp",
    advance: overrides.advance ?? "/project1/auto_montage/advance",
    clips: overrides.clips ?? [
      "/project1/auto_montage/clip1",
      "/project1/auto_montage/clip2",
      "/project1/auto_montage/clip3",
    ],
    files: overrides.files ?? ["/a/1.mov", "/a/2.mov", "/a/3.mov"],
    files_found: overrides.files_found ?? 3,
    files_scanned: overrides.files_scanned ?? 3,
    warnings: overrides.warnings ?? [],
  });
}

const defaultArgs = (over: Partial<ReturnType<typeof createAutoMontageSchema.parse>> = {}) =>
  createAutoMontageSchema.parse({ folder: "/clips", ...over });

// ---------------------------------------------------------------------------
// buildAutoMontageScript — pure
// ---------------------------------------------------------------------------

describe("buildAutoMontageScript (pure payload)", () => {
  it("embeds all schema fields in the base64 payload", () => {
    const script = buildAutoMontageScript(defaultArgs({ folder: "/clips" }), 16);
    const p = decodePayload(script);
    expect(p.folder).toBe("/clips");
    expect(p.extensions).toEqual(["mov", "mp4", "png", "jpg", "jpeg", "tif", "exr"]);
    expect(p.max_clips).toBe(16);
    expect(p.resolution).toEqual([1280, 720]);
    expect(p.mode).toBe("shuffle");
    expect(p.clock).toBe("bar");
    expect(p.bpm).toBe(120);
    expect(p.division).toBe(4);
    expect(p.crossfade).toBe(0.5);
    expect(p.autoplay).toBe(true);
    expect(p.seed).toBeNull();
  });

  it("embeds the engine/ramp/advance DAT text with sentinel keys", () => {
    const script = buildAutoMontageScript(defaultArgs({ folder: "/clips" }), 5);
    const p = decodePayload(script);
    expect(p.engine_text).toContain("tdmcp_bin");
    expect(p.engine_text).toContain("onValueChange");
    expect(p.engine_text).toContain("onPulse");
    expect(p.ramp_text).toContain("onFrameStart");
    expect(p.ramp_text).toContain("tdmcp_bin");
    expect(p.advance_text).toContain("_pick_next");
    expect(p.advance_text).toContain("tdmcp_bag");
    expect(p.advance_text).toContain("onOffToOn");
    expect(p.advance_text).toContain("COUNT = 5");
  });

  it("template references the KB-confirmed operator types", () => {
    const script = buildAutoMontageScript(defaultArgs({ folder: "/clips" }), 4);
    expect(script).toContain("baseCOMP");
    expect(script).toContain("moviefileinTOP");
    expect(script).toContain("switchTOP");
    expect(script).toContain("nullTOP");
    expect(script).toContain("nullCHOP");
    expect(script).toContain("beatCHOP");
    expect(script).toContain("lfoCHOP");
    expect(script).toContain("chopexecuteDAT");
    expect(script).toContain("parameterexecuteDAT");
    expect(script).toContain("executeDAT");
    expect(script).toContain("import os, json, base64");
    expect(script).toContain("print(json.dumps(report))");
  });

  it("does not leak the folder path into the template (only into the base64 blob)", () => {
    const tricky = "/UNIQUEMARKER_montage_xyz";
    const script = buildAutoMontageScript(defaultArgs({ folder: tricky }), 8);
    const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1] ?? "";
    expect(Buffer.from(b64, "base64").toString("utf8")).toContain(tricky);
    expect(script.replace(b64, "REDACTED")).not.toContain("UNIQUEMARKER_montage_xyz");
  });
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe("createAutoMontageSchema defaults", () => {
  it("applies documented defaults", () => {
    const p = createAutoMontageSchema.parse({ folder: "/x" });
    expect(p.name).toBe("auto_montage");
    expect(p.parent_path).toBe("/project1");
    expect(p.mode).toBe("shuffle");
    expect(p.clock).toBe("bar");
    expect(p.crossfade).toBe(0.5);
    expect(p.autoplay).toBe(true);
    expect(p.seed).toBeNull();
  });

  it("rejects invalid mode/clock/bpm/division", () => {
    expect(() => createAutoMontageSchema.parse({ folder: "/x", mode: "loop" })).toThrow();
    expect(() => createAutoMontageSchema.parse({ folder: "/x", clock: "sometimes" })).toThrow();
    expect(() => createAutoMontageSchema.parse({ folder: "/x", bpm: 5 })).toThrow();
    expect(() => createAutoMontageSchema.parse({ folder: "/x", division: 99 })).toThrow();
    expect(() => createAutoMontageSchema.parse({ folder: "/x", crossfade: -1 })).toThrow();
  });

  it("requires folder", () => {
    expect(() => createAutoMontageSchema.parse({})).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe("createAutoMontageImpl — happy path", () => {
  it("summary names the container + clip count + clock/mode", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    const result = await createAutoMontageImpl(fakeCtx(exec), defaultArgs({ folder: "/clips" }));
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/auto_montage");
    expect(text).toContain("3 clip(s)");
    expect(text).toContain("clock=bar");
    expect(text).toContain("mode=shuffle");
  });

  it("returns controls (8) and unverified notes in structured content", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    const result = await createAutoMontageImpl(fakeCtx(exec), defaultArgs({ folder: "/clips" }));
    const s = structured(result);
    const controls = s.controls as Array<{ name: string; type: string }>;
    expect(controls).toHaveLength(8);
    const names = controls.map((c) => c.name);
    expect(names).toEqual([
      "Play",
      "Index",
      "Next",
      "Prev",
      "Crossfade",
      "Bpm",
      "Division",
      "Seed",
    ]);
    expect(controls[0]?.type).toBe("toggle");
    const unverified = s.unverified as string[];
    expect(unverified.length).toBeGreaterThan(0);
  });

  it("clock=interval picks lfoCHOP path through (payload carries interval_s)", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({ clock_path: "/project1/auto_montage/clock" }),
    }));
    await createAutoMontageImpl(
      fakeCtx(exec),
      defaultArgs({ folder: "/clips", clock: "interval", interval_s: 2.5 }),
    );
    const p = decodePayload(scriptArg(exec));
    expect(p.clock).toBe("interval");
    expect(p.interval_s).toBe(2.5);
  });

  it("includes warning count in the summary", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({ warnings: ["Beat CHOP tempo binding fell back."] }),
    }));
    const result = await createAutoMontageImpl(fakeCtx(exec), defaultArgs({ folder: "/clips" }));
    expect(textOf(result)).toContain("1 warning(s)");
  });

  it("empty folder reports the empty-montage summary", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({ files_found: 0, files: [], clips: ["/project1/auto_montage/clip1"] }),
    }));
    const result = await createAutoMontageImpl(fakeCtx(exec), defaultArgs({ folder: "/missing" }));
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("empty auto-montage");
    expect(textOf(result)).toContain("/missing");
  });
});

// ---------------------------------------------------------------------------
// Fatal / offline
// ---------------------------------------------------------------------------

describe("createAutoMontageImpl — fatal", () => {
  it("returns isError when parent COMP is missing", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        container: "",
        output_path: "",
        state_chop: "",
        switch_path: "",
        clock_path: "",
        engine: "",
        ramp: "",
        advance: "",
        clips: [],
        files: [],
        files_found: 0,
        files_scanned: 0,
        warnings: [],
        fatal: "Parent COMP not found: /nope",
      }),
    }));
    const result = await createAutoMontageImpl(
      fakeCtx(exec),
      defaultArgs({ folder: "/x", parent_path: "/nope" }),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Parent COMP not found");
  });
});

describe("createAutoMontageImpl — TD offline", () => {
  it("returns isError when the bridge is unreachable, does not throw", async () => {
    const exec = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await createAutoMontageImpl(fakeCtx(exec), defaultArgs({ folder: "/x" }));
    expect(result.isError).toBe(true);
  });
});
