import { describe, expect, it } from "vitest";
import { normalize } from "../../src/automation/setlistSchema.js";
import {
  type BeatSource,
  type CueCaller,
  loadCanonicalSetlist,
  type RunnerClock,
  type RunnerEvent,
  runSetlist,
  type Signal,
  type SignalSource,
  setlistRunnerCliSchema,
} from "../../src/cli/setlistRunner.js";
import { TdApiError, TdConnectionError } from "../../src/td-client/types.js";

// ---------- fakes ----------

interface FakeTimer {
  id: number;
  ms: number;
  cb: () => void;
}

class FakeClock implements RunnerClock {
  private nextId = 1;
  private timers: FakeTimer[] = [];
  private current = 0;

  now(): number {
    return this.current;
  }

  setTimeout(cb: () => void, ms: number): unknown {
    const t: FakeTimer = { id: this.nextId++, ms, cb };
    this.timers.push(t);
    return t.id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }

  /** Advance time by `ms`; fire any timers whose deadline elapses. */
  async advance(ms: number): Promise<void> {
    this.current += ms;
    while (true) {
      const t = this.timers.find((x) => x.ms <= ms);
      if (!t) break;
      this.timers = this.timers.filter((x) => x !== t);
      t.cb();
      await flush();
    }
    // remaining timers: subtract elapsed
    this.timers = this.timers.map((t) => ({ ...t, ms: t.ms - ms }));
  }

  pendingMs(): number[] {
    return this.timers.map((t) => t.ms);
  }
}

class FakeBeatSource implements BeatSource {
  private listeners: Array<() => void> = [];

  on(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  async beat(n = 1): Promise<void> {
    for (let i = 0; i < n; i++) {
      for (const l of [...this.listeners]) l();
      await flush();
    }
  }
}

class FakeSignals implements SignalSource {
  private queue: Signal[] = [];
  private waiters: Array<(s: IteratorResult<Signal>) => void> = [];
  private done = false;

  push(s: Signal): void {
    const w = this.waiters.shift();
    if (w) w({ value: s, done: false });
    else this.queue.push(s);
  }

