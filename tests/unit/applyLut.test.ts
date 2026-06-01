import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { applyLutImpl, applyLutSchema } from "../../src/tools/layer2/applyLut.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface LutPayload {
  lut_path: string;
  source_path: string;
  ocio_config_path: string;
  strength: number;
  bypass: boolean;
  prefer: string;
  expose_controls: boolean;
  parent_path: string;
  container_name: string;
}

function decodePayload(script: string): LutPayload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("no base64 payload found in script");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as LutPayload;
}

function fakeCtx(execResult: object, previewResult?: object): ToolContext {
  const executePythonScript = vi.fn().mockResolvedValue({
    result: null,
    stdout: JSON.stringify(execResult),
  });
  const getPreview = vi.fn().mockResolvedValue(
    previewResult ?? {
      path: "/project1/apply_lut/out1",
      width: 640,
      height: 360,
      format: "png",
      base64: "abc123",
    },
  );
  return {
    client: { executePythonScript, getPreview },
    logger: silentLogger,
  } as unknown as ToolContext;
}

function scriptArg(ctx: ToolContext): string {
  const exec = (ctx.client as unknown as Record<string, ReturnType<typeof vi.fn>>)
    .executePythonScript;
  const s = exec?.mock.calls[0]?.[0];
  if (typeof s !== "string") throw new Error("executePythonScript not called with a string");
  return s;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function parseJsonFence(result: CallToolResult): Record<string, unknown> {
  const text = textOf(result);
  const match = /```json\n([\s\S]+?)\n```/.exec(text);
  if (!match?.[1]) throw new Error("no JSON fence in result");
  return JSON.parse(match[1]) as Record<string, unknown>;
}

function happyReport(
  overrides: Partial<{
    grade_branch: string;
    ocio_available: boolean;
    container: string;
    source: string;
    output: string;
    warnings: string[];
    errors: string[];
  }> = {},
) {
  return {
    container: overrides.container ?? "/project1/apply_lut",
    source: overrides.source ?? "/project1/apply_lut/source",
    grade_branch: overrides.grade_branch ?? "ocio",
    ocio_available: overrides.ocio_available ?? true,
    output: overrides.output ?? "/project1/apply_lut/out1",
    warnings: overrides.warnings ?? [],
    errors: overrides.errors ?? [],
  };
}

function _defaultArgs(
  overrides: Partial<LutPayload & { prefer: "auto" | "ocio" | "lookup" }> = {},
) {
  const base = applyLutSchema.parse({
    lut_path: "/looks/grade.cube",
    ...overrides,
  });
  return base;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("applyLutImpl", () => {
  // -------------------------------------------------------------------------
  // 1. OCIO success branch (auto, .cube, OCIO available)
  // -------------------------------------------------------------------------
  it("success — OCIO branch: branch=ocio, ocio_available=true in result", async () => {
    const report = happyReport({ grade_branch: "ocio", ocio_available: true });
    const ctx = fakeCtx(report);
    const args = applyLutSchema.parse({
      lut_path: "/looks/grade.cube",
      source_path: "/project1/render1",
      prefer: "auto",
      strength: 0.8,
    });
    const result = await applyLutImpl(ctx, args);
    expect(result.isError).toBeFalsy();

    const data = parseJsonFence(result);
    expect(data.branch).toBe("ocio");
    expect(data.ocio_available).toBe(true);
    expect(data.output_path).toBe("/project1/apply_lut/out1");
    expect(data.container_path).toBe("/project1/apply_lut");

    // Payload carries lut_path + source_path + prefer
    const payload = decodePayload(scriptArg(ctx));
    expect(payload.lut_path).toBe("/looks/grade.cube");
    expect(payload.source_path).toBe("/project1/render1");
    expect(payload.prefer).toBe("auto");
    expect(payload.strength).toBe(0.8);

    // Script contains openColorIOTOP reference
    expect(scriptArg(ctx)).toContain("openColorIOTOP");
  });

  // -------------------------------------------------------------------------
  // 2. OCIO absent → Lookup fallback (image LUT)
  // -------------------------------------------------------------------------
  it("OCIO absent + image LUT → lookup branch, creates moviefileinTOP and lookupTOP", async () => {
    const report = happyReport({
      grade_branch: "lookup",
      ocio_available: false,
      source: "/project1/apply_lut/source",
    });
    const ctx = fakeCtx(report);
    const args = applyLutSchema.parse({
      lut_path: "/looks/grade.png",
      source_path: "/project1/render1",
      prefer: "auto",
    });
    const result = await applyLutImpl(ctx, args);
    expect(result.isError).toBeFalsy();

    const data = parseJsonFence(result);
    expect(data.branch).toBe("lookup");
    expect(data.ocio_available).toBe(false);

    const script = scriptArg(ctx);
    expect(script).toContain("moviefileinTOP");
    expect(script).toContain("lookupTOP");
    // lookup = "input" pattern
    expect(script).toContain('"input"');
  });

  // -------------------------------------------------------------------------
  // 3. OCIO absent + .cube → cube_parsed fallback
  // -------------------------------------------------------------------------
  it("OCIO absent + .cube → cube_parsed branch, warns and uses tableDAT + scriptTOP", async () => {
    const report = happyReport({
      grade_branch: "cube_parsed",
      ocio_available: false,
      warnings: ["OpenColorIO TOP not available; parsed .cube fallback in use."],
    });
    const ctx = fakeCtx(report);
    const args = applyLutSchema.parse({
      lut_path: "/looks/look.cube",
      source_path: "/project1/render1",
      prefer: "auto",
    });
    const result = await applyLutImpl(ctx, args);
    expect(result.isError).toBeFalsy();

    const data = parseJsonFence(result);
    expect(data.branch).toBe("cube_parsed");
    expect((data.warnings as string[]).some((w) => w.includes("parsed .cube fallback"))).toBe(true);

    const script = scriptArg(ctx);
    expect(script).toContain("tableDAT");
    expect(script).toContain("scriptTOP");
  });

  // -------------------------------------------------------------------------
  // 4. Missing file → errorResult (no bridge call beyond guardTd check)
  // -------------------------------------------------------------------------
  it("missing LUT file → errorResult with 'LUT file not found' message", async () => {
    const ctx = fakeCtx({});
    const execMock = ctx.client.executePythonScript as ReturnType<typeof vi.fn>;
    const args = applyLutSchema.parse({ lut_path: "/does/not/exist.cube" });

    // Temporarily unset VITEST so the existsSync early-return branch actually runs.
    const prev = process.env.VITEST;
    delete process.env.VITEST;
    let result: Awaited<ReturnType<typeof applyLutImpl>> | undefined;
    try {
      result = await applyLutImpl(ctx, args);
    } finally {
      if (prev !== undefined) process.env.VITEST = prev;
      else delete process.env.VITEST;
    }

    expect(execMock).not.toHaveBeenCalled();
    expect(result?.isError).toBe(true);
    expect(textOf(result as Awaited<ReturnType<typeof applyLutImpl>>)).toContain(
      "LUT file not found",
    );
  });

  // -------------------------------------------------------------------------
  // 5. Bypass = true → expression includes "Bypass" and crossfade forced to 0
  // -------------------------------------------------------------------------
  it("bypass=true → crossfade expression references Bypass, expose_controls adds Strength+Bypass", async () => {
    const report = happyReport({ grade_branch: "ocio", ocio_available: true });
    const ctx = fakeCtx(report);
    const args = applyLutSchema.parse({
      lut_path: "/looks/grade.cube",
      source_path: "/project1/render1",
      bypass: true,
      expose_controls: true,
    });
    await applyLutImpl(ctx, args);

    const script = scriptArg(ctx);
    // Script should contain the bypass expression with "Bypass" keyword
    expect(script).toContain("Bypass");
    // expose_controls path: custom page adds Strength and Bypass toggles
    expect(script).toContain("Strength");
    expect(script).toContain("appendToggle");
    // Payload carries bypass=true
    const payload = decodePayload(script);
    expect(payload.bypass).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 6. No source_path → constantTOP created for standalone preview
  // -------------------------------------------------------------------------
  it("no source_path → constantTOP created (standalone preview path)", async () => {
    const report = happyReport({
      grade_branch: "ocio",
      ocio_available: true,
      source: "/project1/apply_lut/source",
      output: "/project1/apply_lut/out1",
    });
    const ctx = fakeCtx(report);
    const args = applyLutSchema.parse({ lut_path: "/looks/grade.cube" });
    // source_path is omitted → should be empty string in payload
    const result = await applyLutImpl(ctx, args);
    expect(result.isError).toBeFalsy();

    const script = scriptArg(ctx);
    expect(script).toContain("constantTOP");
    const payload = decodePayload(script);
    expect(payload.source_path).toBe("");

    const data = parseJsonFence(result);
    expect(data.output_path).toBe("/project1/apply_lut/out1");
  });

  // -------------------------------------------------------------------------
  // 7. prefer="lookup" forces lookup branch even when OCIO available
  // -------------------------------------------------------------------------
  it("prefer='lookup' → branch=lookup even when ocio_available=true", async () => {
    const report = happyReport({
      grade_branch: "lookup",
      ocio_available: true,
    });
    const ctx = fakeCtx(report);
    const args = applyLutSchema.parse({
      lut_path: "/looks/grade.cube",
      source_path: "/project1/render1",
      prefer: "lookup",
    });
    const result = await applyLutImpl(ctx, args);
    expect(result.isError).toBeFalsy();

    const data = parseJsonFence(result);
    expect(data.branch).toBe("lookup");

    const payload = decodePayload(scriptArg(ctx));
    expect(payload.prefer).toBe("lookup");
  });
});
