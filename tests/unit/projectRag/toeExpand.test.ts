import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runToeExpand } from "../../../src/projectRag/extractors/toeExpand.js";

interface FakeChildController {
  child: ChildProcess;
  emitStdout: (s: string) => void;
  emitStderr: (s: string) => void;
  emitClose: (code: number | null) => void;
  emitError: (err: NodeJS.ErrnoException) => void;
}

function makeFakeChild(): FakeChildController {
  const emitter = new EventEmitter() as ChildProcess;
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  // Cast to set readonly-ish props on the EE-as-child.
  (emitter as unknown as { stdout: Readable }).stdout = stdout;
  (emitter as unknown as { stderr: Readable }).stderr = stderr;
  (emitter as unknown as { pid: number | undefined }).pid = 999999;

  return {
    child: emitter,
    emitStdout: (s) => stdout.push(Buffer.from(s, "utf8")),
    emitStderr: (s) => stderr.push(Buffer.from(s, "utf8")),
    emitClose: (code) => {
      stdout.push(null);
      stderr.push(null);
      emitter.emit("close", code);
    },
    emitError: (err) => {
      emitter.emit("error", err);
    },
  };
}

interface FakeSpawnSetup {
  spawnImpl: typeof nodeSpawn;
  controller: FakeChildController;
  calls: Array<{ cmd: string; args: string[]; cwd: string | undefined }>;
}

function setupFakeSpawn(scenario: (c: FakeChildController) => void): FakeSpawnSetup {
  const controller = makeFakeChild();
  const calls: FakeSpawnSetup["calls"] = [];
  const spawnImpl = ((cmd: string, args: readonly string[], options?: { cwd?: string }) => {
    calls.push({ cmd, args: [...args], cwd: options?.cwd });
    // Defer event emission so the consumer can attach listeners first.
    setImmediate(() => scenario(controller));
    return controller.child;
  }) as unknown as typeof nodeSpawn;
  return { spawnImpl, controller, calls };
}

let workDir: string;
let artifactPath: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "toeexpand-test-"));
  artifactPath = path.join(workDir, "sample.toe");
  writeFileSync(artifactPath, "fake-toe-bytes");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("runToeExpand", () => {
  it("returns skipped when the binary is missing (ENOENT)", async () => {
    const tmpDirBase = mkdtempSync(path.join(tmpdir(), "toeexpand-base-"));
    const { spawnImpl } = setupFakeSpawn((c) => {
      const err = new Error("not found") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      c.emitError(err);
    });

    const result = await runToeExpand({
      artifactPath,
      binaryPath: "toeexpand",
      spawnImpl,
      tmpDirBase,
    });

    expect(result.status).toBe("skipped");
    expect(result.reason).toMatch(/TDMCP_PROJECT_RAG_TOEEXPAND_BIN/);
    rmSync(tmpDirBase, { recursive: true, force: true });
  });

  it("returns ok with parsed opCount on successful exit 0", async () => {
    const ascii = [
      "TouchDesigner ASCII export v1",
      "OP /project1/movie1",
      "OP /project1/comp1",
      "  some metadata",
    ].join("\n");
    const { spawnImpl } = setupFakeSpawn((c) => {
      c.emitStdout(ascii);
      c.emitClose(0);
    });

    const result = await runToeExpand({
      artifactPath,
      binaryPath: "toeexpand",
      spawnImpl,
    });

    expect(result.status).toBe("ok");
    expect(result.opCount).toBe(2);
    expect(result.asciiText).toContain("OP /project1/movie1");
  });

  it("returns failed with stderr text on non-zero exit", async () => {
    const { spawnImpl } = setupFakeSpawn((c) => {
      c.emitStderr("toeexpand: bad header\n");
      c.emitClose(2);
    });

    const result = await runToeExpand({
      artifactPath,
      binaryPath: "toeexpand",
      spawnImpl,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/bad header/);
  });

  it("returns failed with timeout error when the child never closes", async () => {
    const tmpDirBase = mkdtempSync(path.join(tmpdir(), "toeexpand-base-"));
    // Scenario: spawn never emits close/error.
    const { spawnImpl } = setupFakeSpawn(() => {
      // intentionally nothing
    });

    const result = await runToeExpand({
      artifactPath,
      binaryPath: "toeexpand",
      timeoutMs: 50,
      spawnImpl,
      tmpDirBase,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/timeout/i);

    // Quarantine cleanup verified by checking the base contains no surviving subdirs.
    const quarantineRoot = path.join(tmpDirBase, "tdmcp-prag-toe");
    if (existsSync(quarantineRoot)) {
      const { readdirSync } = await import("node:fs");
      expect(readdirSync(quarantineRoot)).toHaveLength(0);
    }
    rmSync(tmpDirBase, { recursive: true, force: true });
  });

  it("rejects a non-absolute artifactPath with status failed", async () => {
    const result = await runToeExpand({
      artifactPath: "relative/path.toe",
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/absolute/);
  });

  it("returns failed when the artifact does not exist", async () => {
    const missing = path.join(workDir, "does-not-exist.toe");
    const result = await runToeExpand({
      artifactPath: missing,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/not found/);
  });

  it("cleans up the quarantine directory after a successful run", async () => {
    const tmpDirBase = mkdtempSync(path.join(tmpdir(), "toeexpand-base-"));
    const { spawnImpl, calls } = setupFakeSpawn((c) => {
      c.emitStdout("OP /project1/movie1\n");
      c.emitClose(0);
    });

    const result = await runToeExpand({
      artifactPath,
      binaryPath: "toeexpand",
      spawnImpl,
      tmpDirBase,
    });

    expect(result.status).toBe("ok");
    // The cwd handed to spawn lived under the per-call quarantine root.
    expect(calls[0]?.cwd).toMatch(/tdmcp-prag-toe/);
    expect(calls[0]?.cwd === undefined ? false : existsSync(calls[0].cwd)).toBe(false);
    // And only the user-supplied basename was passed in.
    expect(calls[0]?.args[0]).toBe("input.toe");
    rmSync(tmpDirBase, { recursive: true, force: true });
  });

  it("passes a reduced env to the subprocess", async () => {
    let seenEnv: Record<string, string | undefined> | undefined;
    const spawnImpl = ((
      _cmd: string,
      _args: readonly string[],
      options: { env?: Record<string, string | undefined> },
    ) => {
      seenEnv = options.env;
      const controller = makeFakeChild();
      setImmediate(() => {
        controller.emitStdout("");
        controller.emitClose(0);
      });
      return controller.child;
    }) as unknown as typeof nodeSpawn;

    await runToeExpand({
      artifactPath,
      binaryPath: "toeexpand",
      spawnImpl,
    });

    expect(seenEnv).toBeDefined();
    expect(Object.keys(seenEnv ?? {}).sort()).toEqual(["HOME", "LANG", "PATH"]);
    expect(seenEnv?.LANG).toBe("C.UTF-8");
  });
});

// Touch unused imports for tools that warn about them in test files.
void mkdirSync;
