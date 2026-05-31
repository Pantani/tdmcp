import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildVectorLinesScript,
  createVectorLinesImpl,
  createVectorLinesSchema,
} from "../../src/tools/layer2/createVectorLines.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Payload {
  parent_path: string;
  name: string;
  source_top: string;
  style: "contour" | "trace" | "plotter";
  threshold: number;
  line_width: number;
  line_color: number[];
  bg_color: number[];
  animate: boolean;
  resolution: number[];
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
    style: string;
    output_top: string;
    edge_par_used: string;
    trace_optype_used: string;
    warnings: string[];
  }> = {},
) {
  return JSON.stringify({
    container: "/project1/vector_lines",
    output_top: overrides.output_top ?? "/project1/vector_lines/out",
    edge_top: "/project1/vector_lines/edge",
    trace_sop: "",
    style: overrides.style ?? "contour",
    edge_par_used: overrides.edge_par_used ?? "strength",
    trace_optype_used: overrides.trace_optype_used ?? "",
    warnings: overrides.warnings ?? [],
  });
}

/** Full args object — every defaulted field passed explicitly (impl bypasses schema parsing). */
function args(overrides: Partial<Payload> = {}): Payload {
  return {
    parent_path: "/project1",
    name: "vector_lines",
    source_top: "/project1/moviein1",
    style: "contour",
    threshold: 0.3,
    line_width: 2,
    line_color: [1, 1, 1],
    bg_color: [0, 0, 0],
    animate: true,
    resolution: [1280, 720],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildVectorLinesScript — pure, no TD needed
// ---------------------------------------------------------------------------

describe("buildVectorLinesScript (pure payload)", () => {
  it("embeds all schema fields in the base64 payload", () => {
    const script = buildVectorLinesScript(args());
    const payload = decodePayload(script);
    expect(payload.parent_path).toBe("/project1");
    expect(payload.name).toBe("vector_lines");
    expect(payload.source_top).toBe("/project1/moviein1");
    expect(payload.style).toBe("contour");
    expect(payload.threshold).toBe(0.3);
    expect(payload.line_width).toBe(2);
    expect(payload.line_color).toEqual([1, 1, 1]);
    expect(payload.bg_color).toEqual([0, 0, 0]);
    expect(payload.animate).toBe(true);
    expect(payload.resolution).toEqual([1280, 720]);
  });

  it("embeds trace style with custom colors and resolution", () => {
    const script = buildVectorLinesScript(
      args({
        style: "trace",
        line_color: [1, 0.2, 0],
        bg_color: [0.05, 0.05, 0.1],
        resolution: [1920, 1080],
        threshold: 0.6,
        animate: false,
      }),
    );
    const payload = decodePayload(script);
    expect(payload.style).toBe("trace");
    expect(payload.line_color).toEqual([1, 0.2, 0]);
    expect(payload.bg_color).toEqual([0.05, 0.05, 0.1]);
    expect(payload.resolution).toEqual([1920, 1080]);
    expect(payload.threshold).toBe(0.6);
    expect(payload.animate).toBe(false);
  });

  it("uses only base64 for the payload — no raw source_top literal in the script outside the blob", () => {
    const tricky = "/project1/UNIQUEMARKER_xyzzy";
    const script = buildVectorLinesScript(args({ source_top: tricky }));
    const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1] ?? "";
    expect(b64.length).toBeGreaterThan(0);
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    expect(decoded).toContain(tricky);
    const templateWithoutBlob = script.replace(b64, "REDACTED");
    expect(templateWithoutBlob).not.toContain("UNIQUEMARKER_xyzzy");
  });

  it("script imports json and base64 and prints json.dumps(report)", () => {
    const script = buildVectorLinesScript(args());
    expect(script).toContain("import json, base64");
    expect(script).toContain("print(json.dumps(report))");
    // The TOP/SOP stages are present in the template.
    expect(script).toContain("selectTOP");
    expect(script).toContain("edgeTOP");
    expect(script).toContain("glslTOP");
    expect(script).toContain("traceSOP");
    expect(script).toContain("nullTOP");
  });

  it("GLSL contour shader obeys the house rules (out fragColor, vUV.st, baked me.time.seconds)", () => {
    const script = buildVectorLinesScript(args());
    expect(script).toContain("out vec4 fragColor;");
    expect(script).toContain("vUV.st");
    expect(script).toContain("me.time.seconds");
    expect(script).toContain("TDOutputSwizzle");
  });
});

// ---------------------------------------------------------------------------
// Schema defaults & validation
// ---------------------------------------------------------------------------

describe("createVectorLinesSchema defaults", () => {
  it("applies all documented defaults", () => {
    const parsed = createVectorLinesSchema.parse({ source_top: "/project1/moviein1" });
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.name).toBe("vector_lines");
    expect(parsed.style).toBe("contour");
    expect(parsed.threshold).toBe(0.3);
    expect(parsed.line_width).toBe(2);
    expect(parsed.line_color).toEqual([1, 1, 1]);
    expect(parsed.bg_color).toEqual([0, 0, 0]);
    expect(parsed.animate).toBe(true);
    expect(parsed.resolution).toEqual([1280, 720]);
  });

  it("coerces numeric strings for threshold and line_width", () => {
    const parsed = createVectorLinesSchema.parse({
      source_top: "/s",
      threshold: "0.7",
      line_width: "4",
    });
    expect(parsed.threshold).toBe(0.7);
    expect(parsed.line_width).toBe(4);
  });

  it("rejects threshold > 1", () => {
    expect(() => createVectorLinesSchema.parse({ source_top: "/s", threshold: 1.5 })).toThrow();
  });

  it("rejects an invalid style", () => {
    expect(() => createVectorLinesSchema.parse({ source_top: "/s", style: "scribble" })).toThrow();
  });

  it("rejects a line_color that is not length 3", () => {
    expect(() => createVectorLinesSchema.parse({ source_top: "/s", line_color: [1, 1] })).toThrow();
  });

  it("rejects a resolution that is not length 2", () => {
    expect(() => createVectorLinesSchema.parse({ source_top: "/s", resolution: [1280] })).toThrow();
  });

  it("requires source_top", () => {
    expect(() => createVectorLinesSchema.parse({})).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Happy path — impl integration
// ---------------------------------------------------------------------------

describe("createVectorLinesImpl — happy path", () => {
  it("returns a non-error result with a summary line", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    const result = await createVectorLinesImpl(fakeCtx(exec), args());
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("contour line-art");
    expect(text).toContain("/project1/moviein1");
    expect(text).toContain("/project1/vector_lines/out");
    expect(text).toContain("(marching/animated)");
  });

  it("sends the correct payload (source_top, style, threshold, colors, resolution)", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport({ style: "trace" }) }));
    await createVectorLinesImpl(
      fakeCtx(exec),
      args({
        source_top: "/project1/cam1",
        style: "trace",
        threshold: 0.55,
        line_width: 3,
        line_color: [0, 1, 0],
        bg_color: [0.1, 0, 0.1],
        resolution: [1920, 1080],
        animate: false,
      }),
    );
    const payload = decodePayload(scriptArg(exec));
    expect(payload.source_top).toBe("/project1/cam1");
    expect(payload.style).toBe("trace");
    expect(payload.threshold).toBe(0.55);
    expect(payload.line_width).toBe(3);
    expect(payload.line_color).toEqual([0, 1, 0]);
    expect(payload.bg_color).toEqual([0.1, 0, 0.1]);
    expect(payload.resolution).toEqual([1920, 1080]);
    expect(payload.animate).toBe(false);
  });

  it("omits the marching note for non-animated / non-contour styles", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({ style: "plotter", warnings: ["cook-costly"] }),
    }));
    const result = await createVectorLinesImpl(
      fakeCtx(exec),
      args({ style: "plotter", animate: false }),
    );
    const text = textOf(result);
    expect(text).toContain("plotter line-art");
    expect(text).not.toContain("(marching/animated)");
  });

  it("includes a warning count in the summary when warnings are present", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({
        warnings: ["edgeTOP strength par not found (UNVERIFIED TD build); using Edge defaults."],
      }),
    }));
    const result = await createVectorLinesImpl(fakeCtx(exec), args());
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("1 warning(s)");
  });
});

// ---------------------------------------------------------------------------
// Fatal — source not found
// ---------------------------------------------------------------------------

describe("createVectorLinesImpl — fatal (source not found)", () => {
  it("returns isError:true and does not throw", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        container: "",
        output_top: "",
        edge_top: "",
        trace_sop: "",
        style: "contour",
        edge_par_used: "",
        trace_optype_used: "",
        warnings: [],
        fatal: "Source TOP not found: /project1/missing",
      }),
    }));
    const result = await createVectorLinesImpl(
      fakeCtx(exec),
      args({ source_top: "/project1/missing" }),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Source TOP not found");
  });
});

// ---------------------------------------------------------------------------
// TD offline — guardTd swallows the connection error
// ---------------------------------------------------------------------------

describe("createVectorLinesImpl — TD offline", () => {
  it("returns isError:true and does not throw when the bridge is unreachable", async () => {
    const exec = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await createVectorLinesImpl(fakeCtx(exec), args());
    expect(result.isError).toBe(true);
  });
});
