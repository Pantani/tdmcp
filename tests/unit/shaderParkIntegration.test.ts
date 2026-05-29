import { describe, expect, it, vi } from "vitest";
import { compileShaderParkToTouchDesigner } from "../../src/integrations/shaderPark.js";

describe("Shader Park integration", () => {
  it("compiles Shader Park sculpture code into TouchDesigner GLSL without leaking stdout", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const compiled = await compileShaderParkToTouchDesigner("let size = input();\nsphere(size);");

      expect(log).not.toHaveBeenCalled();
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
      log.mockRestore();
    }
  });

  it("turns Shader Park compiler failures into actionable errors", async () => {
    await expect(compileShaderParkToTouchDesigner("sphere(")).rejects.toThrow(
      /Shader Park compile failed/i,
    );
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
