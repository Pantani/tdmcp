import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("capture-example docs media script", () => {
  it("passes Node syntax validation", () => {
    expect(() => execFileSync("node", ["--check", "scripts/capture-example.mjs"])).not.toThrow();
  });

  it("exposes cookbook capture presets without requiring live TouchDesigner", () => {
    const result = spawnSync(
      "node",
      [
        "scripts/capture-example.mjs",
        "--preset",
        "raytk-cookbook",
        "--node",
        "/project1/raytk_scene/render1/out1",
        "--out",
        "docs/public/examples/raytk-test.mp4",
        "--print-plan",
      ],
      { encoding: "utf8", timeout: 5000 },
    );

    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan).toEqual(
      expect.objectContaining({
        preset: "raytk-cookbook",
        frames: 56,
        step: 2,
        width: 480,
        height: 270,
        fps: 20,
        delayMs: 80,
        warmupFrames: 12,
        verify: true,
        motionMinUnique: 2,
      }),
    );
  });

  it("allows cookbook preset verification to be disabled for manual debugging", () => {
    const result = spawnSync(
      "node",
      [
        "scripts/capture-example.mjs",
        "--preset",
        "cookbook",
        "--node",
        "/project1/doc/out1",
        "--out",
        "docs/public/examples/debug.mp4",
        "--no-verify",
        "--print-plan",
      ],
      { encoding: "utf8", timeout: 5000 },
    );

    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan.verify).toBe(false);
    expect(plan.warmupFrames).toBe(0);
    expect(plan.delayMs).toBe(20);
  });

  it("keeps the legacy square default when only width is supplied without a preset", () => {
    const result = spawnSync(
      "node",
      [
        "scripts/capture-example.mjs",
        "--node",
        "/project1/doc/out1",
        "--out",
        "docs/public/examples/debug.gif",
        "--width",
        "640",
        "--print-plan",
      ],
      { encoding: "utf8", timeout: 5000 },
    );

    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan.width).toBe(640);
    expect(plan.height).toBe(640);
    expect(plan.frames).toBe(40);
    expect(plan.fps).toBe(16);
  });
});
