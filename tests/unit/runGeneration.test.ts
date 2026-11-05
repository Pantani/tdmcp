import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AceStepClient } from "../../src/ace-client/aceStepClient.js";
import {
  estimateSeconds,
  type RunGenerationOptions,
  runGeneration,
} from "../../src/ace-client/runGeneration.js";
import { AceTimeoutError } from "../../src/ace-client/types.js";
import type { AceGenerateRequest } from "../../src/ace-client/validators.js";
import type { ToolExtra } from "../../src/tools/types.js";
import {
  ACE_BASE,
  aceOutputDir,
  failedRow,
  mockAce,
  runningRow,
  succeededRow,
} from "../helpers/aceMock.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeClient(): AceStepClient {
  return new AceStepClient({
    baseUrl: ACE_BASE,
    timeoutMs: 2000,
    defaultSteps: 8,
    outputDir: aceOutputDir(),
  });
}

const REQ: AceGenerateRequest = { prompt: "techno", audio_duration: 60 };

/** A spy `extra`: records every notification and lets the test abort mid-run. */
function spyExtra(opts: { token?: string | number; controller?: AbortController } = {}) {
  const notes: { progress: number; total?: number; message?: string }[] = [];
  const controller = opts.controller ?? new AbortController();
  const sendNotification = vi.fn(async (n: unknown) => {
    const params = (n as { params: { progress: number; total?: number; message?: string } }).params;
    notes.push(params);
  });
  const token = "token" in opts ? opts.token : "tok-1";
  const extra = {
    signal: controller.signal,
    requestId: 1,
    sendNotification,
    sendRequest: vi.fn(),
    ...(token !== undefined ? { _meta: { progressToken: token } } : { _meta: {} }),
  } as unknown as ToolExtra;
  return { extra, notes, sendNotification, controller };
}

/** A fake monotonic clock: every read advances by `stepMs`. */
function fakeClock(stepMs: number) {
  let t = 0;
  return () => {
    const v = t;
    t += stepMs;
    return v;
  };
}

function baseOpts(over: Partial<RunGenerationOptions> = {}): RunGenerationOptions {
  return {
    mode: "auto",
    syncMaxSeconds: 120,
    defaultSteps: 8,
    pollMs: 1,
    timeoutMs: 600000,
    sleep: async () => {},
    ...over,
  };
}

const DONE = succeededRow({ duration: 60, seed_value: "7" });

describe("estimateSeconds", () => {
  it("is undefined when rtf is uncalibrated (unset or <= 0)", () => {
    expect(estimateSeconds(REQ, { defaultSteps: 8 })).toBeUndefined();
    expect(estimateSeconds(REQ, { rtf: 0, defaultSteps: 8 })).toBeUndefined();
  });

  it("is linear in audio_duration", () => {
    expect(estimateSeconds(REQ, { rtf: 2, defaultSteps: 8 })).toBe(120);
  });

  it("assumes 120 s when the model picks the length", () => {
    expect(estimateSeconds({ prompt: "x" }, { rtf: 1, defaultSteps: 8 })).toBe(120);
  });

  it("is linear in inference_steps / defaultSteps", () => {
    expect(estimateSeconds({ ...REQ, inference_steps: 16 }, { rtf: 1, defaultSteps: 8 })).toBe(120);
  });
});

describe("runGeneration — sync-or-job decision", () => {
  it("auto + rtf unset => sync (the hand-off is inert by default)", async () => {
    mockAce(server, [DONE]);
    expect((await runGeneration(makeClient(), REQ, baseOpts())).kind).toBe("sync");
  });

  it("auto + calibrated rtf, estimate <= syncMaxSeconds => sync", async () => {
    mockAce(server, [DONE]);
    const outcome = await runGeneration(makeClient(), REQ, baseOpts({ rtf: 1 }));
    expect(outcome.kind).toBe("sync");
  });

  it("auto + calibrated rtf, estimate > syncMaxSeconds => job, without ever polling", async () => {
    const hits = mockAce(server, [DONE]);
    const outcome = await runGeneration(makeClient(), REQ, baseOpts({ rtf: 3 }));
    expect(outcome).toEqual({ kind: "job", jobId: "task-1", estimatedSeconds: 180 });
    expect(hits.queries).toHaveLength(0);
  });

  it('mode "sync" ignores a huge estimate and blocks anyway', async () => {
    mockAce(server, [DONE]);
    const outcome = await runGeneration(makeClient(), REQ, baseOpts({ mode: "sync", rtf: 100 }));
    expect(outcome.kind).toBe("sync");
  });

  it('mode "job" returns a job_id even with no estimate, without polling', async () => {
    const hits = mockAce(server, [DONE]);
    const outcome = await runGeneration(makeClient(), REQ, baseOpts({ mode: "job" }));
    expect(outcome).toEqual({ kind: "job", jobId: "task-1", estimatedSeconds: undefined });
    expect(hits.queries).toHaveLength(0);
  });
});

