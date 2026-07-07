import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  addTimecodeOverlayImpl,
  addTimecodeOverlaySchema,
  buildTimecodeOverlayScript,
} from "../../src/tools/layer2/addTimecodeOverlay.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Payload {
  parent_path: string;
  name: string;
  source_top: string;
  mode: "clock" | "count_up" | "count_down";
  target_seconds: number;
  font_size: number;
  color_rgb: [number, number, number];
  alignx: string;
  aligny: string;
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

/** A representative success report the Python pass would emit. */
function happyReport(
  overrides: Partial<{
    mode: string;
    fps: number;
    fps_source: string;
    output_top: string;
    warnings: string[];
  }> = {},
) {
  return JSON.stringify({
    container: "/project1/timecode_overlay",
    output_top: overrides.output_top ?? "/project1/timecode_overlay/out",
    source_select: "/project1/timecode_overlay/sel",
    text_top: "/project1/timecode_overlay/tc",
    mode: overrides.mode ?? "count_up",
    fps: overrides.fps ?? 60,
    fps_source: overrides.fps_source ?? "me.time.rate",
    warnings: overrides.warnings ?? [],
  });
}

const DEFAULT_ARGS = {
  parent_path: "/project1",
  name: "timecode_overlay",
  source_top: "/project1/moviefilein1",
  mode: "count_up" as const,
  target_seconds: 60,
  font_size: 48,
  color: "#ffffff",
  position: "bottom_left" as const,
};

// ---------------------------------------------------------------------------
// buildTimecodeOverlayScript — pure, no TD needed
// ---------------------------------------------------------------------------

describe("buildTimecodeOverlayScript (pure payload)", () => {
  it("embeds all schema fields in the base64 payload", () => {
    const script = buildTimecodeOverlayScript({
      parent_path: "/project1",
      name: "timecode_overlay",
      source_top: "/project1/moviefilein1",
      mode: "count_up",
      target_seconds: 60,
      font_size: 48,
      color_rgb: [1, 1, 1],
      alignx: "left",
      aligny: "bottom",
    });
    const payload = decodePayload(script);
    expect(payload.parent_path).toBe("/project1");
    expect(payload.name).toBe("timecode_overlay");
    expect(payload.source_top).toBe("/project1/moviefilein1");
    expect(payload.mode).toBe("count_up");
    expect(payload.target_seconds).toBe(60);
    expect(payload.font_size).toBe(48);
    expect(payload.color_rgb).toEqual([1, 1, 1]);
    expect(payload.alignx).toBe("left");
    expect(payload.aligny).toBe("bottom");
  });

  it("uses only base64 for the payload — no raw source_top literal in the script outside the blob", () => {
    const tricky = "/project1/UNIQUEMARKER_xyzzy";
    const script = buildTimecodeOverlayScript({
      parent_path: "/project1",
      name: "tm",
      source_top: tricky,
      mode: "count_up",
      target_seconds: 60,
      font_size: 48,
      color_rgb: [1, 1, 1],
      alignx: "left",
      aligny: "bottom",
    });
    const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1] ?? "";
    expect(b64.length).toBeGreaterThan(0);
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    expect(decoded).toContain(tricky);
    const templateWithoutBlob = script.replace(b64, "REDACTED");
    expect(templateWithoutBlob).not.toContain("UNIQUEMARKER_xyzzy");
  });

  it("script imports json/base64, prints json.dumps(report), and builds the expected topology", () => {
    const script = buildTimecodeOverlayScript({
      parent_path: "/project1",
      name: "tm",
      source_top: "/project1/in1",
      mode: "count_down",
      target_seconds: 30,
      font_size: 48,
      color_rgb: [1, 0, 0],
      alignx: "center",
      aligny: "top",
    });
    expect(script).toContain("import json, base64");
    expect(script).toContain("print(json.dumps(report))");
    expect(script).toContain("selectTOP");
    expect(script).toContain("textDAT");
    expect(script).toContain("textTOP");
    expect(script).toContain("compositeTOP");
    expect(script).toContain("nullTOP");
    expect(script).toContain("mod('fmt').tc(");
    expect(script).toContain("me.time.rate");
    expect(script).toContain("project.cookRate");
  });
});

// ---------------------------------------------------------------------------
// Schema defaults
// ---------------------------------------------------------------------------

