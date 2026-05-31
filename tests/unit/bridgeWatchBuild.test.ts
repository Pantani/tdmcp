import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridgeWatchBuildSchema, runBridgeWatchBuild } from "../../src/cli/bridgeWatchBuild.js";

// ---- mock chokidar ----

class MockWatcher extends EventEmitter {
  close = vi.fn().mockResolvedValue(undefined);
}

// Use a container object so the hoisted vi.mock factory and test code share the same reference.
const watcherBox: { current: MockWatcher | undefined } = { current: undefined };

vi.mock("chokidar", () => {
  const { EventEmitter: EE } = require("node:events");
  class W extends EE {
    close = vi.fn().mockResolvedValue(undefined);
  }
  const makeWatcher = () => {
    const w = new W();
    watcherBox.current = w as unknown as MockWatcher;
    return w;
  };
  return {
    default: { watch: vi.fn(makeWatcher) },
    watch: vi.fn(makeWatcher),
  };
});

// ---- mock child_process ----

type SpawnMockCall = { cmd: string; args: string[] };

interface MockChild extends EventEmitter {
  kill: ReturnType<typeof vi.fn>;
  _resolve: (code: number) => void;
}

const spawnCalls: SpawnMockCall[] = [];
let spawnMocks: Array<{ exitCode: number }> = [];
let spawnMockIdx = 0;
const activeChildren: MockChild[] = [];

vi.mock("node:child_process", () => ({
  spawn: vi.fn((cmd: string, args: string[]) => {
    spawnCalls.push({ cmd, args });
    const child = new EventEmitter() as MockChild;
    child.kill = vi.fn();
    activeChildren.push(child);
    const mockDef = spawnMocks[spawnMockIdx] ?? { exitCode: 0 };
    spawnMockIdx++;
    // resolve on next tick unless exitCode is -1 (stays pending)
    if (mockDef.exitCode !== -1) {
      setTimeout(() => child.emit("close", mockDef.exitCode), 0);
    }
    return child;
  }),
}));

// ---- mock createRequire ----

vi.mock("node:module", () => ({
  createRequire: vi.fn(() => ({
    resolve: vi.fn((p: string) => `/mock/node_modules/.bin/${p.split("/").pop()}`),
  })),
}));

function resetSpawn(mocks: Array<{ exitCode: number }> = []) {
  spawnCalls.length = 0;
  activeChildren.length = 0;
  spawnMocks = mocks;
  spawnMockIdx = 0;
  watcherBox.current = undefined;
}

describe("bridgeWatchBuildSchema", () => {
  it("returns correct defaults for empty input", () => {
    const result = bridgeWatchBuildSchema.parse({});
    expect(result).toMatchObject({
      paths: ["src", "td"],
      debounceMs: 300,
      runOn: "both",
      clearScreen: true,
      once: false,
    });
    expect(result.ignore).toContain("**/node_modules/**");
  });

  it("rejects negative debounceMs", () => {
    expect(() => bridgeWatchBuildSchema.parse({ debounceMs: -1 })).toThrow();
  });

  it("rejects invalid runOn", () => {
    expect(() => bridgeWatchBuildSchema.parse({ runOn: "bogus" })).toThrow();
  });
});