  close(): void {
    this.done = true;
    while (this.waiters.length) {
      const w = this.waiters.shift();
      if (w) w({ value: undefined as unknown as Signal, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Signal> {
    const self = this;
    return {
      next(): Promise<IteratorResult<Signal>> {
        const q = self.queue.shift();
        if (q) return Promise.resolve({ value: q, done: false });
        if (self.done) {
          return Promise.resolve({ value: undefined as unknown as Signal, done: true });
        }
        return new Promise((resolve) => self.waiters.push(resolve));
      },
    };
  }
}

interface FakeCall {
  action: "recall" | "morph";
  comp_path: string;
  name: string;
  duration: number;
  quantize: "off" | "beat" | "bar";
}

class FakeClient implements CueCaller {
  calls: FakeCall[] = [];
  // map cue name -> error to throw
  failures = new Map<string, Error>();
  // single-shot: first call throws
  firstCallError: Error | null = null;

  async fire(args: FakeCall): Promise<void> {
    if (this.firstCallError && this.calls.length === 0) {
      const err = this.firstCallError;
      this.firstCallError = null;
      throw err;
    }
    this.calls.push(args);
    const f = this.failures.get(args.name);
    if (f) throw f;
  }
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

function defaultArgs(over: Partial<ReturnType<typeof setlistRunnerCliSchema.parse>> = {}) {
  return setlistRunnerCliSchema.parse({ setlist: "ignored", ...over });
}

// ---------- tests ----------

describe("setlistRunner", () => {
  it("dry-run plans without calling the client", async () => {
    const setlist = normalize({
      scenes: [
        { cue: "a", hold_seconds: 2, morph_seconds: 1 },
        { cue: "b", hold_seconds: 3, morph_seconds: 0 },
      ],
    });
    const events: RunnerEvent[] = [];
    const clock = new FakeClock();
    const client = new FakeClient();

    const run = runSetlist({
      setlist,
      args: defaultArgs({ dry_run: true }),
      client,
      clock,
      emit: (e) => events.push(e),
    });
    await flush();
    await clock.advance(2000);
    await clock.advance(3000);
    const summary = await run;

    expect(client.calls).toHaveLength(0);
    expect(summary.ended_reason).toBe("complete");
    expect(summary.scenes_fired).toBe(2);
    const fires = events.filter((e) => e.t === "would_fire");
    expect(fires.map((e) => (e.t === "would_fire" ? e.cue : ""))).toEqual(["a", "b"]);
    expect(events.some((e) => e.t === "ended" && e.reason === "complete")).toBe(true);
  });

  it("morph_seconds=0 → recall, >0 → morph with duration", async () => {
    const setlist = normalize({
      scenes: [
        { cue: "snap", hold_seconds: 0, morph_seconds: 0 },
        { cue: "fade", hold_seconds: 0, morph_seconds: 2 },
      ],
    });
    const clock = new FakeClock();
    const client = new FakeClient();
    const events: RunnerEvent[] = [];
    await runSetlist({
      setlist,
      args: defaultArgs(),
      client,
      clock,
      emit: (e) => events.push(e),
    });
    expect(client.calls).toEqual([
      { action: "recall", comp_path: "/project1", name: "snap", duration: 0, quantize: "off" },
      { action: "morph", comp_path: "/project1", name: "fade", duration: 2, quantize: "off" },
    ]);
  });

  it("beat mode advances after N beats", async () => {
    const setlist = normalize({ scenes: [{ cue: "x", hold_beats: 4, morph_seconds: 0 }] });
    const clock = new FakeClock();
    const beats = new FakeBeatSource();
    const client = new FakeClient();
    const events: RunnerEvent[] = [];

    const run = runSetlist({
      setlist,
      args: defaultArgs({ mode: "beat" }),
      client,
      clock,
      beatSource: beats,
      emit: (e) => events.push(e),
    });
    await flush();
    await beats.beat(3);
    expect(events.find((e) => e.t === "advanced")).toBeUndefined();
    await beats.beat(1);
    await run;
    expect(events.some((e) => e.t === "advanced" && e.reason === "beat")).toBe(true);
  });

  it("bars → hold_beats fold (bars=2, beats_per_bar=4 → 8 beats)", async () => {
    const setlist = normalize({ scenes: [{ cue: "x", bars: 2, morph_seconds: 0 }] });
    const clock = new FakeClock();
    const beats = new FakeBeatSource();
    const client = new FakeClient();
    const events: RunnerEvent[] = [];

    const run = runSetlist({
      setlist,
      args: defaultArgs({ mode: "beat", beats_per_bar: 4 }),
      client,
      clock,
      beatSource: beats,
      emit: (e) => events.push(e),
    });
    await flush();
    await beats.beat(7);
    expect(events.find((e) => e.t === "advanced")).toBeUndefined();
    await beats.beat(1);
    await run;
    expect(events.some((e) => e.t === "advanced" && e.reason === "beat")).toBe(true);
  });

  it("manual mode waits for next signal", async () => {
    const setlist = normalize({
      scenes: [
        { cue: "a", morph_seconds: 0 },
        { cue: "b", morph_seconds: 0 },
      ],
    });
    const clock = new FakeClock();
    const client = new FakeClient();
    const signals = new FakeSignals();
    const events: RunnerEvent[] = [];

    const run = runSetlist({
      setlist,
      args: defaultArgs({ mode: "manual" }),
      client,
      clock,
      signals,
      emit: (e) => events.push(e),
    });
    await flush();
    expect(client.calls.map((c) => c.name)).toEqual(["a"]);
    signals.push({ t: "next" });
    await flush();
    await flush();
    expect(client.calls.map((c) => c.name)).toEqual(["a", "b"]);
    signals.push({ t: "next" });
    signals.close();
    await run;
    expect(events.some((e) => e.t === "ended")).toBe(true);
  });

  it("steps mini-loop fires each step in order", async () => {
    const setlist = normalize({
      scenes: [
        {
          steps: [
            { cue: "s1", hold_beats: 2, morph_seconds: 0 },
            { cue: "s2", hold_beats: 2, morph_seconds: 0 },
          ],
          morph_seconds: 0,
        },
      ],
    });
    const clock = new FakeClock();
    const beats = new FakeBeatSource();
    const client = new FakeClient();
    const events: RunnerEvent[] = [];

    const run = runSetlist({
      setlist,
      args: defaultArgs({ mode: "beat" }),
      client,
      clock,
      beatSource: beats,
      emit: (e) => events.push(e),
    });
    await flush();
    expect(client.calls.map((c) => c.name)).toEqual(["s1"]);
    await beats.beat(2);
    expect(client.calls.map((c) => c.name)).toEqual(["s1", "s2"]);
    await beats.beat(2);
    await run;
    expect(events.some((e) => e.t === "ended" && e.reason === "complete")).toBe(true);
  });

  it("stop signal ends the show with reason=stopped", async () => {
    const setlist = normalize({
      scenes: [
        { cue: "a", morph_seconds: 0 },
        { cue: "b", morph_seconds: 0 },
      ],
    });
    const clock = new FakeClock();
    const client = new FakeClient();
    const signals = new FakeSignals();
    const events: RunnerEvent[] = [];

    const run = runSetlist({
      setlist,
      args: defaultArgs({ mode: "manual" }),
      client,
      clock,
      signals,
      emit: (e) => events.push(e),
    });
    await flush();
    signals.push({ t: "stop" });
    const summary = await run;
    expect(summary.ended_reason).toBe("stopped");
    expect(events.some((e) => e.t === "ended" && e.reason === "stopped")).toBe(true);
  });

  it("loop wraps back to scene[0] after the last", async () => {
    const setlist = normalize({
      scenes: [
        { cue: "a", morph_seconds: 0 },
        { cue: "b", morph_seconds: 0 },
      ],
    });
    const clock = new FakeClock();
    const client = new FakeClient();
    const signals = new FakeSignals();
    const events: RunnerEvent[] = [];

    const run = runSetlist({
      setlist,
      args: defaultArgs({ mode: "manual", loop: true }),
      client,
      clock,
      signals,
      emit: (e) => events.push(e),
    });
    await flush();
    signals.push({ t: "next" });
    await flush();
    await flush();
    signals.push({ t: "next" });
    await flush();
    await flush();
    // We should now be back at scene[0] firing "a" again.
    expect(client.calls.map((c) => c.name)).toEqual(["a", "b", "a"]);
    signals.push({ t: "stop" });
    await run;
  });

  it("one bad cue → fail-forward (warn + continue)", async () => {
    const setlist = normalize({
      scenes: [
        { cue: "missing", hold_seconds: 0, morph_seconds: 0 },
        { cue: "ok", hold_seconds: 0, morph_seconds: 0 },
      ],
    });
    const clock = new FakeClock();
    const client = new FakeClient();
    client.failures.set("missing", new TdApiError("cue 'missing' not found", { status: 400 }));
    const events: RunnerEvent[] = [];
    const summary = await runSetlist({
      setlist,
      args: defaultArgs(),
      client,
      clock,
      emit: (e) => events.push(e),
    });
    expect(summary.ended_reason).toBe("complete");
    expect(events.some((e) => e.t === "warning" && e.cue === "missing")).toBe(true);
    // ok still fired (note: client.calls includes the failing attempt because the
    // fake records it before throwing)
    expect(client.calls.map((c) => c.name)).toContain("ok");
  });

  it("bridge offline → degrades to dry-run for the rest of the show", async () => {
    const setlist = normalize({
      scenes: [
        { cue: "a", hold_seconds: 0, morph_seconds: 0 },
        { cue: "b", hold_seconds: 0, morph_seconds: 0 },
      ],
    });
    const clock = new FakeClock();
    const client = new FakeClient();
    client.firstCallError = new TdConnectionError("ECONNREFUSED");
    const events: RunnerEvent[] = [];
    await runSetlist({
      setlist,
      args: defaultArgs(),
      client,
      clock,
      emit: (e) => events.push(e),
    });
    expect(events.some((e) => e.t === "warning" && /bridge offline/.test(e.msg))).toBe(true);
    const wouldFire = events.filter((e) => e.t === "would_fire");
    expect(wouldFire.map((e) => (e.t === "would_fire" ? e.cue : ""))).toEqual(["a", "b"]);
  });

  it("start id resumes from that scene", async () => {
    const setlist = normalize({
      scenes: [
        { id: "s0", cue: "a", hold_seconds: 0, morph_seconds: 0 },
        { id: "s1", cue: "b", hold_seconds: 0, morph_seconds: 0 },
        { id: "s2", cue: "c", hold_seconds: 0, morph_seconds: 0 },
      ],
    });
    const clock = new FakeClock();
    const client = new FakeClient();
    await runSetlist({
      setlist,
      args: defaultArgs({ start: "s2" }),
      client,
      clock,
      emit: () => {},
    });
    expect(client.calls.map((c) => c.name)).toEqual(["c"]);
  });

  it("loadCanonicalSetlist rejects an invalid setlist", () => {
    const res = loadCanonicalSetlist({ title: "empty" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/setlist is invalid/);
  });

  it("loadCanonicalSetlist parses a valid JSON string", () => {
    const json = JSON.stringify({ scenes: [{ cue: "a", morph_seconds: 0 }] });
    const res = loadCanonicalSetlist(json);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.setlist.scenes).toHaveLength(1);
      expect(res.setlist.scenes[0]?.cue).toBe("a");
    }
  });

  it("schema accepts start as string or non-negative number; rejects mode='nope'", () => {
    expect(setlistRunnerCliSchema.parse({ setlist: "x", start: "intro" }).start).toBe("intro");
    expect(setlistRunnerCliSchema.parse({ setlist: "x", start: 3 }).start).toBe(3);
    expect(() => setlistRunnerCliSchema.parse({ setlist: "x", mode: "nope" })).toThrow();
    expect(() => setlistRunnerCliSchema.parse({ setlist: "x", start: -1 })).toThrow();
  });
});
