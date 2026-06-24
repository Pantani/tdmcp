import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("kinect wall harp external bridge script", () => {
  it("passes Node syntax validation", () => {
    expect(() =>
      execFileSync("node", ["--check", "scripts/kinect-wall-harp-bridge.mjs"]),
    ).not.toThrow();
  });

  it("contains a libfreenect2 stdout stall watchdog so USB hangs recover", () => {
    const source = readFileSync("scripts/kinect-wall-harp-bridge.mjs", "utf8");

    expect(source).toContain("stallTimeoutMs");
    expect(source).toContain("--stall-timeout-ms");
    expect(source).toContain("lastFrameAt");
    expect(source).toContain("LIBUSB/depth stream stalled");
    expect(source).toContain('child.kill("SIGTERM")');
  });
});
