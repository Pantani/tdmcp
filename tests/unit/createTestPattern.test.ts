import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildTestPatternScript,
  createTestPatternImpl,
  createTestPatternSchema,
} from "../../src/tools/layer1/createTestPattern.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Payload {
  parent_path: string;
  name: string;
  pattern: string;
  width: number;
  height: number;
  divisions: number;
  output_number: number;
  label: string;
  line_color: number[];
  bg_color: number[];
  shader: string;
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

function happyReport(overrides: Partial<{ warnings: string[]; output_top: string }> = {}) {
  return JSON.stringify({
    container: "/project1/test_pattern",
    output_top: overrides.output_top ?? "/project1/test_pattern/out",
    pattern: "grid",
    width: 1920,
    height: 1080,
    warnings: overrides.warnings ?? [],
  });
}

/** Full set of defaulted args — required when calling impl directly (bypasses schema). */
const DEFAULT_ARGS = {
  parent_path: "/project1",
  name: "test_pattern",
  pattern: "grid" as const,
  width: 1920,
  height: 1080,
  divisions: 16,
  output_number: 0,
  label: "",
  line_color: [0, 1, 0],
  bg_color: [0, 0, 0],
};

// ---------------------------------------------------------------------------
// buildTestPatternScript — pure, no TD needed
// ---------------------------------------------------------------------------

describe("buildTestPatternScript (pure payload)", () => {
  it("embeds all fields in the base64 payload", () => {
    const script = buildTestPatternScript({
      parent_path: "/project1",
      name: "tp",
      pattern: "crosshair",
      width: 1920,
      height: 1080,
      divisions: 16,
      output_number: 3,
      label: "LEFT",
      line_color: [1, 0, 0],
      bg_color: [0, 0, 0],
      shader: "void main(){ fragColor = vec4(1.0); }",
    });
    const payload = decodePayload(script);
    expect(payload.parent_path).toBe("/project1");
    expect(payload.name).toBe("tp");
    expect(payload.pattern).toBe("crosshair");
    expect(payload.width).toBe(1920);
    expect(payload.height).toBe(1080);
    expect(payload.divisions).toBe(16);
    expect(payload.output_number).toBe(3);
    expect(payload.label).toBe("LEFT");
    expect(payload.line_color).toEqual([1, 0, 0]);
    expect(payload.bg_color).toEqual([0, 0, 0]);
    expect(payload.shader).toContain("void main()");
  });

  it("embeds shader safely even when it contains quotes and newlines", () => {
    const tricky = `out vec4 fragColor;\nvoid main(){ fragColor = vec4("hello", 0.0, 0.0, 1.0); }`;
    const script = buildTestPatternScript({
      parent_path: "/project1",
      name: "tp",
      pattern: "grid",
      width: 1920,
      height: 1080,
      divisions: 16,
      output_number: 0,
      label: "",
      line_color: [0, 1, 0],
      bg_color: [0, 0, 0],
      shader: tricky,
    });
    const payload = decodePayload(script);
    expect(payload.shader).toBe(tricky);
  });

  it("keeps raw user strings out of the Python template (only in b64 blob)", () => {
    const marker = "UNIQUEMARKER_test_pattern_abc123";
    const script = buildTestPatternScript({
      parent_path: "/project1",
      name: marker,
      pattern: "grid",
      width: 1920,
      height: 1080,
      divisions: 16,
      output_number: 0,
      label: "",
      line_color: [0, 1, 0],
      bg_color: [0, 0, 0],
      shader: "void main(){}",
    });
    const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1] ?? "";
    expect(b64.length).toBeGreaterThan(0);
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    expect(decoded).toContain(marker);
    const templateWithoutBlob = script.replace(b64, "REDACTED");
    expect(templateWithoutBlob).not.toContain(marker);
  });

  it("script uses base64 + json, creates glslTOP, textDAT, nullTOP, prints json.dumps", () => {
    const script = buildTestPatternScript({
      parent_path: "/project1",
      name: "tp",
      pattern: "grid",
      width: 1920,
      height: 1080,
      divisions: 16,
      output_number: 0,
      label: "",
      line_color: [0, 1, 0],
      bg_color: [0, 0, 0],
      shader: "",
    });
    expect(script).toContain("import json, base64");
    expect(script).toContain("print(json.dumps(report))");
    expect(script).toContain("glslTOP");
    expect(script).toContain("textDAT");
    expect(script).toContain("nullTOP");
  });

  it("includes textTOP and compositeTOP creation logic (for overlay)", () => {
    const script = buildTestPatternScript({
      parent_path: "/project1",
      name: "tp",
      pattern: "grid",
      width: 1920,
      height: 1080,
      divisions: 16,
      output_number: 1,
      label: "",
      line_color: [0, 1, 0],
      bg_color: [0, 0, 0],
      shader: "",
    });
    expect(script).toContain("textTOP");
    expect(script).toContain("compositeTOP");
  });
});

