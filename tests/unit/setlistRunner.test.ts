import { describe, expect, it } from "vitest";
import { normalize } from "../../src/automation/setlistSchema.js";
import {
  type BeatSource,
  type CueCaller,
  loadCanonicalSetlist,
  parseSetlistInput,
  type RunnerClock,
  type RunnerEvent,
  runSetlist,
  type Signal,
  type SignalSource,
  setlistRunnerCliSchema,
} from "../../src/cli/setlistRunner.js";
import { TdApiError, TdConnectionError, TdError } from "../../src/td-client/types.js";

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

  it("parseSetlistInput reads YAML frontmatter from a .md setlist note", () => {
    const md = `---\nscenes:\n  - cue: a\n    morph_seconds: 0\n  - cue: b\n    morph_seconds: 0.5\n---\nbody text ignored\n`;
    const parsed = parseSetlistInput(md, "Setlists/show.md");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const loaded = loadCanonicalSetlist(parsed.input);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.setlist.scenes).toHaveLength(2);
        expect(loaded.setlist.scenes[0]?.cue).toBe("a");
      }
    }
  });

  it("parseSetlistInput parses a pure .yaml setlist", () => {
    const yaml = `scenes:\n  - cue: only\n    morph_seconds: 0\n`;
    const parsed = parseSetlistInput(yaml, "show.yaml");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const loaded = loadCanonicalSetlist(parsed.input);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) expect(loaded.setlist.scenes[0]?.cue).toBe("only");
    }
  });

  it("parseSetlistInput falls back to raw string for unknown extensions (JSON path)", () => {
    const json = JSON.stringify({ scenes: [{ cue: "x", morph_seconds: 0 }] });
    const parsed = parseSetlistInput(json, "show.json");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.input).toBe(json);
  });

  it("schema accepts start as string or non-negative number; rejects mode='nope'", () => {
    expect(setlistRunnerCliSchema.parse({ setlist: "x", start: "intro" }).start).toBe("intro");
    expect(setlistRunnerCliSchema.parse({ setlist: "x", start: 3 }).start).toBe(3);
    expect(() => setlistRunnerCliSchema.parse({ setlist: "x", mode: "nope" })).toThrow();
    expect(() => setlistRunnerCliSchema.parse({ setlist: "x", start: -1 })).toThrow();
  });

  // ---------- wave-3 branch coverage extensions ----------

  it("start index out of range → warns and ends without firing", async () => {
    const setlist = normalize({ scenes: [{ cue: "a", morph_seconds: 0 }] });
    const events: RunnerEvent[] = [];
    const summary = await runSetlist({
      setlist,
      args: defaultArgs({ start: 5 }),
      client: new FakeClient(),
      clock: new FakeClock(),
      emit: (e) => events.push(e),
    });
    expect(summary.scenes_fired).toBe(0);
    expect(events.some((e) => e.t === "warning" && /out of range/.test(e.msg))).toBe(true);
    expect(events.some((e) => e.t === "ended" && e.reason === "complete")).toBe(true);
  });

  it("start id not found → warns and ends without firing", async () => {
    const setlist = normalize({
      scenes: [
        { id: "intro", cue: "a", morph_seconds: 0 },
        { id: "drop", cue: "b", morph_seconds: 0 },
      ],
    });
    const events: RunnerEvent[] = [];
    const summary = await runSetlist({
      setlist,
      args: defaultArgs({ start: "missing" }),
      client: new FakeClient(),
      clock: new FakeClock(),
      emit: (e) => events.push(e),
    });
    expect(summary.scenes_fired).toBe(0);
    expect(
      events.some((e) => e.t === "warning" && /start id "missing" not found/.test(e.msg)),
    ).toBe(true);
  });

  it("quantize=bar is forwarded to client.fire", async () => {
    const setlist = normalize({ scenes: [{ cue: "a", hold_seconds: 0, morph_seconds: 0 }] });
    const client = new FakeClient();
    await runSetlist({
      setlist,
      args: defaultArgs({ quantize: "bar" }),
      client,
      clock: new FakeClock(),
      emit: () => {},
    });
    expect(client.calls[0]?.quantize).toBe("bar");
  });

  it("scene with recipe and no cue/steps → info event mentioning recipe", async () => {
    const setlist = normalize({
      scenes: [{ recipe: "myrecipe", hold_seconds: 0, morph_seconds: 0 }],
    });
    const events: RunnerEvent[] = [];
    await runSetlist({
      setlist,
      args: defaultArgs(),
      client: new FakeClient(),
      clock: new FakeClock(),
      emit: (e) => events.push(e),
    });
    expect(events.some((e) => e.t === "info" && /recipe "myrecipe"/.test(e.msg))).toBe(true);
  });

  it("scene with preset and no cue/steps → info event mentioning preset", async () => {
    const setlist = normalize({
      scenes: [{ preset: "mypreset", hold_seconds: 0, morph_seconds: 0 }],
    });
    const events: RunnerEvent[] = [];
    await runSetlist({
      setlist,
      args: defaultArgs(),
      client: new FakeClient(),
      clock: new FakeClock(),
      emit: (e) => events.push(e),
    });
    expect(events.some((e) => e.t === "info" && /preset "mypreset"/.test(e.msg))).toBe(true);
  });

  it("beat mode without beatSource emits a warning and waits on signal", async () => {
    const setlist = normalize({ scenes: [{ cue: "a", hold_beats: 4, morph_seconds: 0 }] });
    const signals = new FakeSignals();
    const events: RunnerEvent[] = [];
    const run = runSetlist({
      setlist,
      args: defaultArgs({ mode: "beat" }),
      client: new FakeClient(),
      clock: new FakeClock(),
      signals,
      emit: (e) => events.push(e),
    });
    await flush();
    expect(events.some((e) => e.t === "warning" && /no event stream/.test(e.msg))).toBe(true);
    signals.push({ t: "next" });
    signals.close();
    await run;
  });

  it("prev signal moves cursor back one scene", async () => {
    const setlist = normalize({
      scenes: [
        { id: "a", cue: "a", morph_seconds: 0 },
        { id: "b", cue: "b", morph_seconds: 0 },
      ],
    });
    const signals = new FakeSignals();
    const client = new FakeClient();
    const events: RunnerEvent[] = [];
    const run = runSetlist({
      setlist,
      args: defaultArgs({ mode: "manual" }),
      client,
      clock: new FakeClock(),
      signals,
      emit: (e) => events.push(e),
    });
    await flush();
    signals.push({ t: "next" });
    await flush();
    await flush();
    signals.push({ t: "prev" });
    await flush();
    await flush();
    signals.push({ t: "stop" });
    await run;
    // a fired, b fired, then prev → a fired again
    expect(client.calls.map((c) => c.name)).toEqual(["a", "b", "a"]);
    expect(events.some((e) => e.t === "advanced" && e.reason === "prev")).toBe(true);
  });

  it("goto signal jumps to target id", async () => {
    const setlist = normalize({
      scenes: [
        { id: "a", cue: "a", morph_seconds: 0 },
        { id: "b", cue: "b", morph_seconds: 0 },
        { id: "c", cue: "c", morph_seconds: 0 },
      ],
    });
    const signals = new FakeSignals();
    const client = new FakeClient();
    const events: RunnerEvent[] = [];
    const run = runSetlist({
      setlist,
      args: defaultArgs({ mode: "manual" }),
      client,
      clock: new FakeClock(),
      signals,
      emit: (e) => events.push(e),
    });
    await flush();
    signals.push({ t: "goto", target: "c" });
    await flush();
    await flush();
    expect(client.calls.map((c) => c.name)).toEqual(["a", "c"]);
    expect(events.some((e) => e.t === "advanced" && e.reason === "goto")).toBe(true);
    signals.push({ t: "stop" });
    await run;
  });

  it("goto signal with invalid target warns and advances normally", async () => {
    const setlist = normalize({
      scenes: [
        { id: "a", cue: "a", morph_seconds: 0 },
        { id: "b", cue: "b", morph_seconds: 0 },
      ],
    });
    const signals = new FakeSignals();
    const events: RunnerEvent[] = [];
    const run = runSetlist({
      setlist,
      args: defaultArgs({ mode: "manual" }),
      client: new FakeClient(),
      clock: new FakeClock(),
      signals,
      emit: (e) => events.push(e),
    });
    await flush();
    signals.push({ t: "goto", target: "nope" });
    await flush();
    await flush();
    expect(events.some((e) => e.t === "warning" && /not found/.test(e.msg))).toBe(true);
    signals.push({ t: "stop" });
    await run;
  });

  it("TdError (non-connection) during fire → warns and continues", async () => {
    const setlist = normalize({
      scenes: [
        { cue: "bad", hold_seconds: 0, morph_seconds: 0 },
        { cue: "good", hold_seconds: 0, morph_seconds: 0 },
      ],
    });
    const client = new FakeClient();
    client.firstCallError = new TdError("generic td failure", "td-error");
    const events: RunnerEvent[] = [];
    await runSetlist({
      setlist,
      args: defaultArgs(),
      client,
      clock: new FakeClock(),
      emit: (e) => events.push(e),
    });
    expect(
      events.some((e) => e.t === "warning" && /generic td failure/.test(e.msg) && e.cue === "bad"),
    ).toBe(true);
    expect(client.calls.map((c) => c.name)).toContain("good");
  });

  it("non-Error rejection (string) during fire → warns with String(err)", async () => {
    const setlist = normalize({
      scenes: [{ cue: "weird", hold_seconds: 0, morph_seconds: 0 }],
    });
    const client = new FakeClient();
    // throw a non-Error value
    client.firstCallError = "oops-string" as unknown as Error;
    const events: RunnerEvent[] = [];
    await runSetlist({
      setlist,
      args: defaultArgs(),
      client,
      clock: new FakeClock(),
      emit: (e) => events.push(e),
    });
    expect(events.some((e) => e.t === "warning" && /oops-string/.test(e.msg))).toBe(true);
  });

  it("step preempt: stop ends the show during a step hold", async () => {
    const setlist = normalize({
      scenes: [
        {
          steps: [
            { cue: "s1", hold_seconds: 5, morph_seconds: 0 },
            { cue: "s2", hold_seconds: 5, morph_seconds: 0 },
          ],
          morph_seconds: 0,
        },
      ],
    });
    const signals = new FakeSignals();
    const client = new FakeClient();
    const run = runSetlist({
      setlist,
      args: defaultArgs({ mode: "manual" }),
      client,
      clock: new FakeClock(),
      signals,
      emit: () => {},
    });
    await flush();
    signals.push({ t: "stop" });
    const summary = await run;
    expect(summary.ended_reason).toBe("stopped");
    expect(client.calls.map((c) => c.name)).toEqual(["s1"]);
  });

  it("step preempt: next skips remaining steps and advances scene", async () => {
    const setlist = normalize({
      scenes: [
        {
          id: "scn",
          steps: [
            { cue: "s1", hold_seconds: 5, morph_seconds: 0 },
            { cue: "s2", hold_seconds: 5, morph_seconds: 0 },
          ],
          hold_seconds: 0,
          morph_seconds: 0,
        },
        { id: "after", cue: "after", hold_seconds: 0, morph_seconds: 0 },
      ],
    });
    const signals = new FakeSignals();
    const client = new FakeClient();
    const events: RunnerEvent[] = [];
    const run = runSetlist({
      setlist,
      args: defaultArgs({ mode: "manual" }),
      client,
      clock: new FakeClock(),
      signals,
      emit: (e) => events.push(e),
    });
    await flush();
    signals.push({ t: "next" });
    await run;
    expect(client.calls.map((c) => c.name)).toEqual(["s1", "after"]);
    expect(events.some((e) => e.t === "advanced" && e.reason === "manual")).toBe(true);
  });

  it("step preempt: prev decrements scene cursor (clamped at 0)", async () => {
    const setlist = normalize({
      scenes: [
        {
          id: "scn",
          steps: [{ cue: "s1", hold_seconds: 5, morph_seconds: 0 }],
          hold_seconds: 0,
          morph_seconds: 0,
        },
      ],
    });
    const signals = new FakeSignals();
    const client = new FakeClient();
    const events: RunnerEvent[] = [];
    const run = runSetlist({
      setlist,
      args: defaultArgs({ mode: "manual" }),
      client,
      clock: new FakeClock(),
      signals,
      emit: (e) => events.push(e),
    });
    await flush();
    signals.push({ t: "prev" });
    await flush();
    await flush();
    signals.push({ t: "stop" });
    await run;
    // prev at index 0 stays at 0, fires s1 again
    expect(client.calls.map((c) => c.name)).toEqual(["s1", "s1"]);
    expect(events.some((e) => e.t === "advanced" && e.reason === "prev")).toBe(true);
  });

  it("step preempt: goto valid target jumps; invalid target warns", async () => {
    const setlist = normalize({
      scenes: [
        {
          id: "first",
          steps: [{ cue: "s1", hold_seconds: 5, morph_seconds: 0 }],
          hold_seconds: 0,
          morph_seconds: 0,
        },
        { id: "second", cue: "b", hold_seconds: 0, morph_seconds: 0 },
      ],
    });
    const signals = new FakeSignals();
    const client = new FakeClient();
    const events: RunnerEvent[] = [];
    const run = runSetlist({
      setlist,
      args: defaultArgs({ mode: "manual" }),
      client,
      clock: new FakeClock(),
      signals,
      emit: (e) => events.push(e),
    });
    await flush();
    signals.push({ t: "goto", target: "second" });
    await run;
    expect(client.calls.map((c) => c.name)).toEqual(["s1", "b"]);
    expect(events.some((e) => e.t === "advanced" && e.reason === "goto")).toBe(true);
  });

  it("step preempt: goto invalid target warns and advances normally", async () => {
    const setlist = normalize({
      scenes: [
        {
          id: "first",
          steps: [{ cue: "s1", hold_seconds: 5, morph_seconds: 0 }],
          hold_seconds: 0,
          morph_seconds: 0,
        },
        { id: "second", cue: "b", hold_seconds: 0, morph_seconds: 0 },
      ],
    });
    const signals = new FakeSignals();
    const events: RunnerEvent[] = [];
    const run = runSetlist({
      setlist,
      args: defaultArgs({ mode: "manual" }),
      client: new FakeClient(),
      clock: new FakeClock(),
      signals,
      emit: (e) => events.push(e),
    });
    await flush();
    signals.push({ t: "goto", target: "nowhere" });
    await run;
    expect(events.some((e) => e.t === "warning" && /not found/.test(e.msg))).toBe(true);
  });

  it("manual mode with closed signals ends naturally (elapsed-as-manual)", async () => {
    const setlist = normalize({ scenes: [{ cue: "a", morph_seconds: 0 }] });
    const signals = new FakeSignals();
    signals.close();
    const events: RunnerEvent[] = [];
    const summary = await runSetlist({
      setlist,
      args: defaultArgs({ mode: "manual" }),
      client: new FakeClient(),
      clock: new FakeClock(),
      signals,
      emit: (e) => events.push(e),
    });
    expect(summary.ended_reason).toBe("complete");
  });

  it("empty setlist completes immediately with zero scenes fired", async () => {
    // normalize requires at least one scene; build a minimal setlist then strip
    const setlist = normalize({ scenes: [{ cue: "x", morph_seconds: 0 }] });
    const events: RunnerEvent[] = [];
    const summary = await runSetlist({
      setlist: { ...setlist, scenes: [] },
      args: defaultArgs(),
      client: new FakeClient(),
      clock: new FakeClock(),
      emit: (e) => events.push(e),
    });
    expect(summary.scenes_total).toBe(0);
    expect(summary.scenes_fired).toBe(0);
    expect(summary.ended_reason).toBe("complete");
    expect(events.some((e) => e.t === "started" && e.total === 0)).toBe(true);
  });

  it("loadCanonicalSetlist rejects invalid JSON string", () => {
    const res = loadCanonicalSetlist("{not json");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/not valid JSON/);
  });

  it("parseSetlistInput handles .markdown extension", () => {
    const md = `---\nscenes:\n  - cue: a\n    morph_seconds: 0\n---\n`;
    const parsed = parseSetlistInput(md, "x.markdown");
    expect(parsed.ok).toBe(true);
  });

  it("parseSetlistInput with no filename falls through to raw string", () => {
    const raw = '{"scenes":[{"cue":"a","morph_seconds":0}]}';
    const parsed = parseSetlistInput(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.input).toBe(raw);
  });

  it("parseSetlistInput returns error on malformed YAML", () => {
    // The local YAML parser throws on bad YAML.
    const bad = ":\n  - [unbalanced";
    const parsed = parseSetlistInput(bad, "x.yaml");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toMatch(/could not parse/);
  });
});
