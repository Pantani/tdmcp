import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AceStepClient } from "../../src/ace-client/aceStepClient.js";
import {
  estimateSeconds,
  type RunGenerationOptions,
  runGeneration,
} from "../../src/ace-client/runGeneration.js";
import type { AceGenerateRequest } from "../../src/ace-client/validators.js";
import type { ToolExtra } from "../../src/tools/types.js";

const ACE_BASE = "http://127.0.0.1:8000";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeClient(mode: "wrapper" | "native" = "wrapper"): AceStepClient {
  return new AceStepClient({ baseUrl: ACE_BASE, timeoutMs: 2000, defaultSteps: 27, mode });
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
    defaultSteps: 27,
    pollMs: 1,
    sleep: async () => {},
    ...over,
  };
}

/** msw: POST /jobs then a scripted sequence of GET /jobs/{id} bodies. */
function mockJob(statuses: Record<string, unknown>[]): { jobHits: () => number } {
  let hits = 0;
  server.use(
    http.post(`${ACE_BASE}/jobs`, () => HttpResponse.json({ job_id: "job-9" })),
    http.get(`${ACE_BASE}/jobs/job-9`, () => {
      const body = statuses[Math.min(hits, statuses.length - 1)];
      hits += 1;
      return HttpResponse.json(body);
    }),
  );
  return { jobHits: () => hits };
}

const RUNNING = { status: "running" };
const DONE = { status: "done", wavPath: "/out/a.wav", seconds: 60, seed: 7 };

describe("estimateSeconds", () => {
  it("is undefined when rtf is uncalibrated (unset or <= 0)", () => {
    expect(estimateSeconds(REQ, { defaultSteps: 27 })).toBeUndefined();
    expect(estimateSeconds(REQ, { rtf: 0, defaultSteps: 27 })).toBeUndefined();
  });

  it("is linear in audio_duration", () => {
    expect(estimateSeconds({ ...REQ, audio_duration: 60 }, { rtf: 2, defaultSteps: 27 })).toBe(120);
    expect(estimateSeconds({ ...REQ, audio_duration: 30 }, { rtf: 2, defaultSteps: 27 })).toBe(60);
  });

  it("assumes 120 s when audio_duration <= 0 (ACE randomizes ~30-240 s)", () => {
    expect(estimateSeconds({ ...REQ, audio_duration: -1 }, { rtf: 1, defaultSteps: 27 })).toBe(120);
  });

  it("is linear in infer_step / defaultSteps", () => {
    const e = estimateSeconds(
      { ...REQ, audio_duration: 60, infer_step: 54 },
      { rtf: 1, defaultSteps: 27 },
    );
    expect(e).toBe(120); // 2x the steps => 2x the estimate
  });
});

describe("runGeneration — F6 decision matrix", () => {
  it("auto + rtf UNSET => sync (F6 is inert by default: today's behavior)", async () => {
    const { jobHits } = mockJob([DONE]);
    const out = await runGeneration(makeClient(), REQ, baseOpts({ mode: "auto" }));
    expect(out.kind).toBe("sync");
    expect(jobHits()).toBe(1);
  });

  it("auto + calibrated rtf, estimate <= syncMaxSeconds => sync", async () => {
    mockJob([DONE]);
    // 60 s audio * rtf 1 = 60 <= 120
    const out = await runGeneration(makeClient(), REQ, baseOpts({ mode: "auto", rtf: 1 }));
    expect(out.kind).toBe("sync");
  });

  it("auto + calibrated rtf, estimate > syncMaxSeconds => job, without ever polling", async () => {
    const { jobHits } = mockJob([DONE]);
    const out = await runGeneration(makeClient(), REQ, baseOpts({ mode: "auto", rtf: 5 }));
    expect(out).toEqual({ kind: "job", jobId: "job-9", estimatedSeconds: 300 });
    expect(jobHits()).toBe(0);
  });

  it('mode "sync" ignores a huge estimate and blocks anyway', async () => {
    mockJob([DONE]);
    const out = await runGeneration(makeClient(), REQ, baseOpts({ mode: "sync", rtf: 99 }));
    expect(out.kind).toBe("sync");
  });

  it('mode "job" returns a job_id even with no estimate, without polling', async () => {
    const { jobHits } = mockJob([DONE]);
    const out = await runGeneration(makeClient(), REQ, baseOpts({ mode: "job" }));
    expect(out).toEqual({ kind: "job", jobId: "job-9", estimatedSeconds: undefined });
    expect(jobHits()).toBe(0);
  });
});

