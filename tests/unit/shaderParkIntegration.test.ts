import { describe, expect, it, vi } from "vitest";
import { compileShaderParkToTouchDesigner } from "../../src/integrations/shaderPark.js";

describe("Shader Park integration", () => {
  it("compiles Shader Park sculpture code into TouchDesigner GLSL without leaking stdout", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

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

    log.mockRestore();
  });

  it("turns Shader Park compiler failures into actionable errors", async () => {
    await expect(compileShaderParkToTouchDesigner("sphere(")).rejects.toThrow(
      /Shader Park compile failed/i,
    );
  });
});
