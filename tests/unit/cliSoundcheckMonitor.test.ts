/**
 * Offline tests for soundcheckMonitor — two suites:
 *   1. Pure `evaluateWindow` logic (no msw needed).
 *   2. `runSoundcheckMonitor` integration with msw bridge mock + fake timers.
 */

import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArmedState, WindowOpts } from "../../src/cli/soundcheckMonitor.js";
import {
  evaluateWindow,
  runSoundcheckMonitor,
  soundcheckMonitorSchema,
} from "../../src/cli/soundcheckMonitor.js";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { TD_BASE } from "../helpers/tdMock.js";

// ---------------------------------------------------------------------------
// MSW server (only used for the integration suite)
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

const BASE_OPTS: WindowOpts = {
  windowMs: 1000,
  silenceWindowMs: 2000,
  clipThreshold: 0.98,
  silenceThreshold: 0.005,
  quietRecoveryMs: 1500,
};

const CLEAR: ArmedState = { clip: null, silence: null };

// Helper: build a buffer from [{ t, value }]
const buf = (entries: Array<{ t: number; value: number }>) => entries;

// ---------------------------------------------------------------------------
// Suite 1 — Pure evaluateWindow logic
// ---------------------------------------------------------------------------
describe("evaluateWindow — clip arming", () => {
  it("fires a clip alert when peak crosses threshold", () => {
    const now = 10000;
    const samples = buf([{ t: now - 100, value: 1.05 }]);
    const { alerts, newArmed } = evaluateWindow(samples, now, CLEAR, BASE_OPTS);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.level).toBe("clip");
    expect(alerts[0]?.peak).toBeCloseTo(1.05);
    expect(newArmed.clip).toBe(now);
  });

  it("does not re-arm clip within quietRecoveryMs", () => {
    const now = 10000;
    const armed: ArmedState = { clip: now - 500, silence: null }; // armed 500ms ago, quietRecovery=1500
    const samples = buf([{ t: now - 100, value: 1.05 }]);
    const { alerts } = evaluateWindow(samples, now, armed, BASE_OPTS);
    expect(alerts).toHaveLength(0); // still in recovery window
  });

  it("recovers from clip after quietRecoveryMs of sub-threshold samples", () => {
    const now = 10000;
    const armed: ArmedState = { clip: now - 2000, silence: null }; // armed 2s ago > 1500ms recovery
    const samples = buf([{ t: now - 100, value: 0.3 }]); // sub-threshold
    const { recoveries, newArmed } = evaluateWindow(samples, now, armed, BASE_OPTS);
    expect(recoveries.some((r) => r.level === "clip")).toBe(true);
    expect(newArmed.clip).toBeNull();
  });
});

describe("evaluateWindow — silence arming", () => {
  it("fires silence alert only when the whole silenceWindow is silent", () => {
    const now = 10000;
    // All samples in the last 2000ms are below threshold
    const samples = buf([
      { t: now - 1800, value: 0.001 },
      { t: now - 1200, value: 0.002 },
      { t: now - 600, value: 0.001 },
      { t: now - 100, value: 0.001 },
    ]);
    const { alerts } = evaluateWindow(samples, now, CLEAR, BASE_OPTS);
    expect(alerts.some((a) => a.level === "silence")).toBe(true);
  });

  it("does not fire silence when one loud sample resets the run", () => {
    const now = 10000;
    const samples = buf([
      { t: now - 1800, value: 0.001 },
      { t: now - 1200, value: 0.8 }, // loud → resets silence run
      { t: now - 600, value: 0.001 },
      { t: now - 100, value: 0.001 },
    ]);
    const { alerts } = evaluateWindow(samples, now, CLEAR, BASE_OPTS);
    expect(alerts.some((a) => a.level === "silence")).toBe(false);
  });
});