// ---------------------------------------------------------------------------
// GLSL generator (via buildShader path — checked through payload)
// ---------------------------------------------------------------------------

describe("GLSL baked into payload", () => {
  it("grid shader contains fragColor declaration and TDOutputSwizzle", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    await createTestPatternImpl(fakeCtx(exec), { ...DEFAULT_ARGS, pattern: "grid" });
    const payload = decodePayload(scriptArg(exec));
    expect(payload.shader).toContain("out vec4 fragColor;");
    expect(payload.shader).toContain("TDOutputSwizzle");
    expect(payload.shader).toContain("vUV.st");
  });

  it("crosshair shader contains cross and corner logic", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    await createTestPatternImpl(fakeCtx(exec), { ...DEFAULT_ARGS, pattern: "crosshair" });
    const payload = decodePayload(scriptArg(exec));
    expect(payload.shader).toContain("cross");
    expect(payload.shader).toContain("corner");
    expect(payload.shader).toContain("TDOutputSwizzle");
  });

  it("color_bars shader contains bars array", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    await createTestPatternImpl(fakeCtx(exec), { ...DEFAULT_ARGS, pattern: "color_bars" });
    const payload = decodePayload(scriptArg(exec));
    expect(payload.shader).toContain("bars");
    expect(payload.shader).toContain("TDOutputSwizzle");
  });

  it("ramp shader contains mix(", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    await createTestPatternImpl(fakeCtx(exec), { ...DEFAULT_ARGS, pattern: "ramp" });
    const payload = decodePayload(scriptArg(exec));
    expect(payload.shader).toContain("mix(");
    expect(payload.shader).toContain("vUV.s");
    expect(payload.shader).toContain("TDOutputSwizzle");
  });

  it("circle_grid shader contains ring/dist logic", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    await createTestPatternImpl(fakeCtx(exec), { ...DEFAULT_ARGS, pattern: "circle_grid" });
    const payload = decodePayload(scriptArg(exec));
    expect(payload.shader).toContain("length(");
    expect(payload.shader).toContain("ring");
    expect(payload.shader).toContain("TDOutputSwizzle");
  });

  it("bakes custom line_color and bg_color into grid shader", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    await createTestPatternImpl(fakeCtx(exec), {
      ...DEFAULT_ARGS,
      pattern: "grid",
      line_color: [1, 0.5, 0],
      bg_color: [0.1, 0.1, 0.1],
    });
    const payload = decodePayload(scriptArg(exec));
    expect(payload.shader).toContain("1.0000");
    expect(payload.shader).toContain("0.5000");
    expect(payload.shader).toContain("0.1000");
  });

  it("shader does NOT contain uTime (patterns are static)", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    for (const pattern of ["grid", "crosshair", "color_bars", "ramp", "circle_grid"] as const) {
      const exec2 = vi.fn(async () => ({ stdout: happyReport() }));
      await createTestPatternImpl(fakeCtx(exec2), { ...DEFAULT_ARGS, pattern });
      const payload = decodePayload(scriptArg(exec2));
      expect(payload.shader).not.toContain("uTime");
    }
    void exec;
  });

  it("shader does NOT contain #define F1 or F2 (TD preamble collision risk)", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    await createTestPatternImpl(fakeCtx(exec), { ...DEFAULT_ARGS, pattern: "grid" });
    const payload = decodePayload(scriptArg(exec));
    expect(payload.shader).not.toMatch(/#define F1/);
    expect(payload.shader).not.toMatch(/#define F2/);
  });

  it("bakes divisions into grid and circle_grid shaders", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    await createTestPatternImpl(fakeCtx(exec), { ...DEFAULT_ARGS, pattern: "grid", divisions: 8 });
    const payload = decodePayload(scriptArg(exec));
    expect(payload.divisions).toBe(8);
    expect(payload.shader).toContain("8");
  });
});

// ---------------------------------------------------------------------------
// Happy path — impl integration
// ---------------------------------------------------------------------------

