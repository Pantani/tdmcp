import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("kinect wall harp external bridge script", () => {
  it("passes Node syntax validation", () => {
    expect(() =>
      execFileSync("node", ["--check", "scripts/kinect-wall-harp-bridge.mjs"]),
    ).not.toThrow();
  });

  it("contains a libfreenect2 stdout stall watchdog so USB hangs recover", () => {
    const source = readFileSync("scripts/kinect-wall-harp-bridge.mjs", "utf8");
    const supervisor = readFileSync("scripts/external-helper-supervisor.mjs", "utf8");

    expect(source).toContain("runJsonLineHelper");
    expect(source).toContain("stallTimeoutMs");
    expect(source).toContain("--stall-timeout-ms");
    expect(supervisor).toContain("lastFrameAt");
    expect(source).toContain("LIBUSB/depth stream stalled");
    expect(supervisor).toContain('child.kill("SIGTERM")');
  });

  it("restarts the libfreenect2 helper after a stalled depth stream", () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-kinect-bridge-"));
    const helper = join(dir, "helper.mjs");
    const countPath = join(dir, "count.txt");
    writeFileSync(
      helper,
      `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const countPath = ${JSON.stringify(countPath)};
const count = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) + 1 : 1;
writeFileSync(countPath, String(count));
process.on("SIGTERM", () => process.exit(143));

if (count === 1) {
  console.log(JSON.stringify({ left: { present: 1, x: 0.2, y: 0.3, size: 0.1 } }));
  setInterval(() => {}, 1000);
} else {
  console.log(JSON.stringify({ left: { present: 1, x: 0.4, y: 0.3, size: 0.1 } }));
  console.log(JSON.stringify({ left: { present: 1, x: 0.5, y: 0.3, size: 0.1 } }));
  process.exit(0);
}
`,
    );
    chmodSync(helper, 0o755);

    try {
      const result = spawnSync(
        "node",
        [
          "scripts/kinect-wall-harp-bridge.mjs",
          "--source",
          "libfreenect2",
          "--helper",
          helper,
          "--frames",
          "2",
          "--port",
          "17400",
          "--stall-timeout-ms",
          "10",
        ],
        { encoding: "utf8", timeout: 5000 },
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("LIBUSB/depth stream stalled");
      expect(readFileSync(countPath, "utf8")).toBe("2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes normalized libfreenect2 helper status JSON when requested", () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-kinect-bridge-status-"));
    const helper = join(dir, "helper.mjs");
    const statusPath = join(dir, "status.json");
    writeFileSync(
      helper,
      `#!/usr/bin/env node
console.log(JSON.stringify({ left: { present: 1, x: 0.2, y: 0.3, size: 0.1 } }));
setTimeout(() => process.exit(0), 50);
`,
    );
    chmodSync(helper, 0o755);

    try {
      const result = spawnSync(
        "node",
        [
          "scripts/kinect-wall-harp-bridge.mjs",
          "--source",
          "libfreenect2",
          "--helper",
          helper,
          "--frames",
          "1",
          "--port",
          "17401",
          "--status-json",
          statusPath,
        ],
        { encoding: "utf8", timeout: 5000 },
      );

      expect(result.status).toBe(0);
      const status = JSON.parse(readFileSync(statusPath, "utf8"));
      expect(status).toEqual(
        expect.objectContaining({
          source: "libfreenect2",
          helper,
          label: "kinect-wall-harp-bridge",
          type: "exit",
          state: "exited",
          ok: true,
          stale: false,
          restartCount: 0,
          lastFrameAgeMs: expect.any(Number),
        }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses registered projection diagnostics as the default libfreenect2 crop", () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-kinect-projection-crop-"));
    const helper = join(dir, "helper.mjs");
    const argsPath = join(dir, "helper-args.json");
    const calibrationPath = join(dir, "projection-calibration.json");
    writeFileSync(
      calibrationPath,
      JSON.stringify({
        ok: true,
        registered_projection_present: true,
        registered_projection_bbox: { x0: 0.2, y0: 0.3, x1: 0.8, y1: 0.9 },
      }),
    );
    writeFileSync(
      helper,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ left: { present: 0 }, right: { present: 0 } }));
`,
    );
    chmodSync(helper, 0o755);

    try {
      const result = spawnSync(
        "node",
        [
          "scripts/kinect-wall-harp-bridge.mjs",
          "--source",
          "libfreenect2",
          "--helper",
          helper,
          "--frames",
          "1",
          "--port",
          "17402",
          "--projection-calibration-json",
          calibrationPath,
          "--projection-crop-margin",
          "0.01",
        ],
        { encoding: "utf8", timeout: 5000 },
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("auto projection crop");
      const helperArgs = JSON.parse(readFileSync(argsPath, "utf8"));
      expect(helperArgs).toEqual(
        expect.arrayContaining([
          "--crop-left",
          "0.19",
          "--crop-right",
          "0.81",
          "--crop-top",
          "0.29",
          "--crop-bottom",
          "0.91",
          "--undistort-depth",
        ]),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throttles repeated frame status JSON writes to avoid real-time disk churn", () => {
    const source = readFileSync("scripts/kinect-wall-harp-bridge.mjs", "utf8");

    expect(source).toContain("STATUS_FRAME_WRITE_INTERVAL_MS = 500");
    expect(source).toContain("function shouldWriteStatusJson(status, nowMs)");
    expect(source).toContain('if (status.type !== "frame")');
    expect(source).toContain("if (nowMs - lastStatusWriteAtMs >= STATUS_FRAME_WRITE_INTERVAL_MS)");
    expect(source).toContain("if (!shouldWriteStatusJson(status, nowMs)) return;");
  });

  it("rejects invalid frame limits before entering the run loop", () => {
    const source = readFileSync("scripts/kinect-wall-harp-bridge.mjs", "utf8");

    expect(source).toContain("if (!Number.isInteger(args.frames) || args.frames < 0)");
    expect(source).toContain("throw new Error(`Invalid --frames:");
  });

  it("keeps diagnostic output writes and background readiness honest", () => {
    const source = readFileSync("scripts/kinect-environment-diagnostic.cpp", "utf8");

    expect(source).toContain("cfg.backgroundFrames = std::max(1, cfg.backgroundFrames)");
    expect(source).toContain("if (std::rename(tmp.c_str(), path.c_str()) != 0)");
    expect(source).toContain('throw std::runtime_error("failed to rename " + tmp + " to " + path)');
    expect(source).toContain("catch (const std::exception& exc) {");
    expect(source).toContain(
      'std::cerr << "[kinect-environment-diagnostic] " << exc.what() << std::endl;',
    );
  });

  it("preserves Kinect open-hand and extremity fields in the OSC contract", () => {
    const source = readFileSync("scripts/kinect-wall-harp-bridge.mjs", "utf8");

    expect(source).toContain("HAND_OSC_FIELDS");
    expect(source).toContain("--projection-calibration-json");
    expect(source).toContain("registered_projection_bbox");
    expect(source).toContain("Projection calibration JSON has no registered projection");
    expect(source).toContain('"open_score"');
    expect(source).toContain('"raw_x"');
    expect(source).toContain('"raw_y"');
    expect(source).toContain('"min_x"');
    expect(source).toContain('"max_y"');
    expect(source).toContain('"center_x"');
    expect(source).toContain('clampedHandValue(raw, ["raw_x", "rawX", "x"], 0)');
    expect(source).toContain('clampedHandValue(raw, ["raw_y", "rawY", "y"], 0)');
    expect(source).toContain('clampedHandValue(raw, ["open_score", "openScore", "palm_open"], 0)');
  });

  it("emits raw blob position, extremities and open score from the native Kinect helper", () => {
    const source = readFileSync("scripts/kinect-wall-harp-depth-bridge.cpp", "utf8");

    expect(source).toContain("float rawX = 0.0f;");
    expect(source).toContain("h.rawX = clamp01(rawX);");
    expect(source).toContain('<< ",\\"raw_x\\":" << hand.rawX');
    expect(source).toContain("float openScore = 0.0f;");
    expect(source).toContain("minSx = std::min(minSx, x);");
    expect(source).toContain('<< ",\\"open_score\\":" << hand.openScore');
    expect(source).toContain('<< ",\\"min_x\\":" << hand.minX');
    expect(source).toContain("const float spanScore = clamp01");
  });

  it("separates Kinect depth warm-up frames from detection output limits", () => {
    const source = readFileSync("scripts/kinect-wall-harp-depth-bridge.cpp", "utf8");

    expect(source).toContain("int rawFrameCount = 0;");
    expect(source).toContain("int outputFrameCount = 0;");
    expect(source).toContain("while (cfg.frames == 0 || outputFrameCount < cfg.frames)");
    expect(source).toContain("cfg.wallMm <= 0.0F && rawFrameCount < cfg.calibrationFrames");
    expect(source).toContain(
      "wallMm = wallMm <= 0.0F ? measured : wallMm * 0.85F + measured * 0.15F;",
    );
    expect(source).toContain("outputFrameCount += 1;");
  });
});