describe("runGeneration — sync branch (submit + poll)", () => {
  it("polls to done and returns the audio + measured elapsed/observedRtf", async () => {
    const hits = mockAce(server, [runningRow(), runningRow(0.5), DONE]);
    const outcome = await runGeneration(makeClient(), REQ, baseOpts({ now: fakeClock(10000) }));
    if (outcome.kind !== "sync") throw new Error("expected sync");
    expect(hits.queries).toHaveLength(3);
    expect(outcome.result.seconds).toBe(60);
    expect(outcome.result.seed).toBe(7);
    expect(outcome.result.wavPath).toMatch(/task-1\.wav$/);
    expect(outcome.elapsedSeconds).toBeGreaterThan(0);
    expect(outcome.observedRtf).toBeCloseTo(outcome.elapsedSeconds / 60);
  });

  it("falls back to the requested seed and duration when the server omits them", async () => {
    const row = succeededRow();
    const [item] = JSON.parse(row.result as string) as Record<string, unknown>[];
    mockAce(server, [{ ...row, result: JSON.stringify([{ ...item, metas: {} }]) }]);
    const outcome = await runGeneration(makeClient(), { ...REQ, seed: 5 }, baseOpts());
    if (outcome.kind !== "sync") throw new Error("expected sync");
    expect(outcome.result.seconds).toBe(60);
    expect(outcome.result.seed).toBe(5);
  });

  it("leaves the seed unset rather than inventing one", async () => {
    mockAce(server, [succeededRow()]);
    const outcome = await runGeneration(makeClient(), REQ, baseOpts());
    if (outcome.kind !== "sync") throw new Error("expected sync");
    expect(outcome.result).not.toHaveProperty("seed");
  });

  it("emits one progress notification per poll, monotonic, with NO total when uncalibrated", async () => {
    mockAce(server, [runningRow(0, "queued"), runningRow(0.5, "diffusion"), DONE]);
    const { extra, notes } = spyExtra();
    await runGeneration(makeClient(), REQ, baseOpts({ extra, now: fakeClock(1000) }));
    expect(notes).toHaveLength(3);
    expect(notes.every((n) => n.total === undefined)).toBe(true);
    const progress = notes.map((n) => n.progress);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(notes[1]?.message).toContain("diffusion");
  });

  it("calibrated: every notification carries total, and progress never exceeds total*0.99", async () => {
    mockAce(server, [runningRow(), runningRow(), DONE]);
    const { extra, notes } = spyExtra();
    // Each clock read advances 200 s, far past the 60 s estimate.
    await runGeneration(
      makeClient(),
      REQ,
      baseOpts({ extra, rtf: 1, now: fakeClock(200000), timeoutMs: 10_000_000 }),
    );
    expect(notes.length).toBeGreaterThan(0);
    for (const n of notes) {
      expect(n.total).toBe(60);
      expect(n.progress).toBeLessThanOrEqual(60 * 0.99);
    }
  });

  it("no progressToken => zero notifications", async () => {
    mockAce(server, [DONE]);
    const { extra, sendNotification } = spyExtra({ token: undefined });
    await runGeneration(makeClient(), REQ, baseOpts({ extra }));
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("extra undefined (the CLI path) => completes normally, no crash", async () => {
    mockAce(server, [DONE]);
    await expect(runGeneration(makeClient(), REQ, baseOpts())).resolves.toBeDefined();
  });

  it("a rejecting sendNotification cannot fail the generation", async () => {
    mockAce(server, [runningRow(), DONE]);
    const { extra, sendNotification } = spyExtra();
    sendNotification.mockRejectedValue(new Error("transport gone"));
    const outcome = await runGeneration(
      makeClient(),
      REQ,
      baseOpts({ extra, now: fakeClock(1000) }),
    );
    expect(outcome.kind).toBe("sync");
  });
});

describe("runGeneration — stopping the wait (upstream has no cancel API)", () => {
  it("abort mid-poll stops polling and says the job keeps running on the server", async () => {
    const hits = mockAce(server, [runningRow()]);
    const controller = new AbortController();
    const { extra } = spyExtra({ controller });
    const sleep = async () => {
      controller.abort();
    };
    await expect(runGeneration(makeClient(), REQ, baseOpts({ extra, sleep }))).rejects.toThrow(
      /job task-1 keeps running/,
    );
    expect(hits.queries).toHaveLength(1);
  });

  it("gives up at the deadline instead of polling forever, naming the job", async () => {
    mockAce(server, [runningRow()]);
    const err = await runGeneration(
      makeClient(),
      REQ,
      baseOpts({ timeoutMs: 5000, now: fakeClock(2000) }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AceTimeoutError);
    expect((err as Error).message).toContain("task-1");
  });
});

describe("runGeneration — failure states", () => {
  it("job status error => AceApiError with upstream's message", async () => {
    mockAce(server, [failedRow("CUDA out of memory")]);
    await expect(runGeneration(makeClient(), REQ, baseOpts())).rejects.toThrow(
      "CUDA out of memory",
    );
  });
});