describe("createTestPatternImpl — happy path", () => {
  it("returns a non-error result with a summary line", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    const result = await createTestPatternImpl(fakeCtx(exec), DEFAULT_ARGS);
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("grid");
    expect(text).toContain("1920");
    expect(text).toContain("1080");
    expect(text).toContain("/project1/test_pattern/out");
  });

  it("sends correct payload fields to the bridge", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    await createTestPatternImpl(fakeCtx(exec), {
      ...DEFAULT_ARGS,
      pattern: "crosshair",
      width: 3840,
      height: 2160,
      output_number: 2,
      label: "RIGHT",
    });
    const payload = decodePayload(scriptArg(exec));
    expect(payload.pattern).toBe("crosshair");
    expect(payload.width).toBe(3840);
    expect(payload.height).toBe(2160);
    expect(payload.output_number).toBe(2);
    expect(payload.label).toBe("RIGHT");
  });

  it("includes warning count in summary when warnings present", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({
        warnings: ["glslTOP.par.outputresolution failed: par not found"],
      }),
    }));
    const result = await createTestPatternImpl(fakeCtx(exec), DEFAULT_ARGS);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("1 warning(s)");
  });

  it("does not include warning count note when there are no warnings", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport({ warnings: [] }) }));
    const result = await createTestPatternImpl(fakeCtx(exec), DEFAULT_ARGS);
    // The JSON fence contains the key "warnings" — we check the SUMMARY LINE only
    const summaryLine = textOf(result).split("\n")[0] ?? "";
    expect(summaryLine).not.toContain("warning");
  });
});

// ---------------------------------------------------------------------------
// Schema defaults
// ---------------------------------------------------------------------------

describe("createTestPatternSchema defaults", () => {
  it("applies all documented defaults when called with empty object", () => {
    const parsed = createTestPatternSchema.parse({});
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.name).toBe("test_pattern");
    expect(parsed.pattern).toBe("grid");
    expect(parsed.width).toBe(1920);
    expect(parsed.height).toBe(1080);
    expect(parsed.divisions).toBe(16);
    expect(parsed.output_number).toBe(0);
    expect(parsed.label).toBe("");
    expect(parsed.line_color).toEqual([0, 1, 0]);
    expect(parsed.bg_color).toEqual([0, 0, 0]);
  });

  it("coerces string width/height/divisions/output_number", () => {
    const parsed = createTestPatternSchema.parse({
      width: "2560",
      height: "1440",
      divisions: "8",
      output_number: "5",
    });
    expect(parsed.width).toBe(2560);
    expect(parsed.height).toBe(1440);
    expect(parsed.divisions).toBe(8);
    expect(parsed.output_number).toBe(5);
  });

  it("rejects an invalid pattern enum value", () => {
    expect(() => createTestPatternSchema.parse({ pattern: "smpte_color_bars" })).toThrow();
  });

  it("rejects line_color with wrong length", () => {
    expect(() => createTestPatternSchema.parse({ line_color: [1, 0] })).toThrow();
  });

  it("accepts all valid pattern values", () => {
    for (const p of ["grid", "crosshair", "color_bars", "ramp", "circle_grid"]) {
      expect(() => createTestPatternSchema.parse({ pattern: p })).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Fatal — parent COMP not found
// ---------------------------------------------------------------------------

describe("createTestPatternImpl — fatal", () => {
  it("returns isError:true and does not throw when parent COMP is missing", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        container: "",
        output_top: "",
        pattern: "grid",
        width: 1920,
        height: 1080,
        warnings: [],
        fatal: "Parent COMP not found: /project1/missing",
      }),
    }));
    const result = await createTestPatternImpl(fakeCtx(exec), {
      ...DEFAULT_ARGS,
      parent_path: "/project1/missing",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Parent COMP not found");
  });

  it("returns isError:true when glslTOP creation fails fatally", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        container: "/project1/test_pattern",
        output_top: "",
        pattern: "grid",
        width: 1920,
        height: 1080,
        warnings: [],
        fatal: "Could not create glslTOP: unknown error",
      }),
    }));
    const result = await createTestPatternImpl(fakeCtx(exec), DEFAULT_ARGS);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Test pattern build failed");
  });
});

// ---------------------------------------------------------------------------
// TD offline — guardTd swallows the connection error
// ---------------------------------------------------------------------------

describe("createTestPatternImpl — TD offline", () => {
  it("returns isError:true and does not throw when the bridge is unreachable", async () => {
    const exec = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await createTestPatternImpl(fakeCtx(exec), DEFAULT_ARGS);
    expect(result.isError).toBe(true);
  });
});
