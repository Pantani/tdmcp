import { describe, expect, it, vi } from "vitest";

describe("Shader Park integration", () => {
  it("compiles Shader Park sculpture code into TouchDesigner GLSL", async () => {
    vi.resetModules();
    vi.doMock("shader-park-core", () => ({
      sculptToTouchDesignerShaderSource: () => ({
        frag: "uniform float size;\nfloat surfaceDistance(vec3 p) { return 0.0; }",
        uniforms: [
          { name: "time", type: "float", value: 0 },
          { name: "opacity", type: "float", value: 1 },
          { name: "_scale", type: "float", value: 1 },
          { name: "size", type: "float", value: 0 },
        ],
      }),
    }));
    const originalLog = console.log;
    try {
      const { compileShaderParkToTouchDesigner } = await import(
        "../../src/integrations/shaderPark.js"
      );
      const compiled = await compileShaderParkToTouchDesigner("let size = input();\nsphere(size);");

      expect(console.log).toBe(originalLog);
      expect(compiled.pixelShader).toContain("uniform float size;");
      expect(compiled.pixelShader).toContain("surfaceDistance");
      expect(compiled.uniforms).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "time", type: "float", value: 0 }),
          expect.objectContaining({ name: "opacity", type: "float", value: 1 }),
          expect.objectContaining({ name: "_scale", type: "float", value: 1 }),
          expect.objectContaining({ name: "size", type: "float", value: 0 }),
        ]),
      );
    } finally {
      vi.doUnmock("shader-park-core");
      vi.resetModules();
    }
  });

  it("suppresses shader-park-core import-time stream writes without replacing console.log", async () => {
    vi.resetModules();
    const originalLog = console.log;
    const stdoutWrite = vi.spyOn(process.stdout, "write");
    const stderrWrite = vi.spyOn(process.stderr, "write");
    let consoleLogDuringImport: typeof console.log | undefined;

    vi.doMock("shader-park-core", () => {
      consoleLogDuringImport = console.log;
      process.stdout.write("shader park import stdout\n");
      process.stderr.write("shader park import stderr\n");
      return {
        sculptToTouchDesignerShaderSource: () => ({
          frag: "void main() {}",
          uniforms: [],
        }),
      };
    });

    try {
      const { compileShaderParkToTouchDesigner: compileWithMock } = await import(
        "../../src/integrations/shaderPark.js"
      );
      const compiled = await compileWithMock("sphere(0.5);");
      const stdoutText = stdoutWrite.mock.calls.map((call) => String(call[0])).join("");
      const stderrText = stderrWrite.mock.calls.map((call) => String(call[0])).join("");

      expect(compiled.pixelShader).toBe("void main() {}");
      expect(consoleLogDuringImport).toBe(originalLog);
      expect(console.log).toBe(originalLog);
      expect(stdoutText).not.toContain("shader park import stdout");
      expect(stderrText).not.toContain("shader park import stderr");
    } finally {
      stdoutWrite.mockRestore();
      stderrWrite.mockRestore();
      vi.doUnmock("shader-park-core");
      vi.resetModules();
    }
  });

  it("turns Shader Park compiler failures into actionable errors", async () => {
    vi.resetModules();
    vi.doMock("shader-park-core", () => ({
      sculptToTouchDesignerShaderSource: () => {
        throw new Error("parse error");
      },
    }));
    try {
      const { compileShaderParkToTouchDesigner } = await import(
        "../../src/integrations/shaderPark.js"
      );
      await expect(compileShaderParkToTouchDesigner("sphere(")).rejects.toThrow(
        "Shader Park compile failed: parse error",
      );
    } finally {
      vi.doUnmock("shader-park-core");
      vi.resetModules();
    }
  });

  it("turns a missing optional shader-park-core install into actionable guidance", async () => {
    vi.resetModules();
    vi.doMock("shader-park-core", () => {
      const missingPackageError = new Error("Cannot find package 'shader-park-core'");
      Object.assign(missingPackageError, { code: "ERR_MODULE_NOT_FOUND" });
      throw missingPackageError;
    });

    try {
      const { compileShaderParkToTouchDesigner: compileWithMock } = await import(
        "../../src/integrations/shaderPark.js"
      );

      await expect(compileWithMock("sphere(0.5);")).rejects.toThrow(
        "Shader Park compiler requires the optional dependency 'shader-park-core'.",
      );
    } finally {
      vi.doUnmock("shader-park-core");
      vi.resetModules();
    }
  });

  it("preserves Shader Park failure context for circular compiler errors", async () => {
    vi.resetModules();
    const circularError: Record<string, unknown> = {};
    circularError.self = circularError;
    vi.doMock("shader-park-core", () => ({
      sculptToTouchDesignerShaderSource: () => ({
        error: circularError,
        frag: "void main() {}",
        uniforms: [],
      }),
    }));

    try {
      const { compileShaderParkToTouchDesigner: compileWithMock } = await import(
        "../../src/integrations/shaderPark.js"
      );

      await expect(compileWithMock("sphere(0.5);")).rejects.toThrow(
        /^Shader Park compile failed: \[object Object\]/,
      );
    } finally {
      vi.doUnmock("shader-park-core");
      vi.resetModules();
    }
  });

  it("retries loading shader-park-core after a rejected dynamic import", async () => {
    vi.resetModules();
    let attempts = 0;
    vi.doMock("shader-park-core", () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary import failure");
      return {
        sculptToTouchDesignerShaderSource: () => ({
          frag: "void main() {}",
          uniforms: [],
        }),
      };
    });

    try {
      const { compileShaderParkToTouchDesigner: compileWithMock } = await import(
        "../../src/integrations/shaderPark.js"
      );
      await expect(compileWithMock("sphere(0.5);")).rejects.toThrow(
        /temporary import failure|error when mocking a module/,
      );
      const compiled = await compileWithMock("sphere(0.5);");

      expect(attempts).toBe(2);
      expect(compiled.pixelShader).toBe("void main() {}");
    } finally {
      vi.doUnmock("shader-park-core");
      vi.resetModules();
    }
  });
});