describe("addTimecodeOverlaySchema defaults", () => {
  it("applies all documented defaults", () => {
    const parsed = addTimecodeOverlaySchema.parse({ source_top: "/project1/in1" });
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.name).toBe("timecode_overlay");
    expect(parsed.mode).toBe("count_up");
    expect(parsed.target_seconds).toBe(60);
    expect(parsed.font_size).toBe(48);
    expect(parsed.color).toBe("#ffffff");
    expect(parsed.position).toBe("bottom_left");
  });

  it("coerces numeric strings for target_seconds and font_size", () => {
    const parsed = addTimecodeOverlaySchema.parse({
      source_top: "/s",
      target_seconds: "90",
      font_size: "64",
    });
    expect(parsed.target_seconds).toBe(90);
    expect(parsed.font_size).toBe(64);
  });

  it("rejects a negative target_seconds", () => {
    expect(() =>
      addTimecodeOverlaySchema.parse({ source_top: "/s", target_seconds: -1 }),
    ).toThrow();
  });

  it("rejects a non-positive font_size", () => {
    expect(() => addTimecodeOverlaySchema.parse({ source_top: "/s", font_size: 0 })).toThrow();
  });

  it("rejects an invalid mode", () => {
    expect(() => addTimecodeOverlaySchema.parse({ source_top: "/s", mode: "stopwatch" })).toThrow();
  });

  it("rejects an invalid position", () => {
    expect(() =>
      addTimecodeOverlaySchema.parse({ source_top: "/s", position: "middle" }),
    ).toThrow();
  });

  it("requires source_top", () => {
    expect(() => addTimecodeOverlaySchema.parse({})).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Happy path — impl integration
// ---------------------------------------------------------------------------

describe("addTimecodeOverlayImpl — happy path", () => {
  it("returns a non-error result with a summary line (count_up)", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    const result = await addTimecodeOverlayImpl(fakeCtx(exec), DEFAULT_ARGS);
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("count_up timecode overlay");
    expect(text).toContain("/project1/moviefilein1");
    expect(text).toContain("/project1/timecode_overlay/out");
    expect(text).toContain("ticks live over the source");
  });

  it("sends the correct payload (source_top, mode, target_seconds, position)", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport({ mode: "count_down" }) }));
    await addTimecodeOverlayImpl(fakeCtx(exec), {
      ...DEFAULT_ARGS,
      mode: "count_down",
      target_seconds: 45,
      position: "top_right",
    });
    const payload = decodePayload(scriptArg(exec));
    expect(payload.source_top).toBe("/project1/moviefilein1");
    expect(payload.mode).toBe("count_down");
    expect(payload.target_seconds).toBe(45);
    expect(payload.alignx).toBe("right");
    expect(payload.aligny).toBe("top");
  });

  it("notes show-time-since-project-start (not OS wall clock) for clock mode", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport({ mode: "clock" }) }));
    const result = await addTimecodeOverlayImpl(fakeCtx(exec), { ...DEFAULT_ARGS, mode: "clock" });
    const text = textOf(result);
    expect(text).toContain("show-time-since-project-start");
    expect(text).toContain("not the OS wall clock");
  });

  it("includes a warning count in the summary when warnings are present", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({
        warnings: ["Could not probe me.time.rate or project.cookRate; using 60 fps fallback."],
        fps_source: "fallback(60)",
      }),
    }));
    const result = await addTimecodeOverlayImpl(fakeCtx(exec), DEFAULT_ARGS);
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("1 warning(s)");
    expect(text).toContain("fallback(60)");
  });
});

// ---------------------------------------------------------------------------
// Fatal — source not found
// ---------------------------------------------------------------------------

describe("addTimecodeOverlayImpl — fatal (source not found)", () => {
  it("returns isError:true and does not throw", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        container: "",
        output_top: "",
        source_select: "",
        text_top: "",
        mode: "count_up",
        fps: 0,
        fps_source: "",
        warnings: [],
        fatal: "Source TOP not found: /project1/missing",
      }),
    }));
    const result = await addTimecodeOverlayImpl(fakeCtx(exec), {
      ...DEFAULT_ARGS,
      source_top: "/project1/missing",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Source TOP not found");
  });
});

// ---------------------------------------------------------------------------
// TD offline — guardTd swallows the connection error
// ---------------------------------------------------------------------------

describe("addTimecodeOverlayImpl — TD offline", () => {
  it("returns isError:true and does not throw when the bridge is unreachable", async () => {
    const exec = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await addTimecodeOverlayImpl(fakeCtx(exec), DEFAULT_ARGS);
    expect(result.isError).toBe(true);
  });
});
