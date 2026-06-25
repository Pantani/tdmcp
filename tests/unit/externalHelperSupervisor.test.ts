import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runJsonLineHelper } from "../../scripts/external-helper-supervisor.mjs";

function writeHelper(dir: string, body: string) {
  const helper = join(dir, "helper.mjs");
  writeFileSync(helper, `#!/usr/bin/env node\n${body}`);
  chmodSync(helper, 0o755);
  return helper;
}

describe("external helper supervisor", () => {
  it("restarts a stalled JSON-line helper and resolves from the replacement", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-helper-supervisor-"));
    const countPath = join(dir, "count.txt");
    const helper = writeHelper(
      dir,
      `
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const countPath = ${JSON.stringify(countPath)};
const count = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) + 1 : 1;
writeFileSync(countPath, String(count));
process.on("SIGTERM", () => process.exit(143));

if (count === 1) {
  console.log(JSON.stringify({ frame: 1 }));
  setInterval(() => {}, 1000);
} else {
  console.log(JSON.stringify({ frame: 2 }));
  console.log(JSON.stringify({ frame: 3 }));
  process.exit(0);
}
`,
    );
    const frames: unknown[] = [];
    const logs: string[] = [];

    try {
      await runJsonLineHelper({
        command: helper,
        stallTimeoutMs: 800,
        stallCheckIntervalMs: 50,
        killGraceMs: 100,
        maxRestarts: 3,
        onJson: (frame) => frames.push(frame),
        log: (line) => logs.push(line),
        formatStallMessage: ({ silenceMs }) => `stalled for ${silenceMs}ms; restarting`,
      });

      expect(frames).toEqual([{ frame: 1 }, { frame: 2 }, { frame: 3 }]);
      expect(readFileSync(countPath, "utf8")).toBe("2");
      expect(logs.join("\n")).toContain("stalled for");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("kills and rejects when a stalled helper exceeds the restart limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-helper-supervisor-limit-"));
    const helper = writeHelper(
      dir,
      `
process.on("SIGTERM", () => {});
console.log(JSON.stringify({ frame: 1 }));
setInterval(() => {}, 1000);
`,
    );
    let helperPid = 0;

    try {
      await expect(
        runJsonLineHelper({
          command: helper,
          stallTimeoutMs: 50,
          stallCheckIntervalMs: 10,
          killGraceMs: 25,
          maxRestarts: 0,
          onJson: () => {},
          onStatus: (status) => {
            if (status.type === "start") helperPid = status.pid ?? 0;
          },
        }),
      ).rejects.toThrow("stalled");

      expect(helperPid).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(() => process.kill(helperPid, 0)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits normalized status payloads with stale and frame-age fields", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-helper-supervisor-status-"));
    const helper = writeHelper(
      dir,
      `
process.on("SIGTERM", () => {});
console.log(JSON.stringify({ frame: 1 }));
setInterval(() => {}, 1000);
`,
    );
    const statuses: Array<Record<string, unknown>> = [];

    try {
      await expect(
        runJsonLineHelper({
          command: helper,
          label: "sensor-test",
          stallTimeoutMs: 1200,
          stallCheckIntervalMs: 50,
          killGraceMs: 50,
          maxRestarts: 0,
          onJson: () => {},
          onStatus: (status) => statuses.push(status as unknown as Record<string, unknown>),
          log: () => {},
        }),
      ).rejects.toThrow("stalled");

      expect(statuses.length).toBeGreaterThan(0);
      for (const status of statuses) {
        expect(status).toEqual(
          expect.objectContaining({
            label: "sensor-test",
            restartCount: expect.any(Number),
            ok: expect.any(Boolean),
            stale: expect.any(Boolean),
            startedAtMs: expect.any(Number),
            lastFrameAtMs: expect.any(Number),
            lastFrameAgeMs: expect.any(Number),
          }),
        );
      }
      expect(statuses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "frame", state: "running", stale: false }),
          expect.objectContaining({ type: "stall_limit", state: "stalled", stale: true }),
        ]),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(statuses.at(-1)).toEqual(
        expect.objectContaining({ type: "stall_limit", state: "stalled", stale: true }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