describe("runGeneration — sync branch (submit + poll)", () => {
  it("polls to done and returns the WAV + measured elapsed/observedRtf", async () => {
    mockJob([RUNNING, RUNNING, DONE]);
    const out = await runGeneration(
      makeClient(),
      REQ,
      baseOpts({ now: fakeClock(6000) }), // 6 s per clock read
    );
    if (out.kind !== "sync") throw new Error("expected sync");
    expect(out.result).toEqual({ wavPath: "/out/a.wav", seconds: 60, seed: 7 });
    expect(out.elapsedSeconds).toBeGreaterThan(0);
    // observedRtf = elapsed / audio-seconds, normalized to defaultSteps
    expect(out.observedRtf).toBeCloseTo(out.elapsedSeconds / 60, 5);
  });

  it("emits one progress notification per poll, monotonic, with NO total when uncalibrated", async () => {
    mockJob([RUNNING, RUNNING, DONE]);
    const { extra, notes } = spyExtra();
    await runGeneration(makeClient(), REQ, baseOpts({ extra, now: fakeClock(6000) }));
    expect(notes).toHaveLength(3);
    for (const n of notes) expect(n.total).toBeUndefined();
    expect(notes.map((n) => n.progress)).toEqual(
      [...notes.map((n) => n.progress)].sort((a, b) => a - b),
    );
    expect(new Set(notes.map((n) => n.progress)).size).toBe(3); // strictly increasing
    expect(notes[2]?.message).toContain("done");
  });

  it("calibrated: every notification carries total, and progress never exceeds total*0.99", async () => {
    mockJob([RUNNING, RUNNING, DONE]);
    const { extra, notes } = spyExtra();
    // rtf 1 * 60 s audio = total 60; the fake clock races past it (100 s/read).
    await runGeneration(
      makeClient(),
      REQ,
      baseOpts({ extra, rtf: 1, mode: "sync", now: fakeClock(100_000) }),
    );
    expect(notes.length).toBeGreaterThan(0);
    for (const n of notes) {
      expect(n.total).toBe(60);
      expect(n.progress).toBeLessThanOrEqual(60 * 0.99);
    }
  });

  it("no progressToken => zero notifications", async () => {
    mockJob([DONE]);
    const { extra, sendNotification } = spyExtra({ token: undefined });
    await runGeneration(makeClient(), REQ, baseOpts({ extra }));
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("extra undefined (the CLI path) => completes normally, no crash", async () => {
    mockJob([DONE]);
    const out = await runGeneration(makeClient(), REQ, baseOpts());
    expect(out.kind).toBe("sync");
  });

  it("a rejecting sendNotification cannot fail the generation", async () => {
    mockJob([DONE]);
    const { extra, sendNotification } = spyExtra();
    sendNotification.mockRejectedValue(new Error("client went away"));
    const out = await runGeneration(makeClient(), REQ, baseOpts({ extra }));
    expect(out.kind).toBe("sync");
  });
});

describe("runGeneration — cancellation (H-b)", () => {
  it("abort mid-poll: cancelJob is called once with the jobId and the driver rejects", async () => {
    const cancels: string[] = [];
    server.use(
      http.post(`${ACE_BASE}/jobs`, () => HttpResponse.json({ job_id: "job-9" })),
      http.get(`${ACE_BASE}/jobs/job-9`, () => HttpResponse.json(RUNNING)),
      http.post(`${ACE_BASE}/jobs/job-9/cancel`, () => {
        cancels.push("job-9");
        return HttpResponse.json({ cancelled: true });
      }),
    );
    const controller = new AbortController();
    const { extra } = spyExtra({ controller });
    const opts = baseOpts({
      extra,
      // Abort while the driver "sleeps" between polls.
      sleep: async () => {
        controller.abort();
      },
    });
    await expect(runGeneration(makeClient(), REQ, opts)).rejects.toThrow(/job-9/);
    // give the fire-and-forget cancel a tick to land
    await new Promise((r) => setTimeout(r, 20));
    expect(cancels).toEqual(["job-9"]);
  });
});

describe("runGeneration — failure states", () => {
  it("job status error => AceApiError with the wrapper's message", async () => {
    mockJob([{ status: "error", error: "CUDA OOM" }]);
    await expect(runGeneration(makeClient(), REQ, baseOpts())).rejects.toThrow("CUDA OOM");
  });

  it("job status cancelled => AceApiError naming the job", async () => {
    mockJob([{ status: "cancelled" }]);
    await expect(runGeneration(makeClient(), REQ, baseOpts())).rejects.toThrow(
      "Job job-9 was cancelled.",
    );
  });

  it("done without a wavPath => AceApiError", async () => {
    mockJob([{ status: "done", seconds: 10, seed: 1 }]);
    await expect(runGeneration(makeClient(), REQ, baseOpts())).rejects.toThrow(
      "ACE job finished without a wavPath",
    );
  });
});

describe("runGeneration — native mode", () => {
  it('mode "job" => the NATIVE_JOBS_UNSUPPORTED message', async () => {
    await expect(
      runGeneration(makeClient("native"), REQ, baseOpts({ mode: "job" })),
    ).rejects.toThrow("Job control is not supported in native ACE mode");
  });

  it('mode "sync" => a single POST /generate, heartbeat progress only', async () => {
    let posts = 0;
    server.use(
      http.post(`${ACE_BASE}/generate`, () => {
        posts += 1;
        return HttpResponse.json({ status: "ok", output_path: "/out/n.wav" });
      }),
    );
    const { extra, notes } = spyExtra();
    const out = await runGeneration(
      makeClient("native"),
      REQ,
      baseOpts({ mode: "sync", extra, now: fakeClock(1000) }),
    );
    if (out.kind !== "sync") throw new Error("expected sync");
    expect(posts).toBe(1);
    expect(out.result.wavPath).toBe("/out/n.wav");
    expect(notes[0]?.message).toContain("native");
  });
});