describe("evaluateWindow — RMS/peak math", () => {
  it("computes correct RMS and peak for a known waveform", () => {
    const now = 10000;
    // Three samples: 0, 0.6, 0 within windowMs=1000ms
    const samples = buf([
      { t: now - 800, value: 0 },
      { t: now - 500, value: 0.6 },
      { t: now - 100, value: 0 },
    ]);
    const { stats } = evaluateWindow(samples, now, CLEAR, BASE_OPTS);
    // RMS = sqrt((0 + 0.36 + 0) / 3) = sqrt(0.12) ≈ 0.3464
    expect(stats.rms).toBeCloseTo(Math.sqrt(0.12), 4);
    expect(stats.peak).toBeCloseTo(0.6, 4);
  });

  it("spike beyond threshold triggers clip and inflates peak", () => {
    const now = 10000;
    const samples = buf([
      { t: now - 400, value: 0.4 },
      { t: now - 200, value: 1.1 }, // spike
      { t: now - 100, value: 0.3 },
    ]);
    const { stats, alerts } = evaluateWindow(samples, now, CLEAR, BASE_OPTS);
    expect(stats.peak).toBeCloseTo(1.1, 4);
    expect(alerts.some((a) => a.level === "clip")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — runSoundcheckMonitor integration (msw + real timers, fast)
// ---------------------------------------------------------------------------

function execOk(value: number, tdPaused = false) {
  const report = { value, t: Date.now() / 1000, td_paused: tdPaused, error: null };
  return HttpResponse.json({ ok: true, data: { result: null, stdout: JSON.stringify(report) } });
}

function execError(message: string) {
  return HttpResponse.json({ ok: false, error: { message } }, { status: 500 });
}

describe("runSoundcheckMonitor — integration (msw)", () => {
  // Capture stdout/stderr writes
  let stdoutLines: string[] = [];
  let stderrLines: string[] = [];
  let _origStdout: typeof process.stdout.write;
  let _origStderr: typeof process.stderr.write;

  beforeEach(() => {
    stdoutLines = [];
    stderrLines = [];
    _origStdout = process.stdout.write.bind(process.stdout);
    _origStderr = process.stderr.write.bind(process.stderr);
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutLines.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrLines.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits tick events and no alerts for steady sub-threshold values", async () => {
    let _callCount = 0;
    server.use(
      http.post(`${TD_BASE}/api/exec`, () => {
        _callCount++;
        return execOk(0.4);
      }),
    );

    const ac = new AbortController();
    const ctx = makeCtx();

    // Abort after a short delay so the loop runs a few ticks
    setTimeout(() => ac.abort(), 80);

    const summary = await runSoundcheckMonitor(
      ctx,
      { sampleRateMs: 50, windowMs: 250, silenceWindowMs: 1000, quietRecoveryMs: 200 },
      ac.signal,
    );

    // Should have run at least 1 tick
    expect(summary.ticks).toBeGreaterThan(0);
    expect(summary.clipAlerts).toBe(0);

    // stdout should contain at least one tick event
    const tickEvents = stdoutLines
      .flatMap((l) => l.split("\n"))
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((e): e is Record<string, unknown> => e !== null && e.type === "tick");

    expect(tickEvents.length).toBeGreaterThan(0);
  }, 2000);

  it("emits a clip alert on a high-value sample", async () => {
    let call = 0;
    server.use(
      http.post(`${TD_BASE}/api/exec`, () => {
        call++;
        // First ticks below threshold, then spike
        const val = call >= 2 ? 1.05 : 0.3;
        return execOk(val);
      }),
    );

    const ac = new AbortController();
    const ctx = makeCtx();
    setTimeout(() => ac.abort(), 120);

    const summary = await runSoundcheckMonitor(
      ctx,
      {
        sampleRateMs: 50,
        windowMs: 250,
        silenceWindowMs: 1000,
        clipThreshold: 0.98,
        quietRecoveryMs: 5000,
      },
      ac.signal,
    );

    expect(summary.clipAlerts).toBeGreaterThanOrEqual(1);

    const allEvents = stdoutLines
      .flatMap((l) => l.split("\n"))
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((e): e is Record<string, unknown> => e !== null);

    const clipAlert = allEvents.find((e) => e.type === "alert" && e.level === "clip");
    expect(clipAlert).toBeDefined();
    expect((clipAlert?.peak as number) ?? 0).toBeGreaterThan(0.98);
  }, 2000);

  it("emits bridge_error event and continues on bridge failure", async () => {
    let call = 0;
    server.use(
      http.post(`${TD_BASE}/api/exec`, () => {
        call++;
        if (call === 2) return execError("bridge unreachable");
        return execOk(0.3);
      }),
    );

    const ac = new AbortController();
    const ctx = makeCtx();
    setTimeout(() => ac.abort(), 200);

    const summary = await runSoundcheckMonitor(
      ctx,
      { sampleRateMs: 50, windowMs: 250, silenceWindowMs: 1000 },
      ac.signal,
    );

    expect(summary.bridgeErrors).toBeGreaterThanOrEqual(1);
    // ticks should still be > 0 (monitor continued after error)
    expect(summary.ticks).toBeGreaterThan(0);
  }, 2000);

  it("aborts cleanly and resolves with a summary", async () => {
    server.use(http.post(`${TD_BASE}/api/exec`, () => execOk(0.4)));

    const ac = new AbortController();
    const ctx = makeCtx();
    setTimeout(() => ac.abort(), 60);

    const summary = await runSoundcheckMonitor(
      ctx,
      { sampleRateMs: 50, windowMs: 250, silenceWindowMs: 1000 },
      ac.signal,
    );

    expect(summary).toHaveProperty("ticks");
    expect(summary).toHaveProperty("durationMs");
    expect(summary.durationMs).toBeGreaterThan(0);

    // Summary line written to stderr
    const summaryLine = stderrLines
      .join("")
      .split("\n")
      .find((l) => l.includes("Summary:"));
    expect(summaryLine).toBeDefined();
  }, 2000);
});

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------
describe("soundcheckMonitorSchema", () => {
  it("applies defaults when no options supplied", () => {
    const opts = soundcheckMonitorSchema.parse({});
    expect(opts.audioSource).toBe("/project1/audio_features/features");
    expect(opts.channel).toBe("level");
    expect(opts.sampleRateMs).toBe(250);
    expect(opts.clipThreshold).toBe(0.98);
    expect(opts.format).toBe("ndjson");
  });

  it("rejects sampleRateMs below 50", () => {
    expect(() => soundcheckMonitorSchema.parse({ sampleRateMs: 10 })).toThrow();
  });

  it("rejects clipThreshold above 1.5", () => {
    expect(() => soundcheckMonitorSchema.parse({ clipThreshold: 2.0 })).toThrow();
  });
});