describe("runBridgeWatchBuild (once mode)", () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetSpawn();
  });

  it("--once: tsc exit 0 + tsup exit 0 → returns 0", async () => {
    resetSpawn([{ exitCode: 0 }, { exitCode: 0 }]);
    const code = await runBridgeWatchBuild(["--once"]);
    expect(code).toBe(0);
    expect(spawnCalls).toHaveLength(2);
    const tscCall = spawnCalls[0];
    expect(tscCall).toBeDefined();
    expect(tscCall?.args).toContain("--noEmit");
    const tsupCall = spawnCalls[1];
    expect(tsupCall).toBeDefined();
    // tsup called with only the bin path, no extra args after it
    const tsupArgs = tsupCall?.args.filter((a) => !a.endsWith("tsup"));
    expect(tsupArgs).toHaveLength(0);
  });

  it("--once: tsc exit 1 → returns 1 and tsup is never spawned", async () => {
    resetSpawn([{ exitCode: 1 }]);
    const code = await runBridgeWatchBuild(["--once"]);
    expect(code).toBe(1);
    expect(spawnCalls).toHaveLength(1);
  });

  it("--once: tsc exit 0 + tsup exit 2 → returns 2", async () => {
    resetSpawn([{ exitCode: 0 }, { exitCode: 2 }]);
    const code = await runBridgeWatchBuild(["--once", "--run-on", "both"]);
    expect(code).toBe(2);
  });

  it("--once --run-on typecheck: only tsc spawned", async () => {
    resetSpawn([{ exitCode: 0 }]);
    const code = await runBridgeWatchBuild(["--once", "--run-on", "typecheck"]);
    expect(code).toBe(0);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.args).toContain("--noEmit");
  });

  it("--once --run-on build: only tsup spawned (no --noEmit)", async () => {
    resetSpawn([{ exitCode: 0 }]);
    await runBridgeWatchBuild(["--once", "--run-on", "build"]);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.args).not.toContain("--noEmit");
  });

  it("invalid args → returns 2 without spawning", async () => {
    resetSpawn([]);
    const code = await runBridgeWatchBuild(["--debounce-ms", "-1"]);
    expect(code).toBe(2);
    expect(spawnCalls).toHaveLength(0);
  });

  it("clearScreen=false suppresses \\x1Bc write", async () => {
    resetSpawn([{ exitCode: 0 }, { exitCode: 0 }]);
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runBridgeWatchBuild(["--once", "--no-clear"]);
    const calls = writeSpy.mock.calls.map((c) => c[0]);
    const hasEsc = calls.some((s) => typeof s === "string" && s.includes("\x1Bc"));
    expect(hasEsc).toBe(false);
  });
});

describe("runBridgeWatchBuild (watch mode)", () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetSpawn();
  });

  /** Flush microtasks until watcherBox.current is defined (up to 200 ms real time). */
  async function waitForWatcher(ms = 200): Promise<void> {
    const deadline = Date.now() + ms;
    while (watcherBox.current === undefined && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    if (watcherBox.current === undefined) throw new Error("watcher never created");
  }

  it("debounce: 5 rapid changes coalesce into one spawn call (debounce=50ms)", async () => {
    resetSpawn([{ exitCode: 0 }, { exitCode: 0 }]);
    // Use a short debounce so the test completes quickly with real timers.
    const watchPromise = runBridgeWatchBuild(["--debounce-ms", "50"]);
    await waitForWatcher();
    const watcher = watcherBox.current;
    if (!watcher) throw new Error("watcher not initialised");

    // emit 5 changes quickly — all within the 50 ms debounce window
    for (let i = 0; i < 5; i++) {
      watcher.emit("change", `src/file${i}.ts`);
    }
    // wait for debounce to fire + spawns to settle
    await new Promise((r) => setTimeout(r, 200));
    // only one pipeline run (2 spawns: tsc + tsup)
    const tscCalls = spawnCalls.filter((c) => c.args.includes("--noEmit"));
    expect(tscCalls).toHaveLength(1);
    expect(spawnCalls).toHaveLength(2);

    // cleanup
    process.emit("SIGINT");
    await Promise.race([watchPromise, new Promise((r) => setTimeout(r, 100))]);
  });

  it("SIGINT closes watcher and returns 0", async () => {
    resetSpawn([{ exitCode: 0 }]);
    const watchPromise = runBridgeWatchBuild(["--debounce-ms", "50"]);
    await waitForWatcher();
    const watcher = watcherBox.current;
    if (!watcher) throw new Error("watcher not initialised");

    // Give the event loop a tick so the SIGINT listener is registered.
    await new Promise((r) => setTimeout(r, 10));
    process.emit("SIGINT");
    // Allow close().then(resolveMain) to propagate.
    await new Promise((r) => setTimeout(r, 50));
    const code = await Promise.race([
      watchPromise,
      new Promise<number>((r) => setTimeout(() => r(99), 300)),
    ]);
    expect(watcher.close).toHaveBeenCalledTimes(1);
    expect(code).toBe(0);
  });
});
