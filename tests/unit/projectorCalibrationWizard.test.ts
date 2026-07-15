import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  projectorCalibrationWizardImpl,
  projectorCalibrationWizardSchema,
} from "../../src/tools/layer1/projectorCalibrationWizard.js";
import { makeTdServer } from "../helpers/tdMock.js";
import { captureCreateBodies, makeCtx, textOf } from "../helpers/tdToolTestUtils.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("projector_calibration_wizard", () => {
  it("schema defaults are a one-projector generated-pattern rehearsal build", () => {
    const parsed = projectorCalibrationWizardSchema.parse({});
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.name).toBe("projector_calibration");
    expect(parsed.projectors).toBe(1);
    expect(parsed.include_corner_pin).toBe(true);
  });

  it("builds generated pattern plus per-projector crop/corner-pin/level/output lanes", async () => {
    const bodies = captureCreateBodies(server);
    const result = await projectorCalibrationWizardImpl(
      makeCtx(),
      projectorCalibrationWizardSchema.parse({ projectors: 2 }),
    );

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("UNVERIFIED-projector");
    expect(result.content.some((c) => c.type === "image")).toBe(true);
    expect(
      bodies.some((body) => body.type === "glslTOP" && body.name === "calibration_pattern"),
    ).toBe(true);
    expect(bodies.filter((body) => body.type === "cornerpinTOP")).toHaveLength(2);
    expect(bodies.filter((body) => body.type === "levelTOP")).toHaveLength(2);
    expect(bodies.find((body) => body.name === "p1_crop")?.parameters).toMatchObject({
      cropleftunit: "fraction",
      croprightunit: "fraction",
      cropleft: 0,
      cropright: 0.54,
      outputresolution: "custom",
    });
    expect(bodies.find((body) => body.name === "p2_crop")?.parameters).toMatchObject({
      cropleft: 0.46,
      cropright: 1,
    });
    for (const level of bodies.filter((body) => body.type === "levelTOP")) {
      expect(level.parameters).toMatchObject({ brightness1: 1, gamma1: 1, opacity: 1 });
      expect(level.parameters).not.toHaveProperty("brightness");
      expect(level.parameters).not.toHaveProperty("gamma");
    }
    expect(bodies.find((body) => body.type === "layoutTOP")?.parameters?.align).toBe("horizlr");
    expect(bodies.some((body) => body.type === "layoutTOP")).toBe(true);
    expect(bodies.some((body) => body.name === "p2_out")).toBe(true);
  });

  it("uses a Select TOP when source_path is provided", async () => {
    const bodies = captureCreateBodies(server);
    await projectorCalibrationWizardImpl(
      makeCtx(),
      projectorCalibrationWizardSchema.parse({ source_path: "/project1/show/out1" }),
    );
    const select = bodies.find((body) => body.type === "selectTOP");
    expect(select?.parameters?.top).toBe("/project1/show/out1");
    expect(bodies.some((body) => body.name === "calibration_pattern")).toBe(false);
  });
});
