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
