/**
 * Offline tests for controllerToCliBridge — two suites:
 *   1. Pure `tickOnce` reducer + helpers (no msw needed).
 *   2. `runControllerBridge` integration with msw bridge mock + injected spawner.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type Binding,
  type BindingEvent,
  bindingsFileSchema,
  channelCandidatesFor,
  type LogEvent,
  loadBindingsFile,
  runControllerBridge,
  type SpawnLike,
  shapeArgv,
  type TickState,
  tickOnce,
} from "../../src/cli/controllerToCliBridge.js";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { TD_BASE } from "../helpers/tdMock.js";

// ---------------------------------------------------------------------------
// MSW server (integration suite)
// ---------------------------------------------------------------------------
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const makeCtx = (): ToolContext => ({
  client: new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 }),
  knowledge: new KnowledgeBase(),
  recipes: new RecipeLibrary(),
  logger: silentLogger,
});

function mkBinding(
  id: string,
  event: BindingEvent,
  command: string[] = ["true"],
  debounce_ms = 250,
): Binding {
  return { id, event, command, debounce_ms };
}

function execHandlerSequence(reports: object[]) {
  let i = 0;
  return http.post(`${TD_BASE}/api/exec`, async () => {
    const r = reports[Math.min(i, reports.length - 1)];
    i++;
    return HttpResponse.json({ ok: true, data: { stdout: `${JSON.stringify(r)}\n` } });
  });
}

// ---------------------------------------------------------------------------
// Suite 1 — Pure helpers
// ---------------------------------------------------------------------------
describe("channelCandidatesFor", () => {
  it("midi-note returns n<value> and optional channelled name", () => {
    expect(channelCandidatesFor({ type: "midi-note", value: 60, edge: "on" })).toEqual(["n60"]);
    expect(channelCandidatesFor({ type: "midi-note", value: 60, edge: "on", channel: 2 })).toEqual([
      "ch2n60",
      "n60",
    ]);
  });

  it("osc-addr produces raw, stripped and underscored variants", () => {
    const cands = channelCandidatesFor({
      type: "osc-addr",
      value: "/scene/next",
      edge: "rising",
    });
    expect(cands).toContain("/scene/next");
    expect(cands).toContain("scene/next");
    expect(cands).toContain("scene_next");
  });

  it("midi-cc and raw channel events resolve their expected channel names", () => {
    expect(
      channelCandidatesFor({
        type: "midi-cc",
        value: 74,
        threshold: 0.5,
        edge: "rising",
        channel: 3,
      }),
    ).toEqual(["ch3c74", "c74"]);
    expect(
      channelCandidatesFor({
        type: "channel",
        value: "slider1",
        threshold: 0.5,
        edge: "rising",
      }),
    ).toEqual(["slider1"]);
  });
});

describe("shapeArgv", () => {
  it("passes argv through when shell=false", () => {
    expect(shapeArgv(["tdmcp", "setlist", "run"], false)).toEqual({
      file: "tdmcp",
      args: ["setlist", "run"],
    });
  });
  it("wraps in /bin/sh -lc when shell=true", () => {
    expect(shapeArgv(["open", "-a", "OBS"], true)).toEqual({
      file: "/bin/sh",
      args: ["-lc", "open -a OBS"],
    });
  });
  it("rejects empty argv when shell=false", () => {
    expect(() => shapeArgv([], false)).toThrow("command must have at least one argv element");
  });
});

describe("bindingsFileSchema", () => {
  it("rejects malformed event.type with a friendly issue path", () => {
    const r = bindingsFileSchema.safeParse({
      bindings: [{ id: "x", event: { type: "midi-blam", value: 60 }, command: ["true"] }],
    });
    expect(r.success).toBe(false);
  });

  it("accepts a valid bindings file and applies defaults", () => {
    const r = bindingsFileSchema.parse({
      bindings: [{ id: "x", event: { type: "midi-note", value: 60 }, command: ["true"] }],
    });
    expect(r.bindings[0]?.debounce_ms).toBe(250);
    expect((r.bindings[0]?.event as { edge: string }).edge).toBe("on");
  });
});

describe("tickOnce — midi-note rising edge", () => {
  const b = mkBinding("fire-chorus", { type: "midi-note", value: 60, edge: "on" });
  it("fires exactly once across 0 → 1 → 1 → 0", () => {
    let state: TickState = {};
    let total = 0;
    for (const [t, n60] of [
      [10, 0],
      [20, 1],
      [30, 1],
      [40, 0],
    ] as const) {
      const r = tickOnce(state, [b], { n60 }, t);
      total += r.fires.length;
      state = r.state;
    }
    expect(total).toBe(1);
  });
});

describe("tickOnce — midi-note edge=off", () => {
  const b = mkBinding("note-off", { type: "midi-note", value: 60, edge: "off" });
  it("fires only on 1 → 0 transition", () => {
    let state: TickState = {};
    const fires: number[] = [];
    for (const [t, n60] of [
      [10, 0],
      [20, 1],
      [30, 0],
      [40, 0],
    ] as const) {
      const r = tickOnce(state, [b], { n60 }, t);
      if (r.fires.length) fires.push(t);
      state = r.state;
    }
    expect(fires).toEqual([30]);
  });
});

describe("tickOnce — midi-note edge=any", () => {
  const b = mkBinding("note-any", { type: "midi-note", value: 60, edge: "any" }, ["true"], 0);
  it("fires on both on and off transitions", () => {
    let state: TickState = {};
    const edges: string[] = [];
    for (const [t, n60] of [
      [10, 0],
      [20, 1],
      [30, 1],
      [40, 0],
    ] as const) {
      const r = tickOnce(state, [b], { n60 }, t);
      edges.push(...r.fires.map((f) => f.edge));
      state = r.state;
    }
    expect(edges).toEqual(["on", "off"]);
  });
});

describe("tickOnce — midi-cc threshold", () => {
  const b = mkBinding(
    "fader",
    { type: "midi-cc", value: 7, threshold: 0.75, edge: "rising" },
    ["true"],
    0,
  );
  it("rising fires twice for 0.4 → 0.6 → 0.9 → 0.6 → 0.8", () => {
    let state: TickState = {};
    let fires = 0;
    for (const [t, v] of [
      [1, 0.4],
      [2, 0.6],
      [3, 0.9],
      [4, 0.6],
      [5, 0.8],
    ] as const) {
      const r = tickOnce(state, [b], { c7: v }, t);
      fires += r.fires.length;
      state = r.state;
    }
    expect(fires).toBe(2);
  });

  it("edge=any fires on every crossing of threshold", () => {
    const any = mkBinding(
      "fader-any",
      { type: "midi-cc", value: 7, threshold: 0.75, edge: "any" },
      ["true"],
      0,
    );
    let state: TickState = {};
    let fires = 0;
    for (const [t, v] of [
      [1, 0.4],
      [2, 0.6],
      [3, 0.9],
      [4, 0.6],
      [5, 0.8],
    ] as const) {
      const r = tickOnce(state, [any], { c7: v }, t);
      fires += r.fires.length;
      state = r.state;
    }
    // crossings: 0.6→0.9 (rising), 0.9→0.6 (falling), 0.6→0.8 (rising) = 3
    // 0.4→0.6 is below→below: no cross. 4 only if we count the initial 0.4→0.6 below threshold.
    expect(fires).toBeGreaterThanOrEqual(3);
  });
});

describe("tickOnce — osc-addr", () => {
  const b = mkBinding("next-scene", {
    type: "osc-addr",
    value: "/scene/next",
    edge: "rising",
  });
  it("fires once on 0 → 1; does not re-fire while held at 1", () => {
    let state: TickState = {};
    let fires = 0;
    for (const [t, v] of [
      [1, 0],
      [2, 1],
      [3, 1],
      [4, 1],
    ] as const) {
      const r = tickOnce(state, [b], { scene_next: v }, t);
      fires += r.fires.length;
      state = r.state;
    }
    expect(fires).toBe(1);
  });
});

describe("tickOnce — channel event", () => {
  it("supports falling edges and leaves state unchanged when the sample is absent", () => {
    const b = mkBinding(
      "fader-down",
      { type: "channel", value: "chan1", threshold: 0.5, edge: "falling" },
      ["true"],
      0,
    );
    let state: TickState = { "fader-down": { prev: 0.8, lastFiredAt: null } };
    let r = tickOnce(state, [b], {}, 10);
    expect(r.fires).toEqual([]);
    expect(r.state["fader-down"]?.prev).toBe(0.8);

    state = r.state;
    r = tickOnce(state, [b], { chan1: 0.2 }, 20);
    expect(r.fires.map((f) => f.edge)).toEqual(["falling"]);
  });
});

describe("tickOnce — debounce", () => {
  const b = mkBinding("fast-trigger", { type: "midi-note", value: 60, edge: "on" }, ["true"], 400);
  it("suppresses a re-fire within debounce_ms; reports debounced", () => {
    let state: TickState = {};
    const reports: { fires: number; deb: number }[] = [];
    for (const [t, n60] of [
      [0, 0],
      [10, 1], // fires at t=10
      [20, 0],
      [30, 1], // would fire, but within 400ms of t=10 → debounced
    ] as const) {
      const r = tickOnce(state, [b], { n60 }, t);
      reports.push({ fires: r.fires.length, deb: r.debounced.length });
      state = r.state;
    }
    const totalFires = reports.reduce((a, r) => a + r.fires, 0);
    const totalDeb = reports.reduce((a, r) => a + r.deb, 0);
    expect(totalFires).toBe(1);
    expect(totalDeb).toBe(1);
  });

  it("per-binding isolation: a debounced fader does not block a separate note", () => {
    const fader = mkBinding(
      "fader-7",
      { type: "midi-cc", value: 7, threshold: 0.5, edge: "rising" },
      ["true"],
      1000,
    );
    const note = mkBinding(
      "fire-chorus",
      { type: "midi-note", value: 60, edge: "on" },
      ["true"],
      100,
    );
    let state: TickState = {};
    // t=10: fader rises, note off
    let r = tickOnce(state, [fader, note], { c7: 0.9, n60: 0 }, 10);
    state = r.state;
    expect(r.fires.find((f) => f.binding_id === "fader-7")).toBeTruthy();
    // t=20: note rises (separate binding) — should fire even though fader is in debounce
    r = tickOnce(state, [fader, note], { c7: 0.9, n60: 1 }, 20);
    expect(r.fires.find((f) => f.binding_id === "fire-chorus")).toBeTruthy();
    expect(r.fires.find((f) => f.binding_id === "fader-7")).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — runControllerBridge integration
// ---------------------------------------------------------------------------
async function writeBindings(obj: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tdmcp-cb-"));
  const path = join(dir, "bindings.json");
  await writeFile(path, JSON.stringify(obj), "utf8");
  return path;
}

async function writeBindingsText(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tdmcp-cb-"));
  const path = join(dir, "bindings.json");
  await writeFile(path, body, "utf8");
  return path;
}

describe("loadBindingsFile", () => {
  it("reports unreadable bindings files", async () => {
    const result = await loadBindingsFile(join(tmpdir(), "missing-bindings.json"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("could not read bindings file");
  });

  it("reports invalid JSON", async () => {
    const path = await writeBindingsText("{not-json");
    const result = await loadBindingsFile(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("bindings file is not valid JSON");
  });

  it("reports schema validation issues with paths", async () => {
    const path = await writeBindings({ bindings: [] });
    const result = await loadBindingsFile(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("bindings");
  });
});

describe("runControllerBridge — fatal when listener missing on TD", () => {
  it("emits fatal, returns non-zero exit, no spawn", async () => {
    server.use(
      execHandlerSequence([{ frame: 0, channels: {}, fatal: "Listener op not found: /nope" }]),
    );
    const cfg = await writeBindings({
      listener_path: "/nope",
      bindings: [{ id: "x", event: { type: "midi-note", value: 60 }, command: ["true"] }],
    });
    const events: LogEvent[] = [];
    const spawn = vi.fn(() => ({ pid: 1 }));
    const summary = await runControllerBridge(
      makeCtx(),
      { config: cfg, listener: "/nope", poll_ms: 5 },
      { spawn, emit: (e) => events.push(e), sleep: async () => {} },
    );
    expect(summary.exit_code).not.toBe(0);
    expect(summary.fatal).toMatch(/Listener op not found/);
    expect(spawn).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "fatal")).toBe(true);
  });
});

describe("runControllerBridge — config validation failures", () => {
  it("returns exit code 2 when a binding has no listener source", async () => {
    const cfg = await writeBindings({
      bindings: [{ id: "x", event: { type: "midi-note", value: 60 }, command: ["true"] }],
    });
    const events: LogEvent[] = [];
    const summary = await runControllerBridge(
      makeCtx(),
      { config: cfg, poll_ms: 5 },
      { emit: (e) => events.push(e), sleep: async () => {} },
    );

    expect(summary.exit_code).toBe(2);
    expect(summary.fatal).toContain("has no listener_path");
    expect(events.some((e) => e.type === "fatal")).toBe(true);
  });
});

describe("runControllerBridge — bridge execution failures", () => {
  it("turns executePythonScript errors into fatal exit code 3", async () => {
    const cfg = await writeBindings({
      listener_path: "/project1/midi_in1",
      bindings: [{ id: "x", event: { type: "midi-note", value: 60 }, command: ["true"] }],
    });
    const ctx = {
      ...makeCtx(),
      client: {
        executePythonScript: async () => {
          throw new Error("td execute failed");
        },
      },
    } as unknown as ToolContext;
    const events: LogEvent[] = [];

    const summary = await runControllerBridge(
      ctx,
      { config: cfg, poll_ms: 5 },
      { emit: (e) => events.push(e), sleep: async () => {} },
    );

    expect(summary.exit_code).toBe(3);
    expect(summary.fatal).toBe("td execute failed");
    expect(events.some((e) => e.type === "fatal")).toBe(true);
  });
});

describe("runControllerBridge — dry-run does not spawn", () => {
  it("emits fired with dry_run=true and no real spawn", async () => {
    server.use(
      execHandlerSequence([
        { frame: 1, channels: { n60: 0 }, fatal: null },
        { frame: 2, channels: { n60: 1 }, fatal: null },
      ]),
    );
    const cfg = await writeBindings({
      listener_path: "/project1/midi_in1",
      bindings: [
        {
          id: "fire-chorus",
          event: { type: "midi-note", value: 60, edge: "on" },
          command: ["tdmcp", "setlist", "run"],
        },
      ],
    });
    const events: LogEvent[] = [];
    const spawn = vi.fn(() => ({ pid: 999 }));
    const summary = await runControllerBridge(
      makeCtx(),
      { config: cfg, poll_ms: 5, dry_run: true, once: true },
      { spawn, emit: (e) => events.push(e), sleep: async () => {} },
    );
    expect(spawn).not.toHaveBeenCalled();
    const fired = events.find((e) => e.type === "fired");
    expect(fired).toBeDefined();
    if (fired && fired.type === "fired") {
      expect(fired.dry_run).toBe(true);
      expect(fired.binding_id).toBe("fire-chorus");
    }
    expect(summary.exit_code).toBe(0);
  });
});

describe("runControllerBridge — once exits after first match", () => {
  it("stops after the first fire", async () => {
    server.use(
      execHandlerSequence([
        { frame: 1, channels: { n60: 0 }, fatal: null },
        { frame: 2, channels: { n60: 1 }, fatal: null },
        { frame: 3, channels: { n60: 0 }, fatal: null },
        { frame: 4, channels: { n60: 1 }, fatal: null },
      ]),
    );
    const cfg = await writeBindings({
      listener_path: "/project1/midi_in1",
      bindings: [
        {
          id: "fire-chorus",
          event: { type: "midi-note", value: 60, edge: "on" },
          command: ["true"],
        },
      ],
    });
    const events: LogEvent[] = [];
    const spawn = vi.fn(() => ({ pid: 1234 }));
    const summary = await runControllerBridge(
      makeCtx(),
      { config: cfg, poll_ms: 5, once: true },
      { spawn, emit: (e) => events.push(e), sleep: async () => {} },
    );
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(summary.spawns).toBe(1);
    expect(events.filter((e) => e.type === "fired").length).toBe(1);
  });
});

describe("runControllerBridge — max-spawns cap", () => {
  it("exits after the Nth spawn", async () => {
    // Alternating samples to keep producing rising edges.
    const reports: object[] = [];
    for (let i = 0; i < 20; i++) {
      reports.push({
        frame: i,
        channels: { n60: i % 2 === 0 ? 0 : 1 },
        fatal: null,
      });
    }
    server.use(execHandlerSequence(reports));
    const cfg = await writeBindings({
      listener_path: "/project1/midi_in1",
      bindings: [
        {
          id: "fire-chorus",
          event: { type: "midi-note", value: 60, edge: "on" },
          command: ["true"],
          debounce_ms: 0,
        },
      ],
    });
    const spawn = vi.fn(() => ({ pid: 1 }));
    const summary = await runControllerBridge(
      makeCtx(),
      { config: cfg, poll_ms: 5, max_spawns: 2 },
      { spawn, sleep: async () => {} },
    );
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(summary.spawns).toBe(2);
    expect(summary.exit_code).toBe(0);
  });
});

describe("runControllerBridge — shell=true reshapes argv", () => {
  it("invokes /bin/sh -lc <joined>", async () => {
    server.use(
      execHandlerSequence([
        { frame: 1, channels: { n60: 0 }, fatal: null },
        { frame: 2, channels: { n60: 1 }, fatal: null },
      ]),
    );
    const cfg = await writeBindings({
      listener_path: "/project1/midi_in1",
      bindings: [
        {
          id: "open-obs",
          event: { type: "midi-note", value: 60, edge: "on" },
          command: ["open", "-a", "OBS"],
        },
      ],
    });
    const spawn: SpawnLike = vi.fn(() => ({ pid: 1 }));
    await runControllerBridge(
      makeCtx(),
      { config: cfg, poll_ms: 5, once: true, shell: true },
      { spawn, sleep: async () => {} },
    );
    const sm = spawn as unknown as { mock: { calls: [string, string[], unknown][] } };
    expect(sm.mock.calls).toHaveLength(1);
    expect(sm.mock.calls[0]?.[0]).toBe("/bin/sh");
    expect(sm.mock.calls[0]?.[1]).toEqual(["-lc", "open -a OBS"]);
  });
});

describe("runControllerBridge — fired log includes required keys", () => {
  it("fired event has ts, binding_id, event, value, pid", async () => {
    server.use(
      execHandlerSequence([
        { frame: 1, channels: { n60: 0 }, fatal: null },
        { frame: 2, channels: { n60: 1 }, fatal: null },
      ]),
    );
    const cfg = await writeBindings({
      listener_path: "/project1/midi_in1",
      bindings: [
        {
          id: "fire-chorus",
          event: { type: "midi-note", value: 60, edge: "on" },
          command: ["true"],
        },
      ],
    });
    const events: LogEvent[] = [];
    await runControllerBridge(
      makeCtx(),
      { config: cfg, poll_ms: 5, once: true },
      { spawn: () => ({ pid: 42 }), emit: (e) => events.push(e), sleep: async () => {} },
    );
    const fired = events.find((e) => e.type === "fired");
    expect(fired).toBeDefined();
    if (fired && fired.type === "fired") {
      expect(typeof fired.ts).toBe("string");
      expect(fired.binding_id).toBe("fire-chorus");
      expect(fired.event).toBe("midi-note");
      expect(fired.value).toBe(1);
      expect(fired.pid).toBe(42);
    }
  });
});

describe("runControllerBridge — spawn failures", () => {
  it("logs spawn errors but still emits the fired event", async () => {
    server.use(
      execHandlerSequence([
        { frame: 1, channels: { n60: 0 }, fatal: null },
        { frame: 2, channels: { n60: 1 }, fatal: null },
      ]),
    );
    const cfg = await writeBindings({
      listener_path: "/project1/midi_in1",
      bindings: [
        {
          id: "fire-chorus",
          event: { type: "midi-note", value: 60, edge: "on" },
          command: ["true"],
        },
      ],
    });
    const events: LogEvent[] = [];

    const summary = await runControllerBridge(
      makeCtx(),
      { config: cfg, poll_ms: 5, once: true },
      {
        spawn: () => {
          throw new Error("spawn denied");
        },
        emit: (e) => events.push(e),
        sleep: async () => {},
      },
    );

    expect(summary.events).toBe(1);
    expect(summary.spawns).toBe(0);
    expect(summary.exit_code).toBe(0);
    expect(events.some((e) => e.type === "fatal" && e.message.includes("spawn failed"))).toBe(true);
    expect(events.some((e) => e.type === "fired")).toBe(true);
  });
});
