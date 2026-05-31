/**
 * soundcheck_monitor — rolling-window RMS/peak/silence alert streamer
 *
 * A long-running CLI subcommand that polls one audio CHOP channel in TouchDesigner
 * and emits alert events on stdout (ndjson) + human-readable lines on stderr.
 * Terminated by AbortSignal (SIGINT wiring is the integrator's job in agent.ts).
 *
 * Not a Layer-1/2/3 MCP tool — no tool registry entry.
 */

import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../tools/pythonReport.js";
import type { ToolContext } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Zod schema (exported for CLI flag coercion + tests)
// ---------------------------------------------------------------------------
export const soundcheckMonitorSchema = z.object({
  audioSource: z
    .string()
    .default("/project1/audio_features/features")
    .describe("Path of the audio/features CHOP to poll."),
  channel: z
    .string()
    .default("level")
    .describe("Channel name inside the CHOP (e.g. 'level', 'bass', 'chan1')."),
  sampleRateMs: z
    .number()
    .int()
    .min(50)
    .default(250)
    .describe("Poll interval in ms. Minimum 50 to protect the bridge."),
  clipThreshold: z
    .number()
    .min(0)
    .max(1.5)
    .default(0.98)
    .describe("Peak magnitude above which a clip alert fires."),
  silenceThreshold: z
    .number()
    .min(0)
    .max(1)
    .default(0.005)
    .describe("RMS below which a sample counts as silent."),
  silenceWindowMs: z
    .number()
    .int()
    .min(250)
    .default(2000)
    .describe("Silence alert fires after this many ms of continuous silence."),
  windowMs: z.number().int().min(250).default(1000).describe("Rolling window for RMS/peak stats."),
  format: z
    .enum(["ndjson", "pretty"])
    .default("ndjson")
    .describe("stdout format. stderr alerts are always human-readable."),
  quietRecoveryMs: z
    .number()
    .int()
    .min(0)
    .default(1500)
    .describe("After an alert fires, wait this ms before re-arming."),
});

export type SoundcheckMonitorOpts = z.infer<typeof soundcheckMonitorSchema>;

// ---------------------------------------------------------------------------
// Event types (ndjson output)
// ---------------------------------------------------------------------------
export interface TickStats {
  rms: number;
  peak: number;
  silentForMs: number;
}

export interface TickEvent {
  type: "tick";
  t: number;
  channel: string;
  value: number;
  stats: TickStats;
}

export interface AlertEvent {
  type: "alert";
  t: number;
  level: "clip" | "silence";
  peak?: number;
  silentForMs?: number;
  threshold: number;
  tdPaused?: boolean;
}

export interface RecoverEvent {
  type: "recover";
  t: number;
  level: "clip" | "silence";
}

export interface BridgeErrorEvent {
  type: "bridge_error";
  t: number;
  error: string;
}

export type SoundcheckEvent = TickEvent | AlertEvent | RecoverEvent | BridgeErrorEvent;

// ---------------------------------------------------------------------------
// Ring buffer sample
// ---------------------------------------------------------------------------
interface Sample {
  t: number;
  value: number;
}

// ---------------------------------------------------------------------------
// Armed state — tracks when an alert fired so we can enforce quietRecoveryMs
// ---------------------------------------------------------------------------
export interface ArmedState {
  clip: number | null; // epoch ms when clip alert fired (null = not armed)
  silence: number | null; // epoch ms when silence alert fired
}

// ---------------------------------------------------------------------------
// Pure evaluation function — the unit-test seam
// ---------------------------------------------------------------------------
export interface WindowOpts {
  windowMs: number;
  silenceWindowMs: number;
  clipThreshold: number;
  silenceThreshold: number;
  quietRecoveryMs: number;
}

export interface EvaluateResult {
  stats: TickStats;
  alerts: Array<{
    level: "clip" | "silence";
    peak?: number;
    silentForMs?: number;
    threshold: number;
  }>;
  recoveries: Array<{ level: "clip" | "silence" }>;
  newArmed: ArmedState;
}

/**
 * Evaluate a ring buffer at `now` and return stats, new alerts, and recoveries.
 * Pure: no side effects, no I/O.
 */
export function evaluateWindow(
  buffer: Sample[],
  now: number,
  armed: ArmedState,
  opts: WindowOpts,
): EvaluateResult {
  const { windowMs, silenceWindowMs, clipThreshold, silenceThreshold, quietRecoveryMs } = opts;

  // --- Compute RMS + peak over `windowMs` ---
  const windowCutoff = now - windowMs;
  const windowSamples = buffer.filter((s) => s.t >= windowCutoff);

  let sumSq = 0;
  let peak = 0;
  for (const s of windowSamples) {
    const abs = Math.abs(s.value);
    sumSq += abs * abs;
    if (abs > peak) peak = abs;
  }
  const rms = windowSamples.length > 0 ? Math.sqrt(sumSq / windowSamples.length) : 0;

  // --- Compute silentForMs: length of trailing run where every sample is below threshold ---
  const silenceCutoff = now - silenceWindowMs;
  const silenceWindow = buffer.filter((s) => s.t >= silenceCutoff);

  // Walk from newest to oldest, counting consecutive silent samples
  let silentRunMs = 0;
  if (silenceWindow.length > 0) {
    const sorted = [...silenceWindow].sort((a, b) => b.t - a.t); // newest first
    // Count consecutive silent samples from the newest end
    let loudAt = -1; // index of the most-recent loud sample (or -1 if all silent)
    for (let i = 0; i < sorted.length; i++) {
      const s = sorted[i];
      if (s === undefined) break;
      if (Math.abs(s.value) >= silenceThreshold) {
        loudAt = i;
        break;
      }
    }
    if (loudAt === -1) {
      // Every sample in the window is silent: the whole silenceWindowMs has been silent
      silentRunMs = silenceWindowMs;
    } else if (loudAt > 0) {
      // There are `loudAt` consecutive silent samples newer than the loud one
      const newestSilent = sorted[0];
      const loudSample = sorted[loudAt];
      if (newestSilent !== undefined && loudSample !== undefined) {
        silentRunMs = newestSilent.t - loudSample.t;
      }
    }
    // loudAt === 0 → the newest sample is loud → silentRunMs stays 0
  }

  const stats: TickStats = { rms, peak, silentForMs: silentRunMs };

  const alerts: EvaluateResult["alerts"] = [];
  const recoveries: EvaluateResult["recoveries"] = [];
  const newArmed: ArmedState = { clip: armed.clip, silence: armed.silence };

  // --- Clip alert ---
  if (peak >= clipThreshold) {
    if (newArmed.clip === null) {
      alerts.push({ level: "clip", peak, threshold: clipThreshold });
      newArmed.clip = now;
    }
  } else {
    // Recovery: sub-threshold for quietRecoveryMs
    if (newArmed.clip !== null && now - newArmed.clip >= quietRecoveryMs) {
      recoveries.push({ level: "clip" });
      newArmed.clip = null;
    }
  }

  // --- Silence alert ---
  if (silentRunMs >= silenceWindowMs) {
    if (newArmed.silence === null) {
      alerts.push({ level: "silence", silentForMs: silentRunMs, threshold: silenceThreshold });
      newArmed.silence = now;
    }
  } else {
    // Recovery: signal came back for quietRecoveryMs
    if (newArmed.silence !== null && now - newArmed.silence >= quietRecoveryMs) {
      recoveries.push({ level: "silence" });
      newArmed.silence = null;
    }
  }

  return { stats, alerts, recoveries, newArmed };
}

// ---------------------------------------------------------------------------
// Bridge script: read one CHOP channel value + td.time.play for pause detection
// ---------------------------------------------------------------------------
const CHOP_READ_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"value": None, "t": None, "td_paused": False, "error": None}
try:
    import td as _td
    _o = op(_p["path"])
    if _o is None:
        report["error"] = "op not found: " + str(_p["path"])
    else:
        try:
            _ch = _o[_p["channel"]]
            report["value"] = float(_ch[0]) if _ch is not None else 0.0
        except Exception as _e:
            report["error"] = "channel read: " + str(_e)
        try:
            report["td_paused"] = not bool(_td.project.time.play)
        except Exception:
            pass
        try:
            import time as _time
            report["t"] = _time.time()
        except Exception:
            pass
except Exception:
    report["error"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

interface ChopReadReport {
  value: number | null;
  t: number | null;
  td_paused: boolean;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Summary written to stderr on exit
// ---------------------------------------------------------------------------
export interface SoundcheckSummary {
  ticks: number;
  clipAlerts: number;
  silenceAlerts: number;
  bridgeErrors: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------
export async function runSoundcheckMonitor(
  ctx: ToolContext,
  rawOpts: Partial<SoundcheckMonitorOpts>,
  signal?: AbortSignal,
): Promise<SoundcheckSummary> {
  const opts = soundcheckMonitorSchema.parse(rawOpts);

  const startMs = Date.now();

  // Stderr helpers — always human-readable
  const fmt = (d: Date) =>
    `[${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}]`;

  const emitErr = (msg: string) => process.stderr.write(`${msg}\n`);
  const emitOut = (ev: SoundcheckEvent) => {
    if (opts.format === "ndjson") {
      process.stdout.write(`${JSON.stringify(ev)}\n`);
    } else {
      // pretty: T\tCHAN\tVALUE\tRMS\tPEAK for tick events only
      if (ev.type === "tick") {
        process.stdout.write(
          `${ev.t}\t${ev.channel}\t${ev.value.toFixed(4)}\t${ev.stats.rms.toFixed(4)}\t${ev.stats.peak.toFixed(4)}\n`,
        );
      } else {
        process.stdout.write(`${JSON.stringify(ev)}\n`);
      }
    }
  };

  emitErr(
    `Monitoring ${opts.audioSource}[${opts.channel}] @ ${opts.sampleRateMs} ms\n` +
      `(thresholds: clip=${opts.clipThreshold} silence=${opts.silenceThreshold}/${opts.silenceWindowMs}ms  window=${opts.windowMs}ms)`,
  );

  // Ring buffer: evict samples older than max(windowMs, silenceWindowMs)
  const maxBufferMs = Math.max(opts.windowMs, opts.silenceWindowMs);
  const buffer: Sample[] = [];

  let armed: ArmedState = { clip: null, silence: null };
  let ticks = 0;
  let clipAlerts = 0;
  let silenceAlerts = 0;
  let bridgeErrors = 0;

  const script = buildPayloadScript(CHOP_READ_SCRIPT, {
    path: opts.audioSource,
    channel: opts.channel,
  });

  const tick = async (): Promise<void> => {
    const now = Date.now();

    let value: number;
    let tdPaused = false;

    try {
      const exec = await ctx.client.executePythonScript(script, true);
      const report = parsePythonReport<ChopReadReport>(exec.stdout);
      if (report.error) {
        const ev: BridgeErrorEvent = { type: "bridge_error", t: now, error: report.error };
        emitOut(ev);
        emitErr(`${fmt(new Date())} BRIDGE ERROR  ${report.error}`);
        bridgeErrors++;
        return;
      }
      value = report.value ?? 0;
      tdPaused = report.td_paused ?? false;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const ev: BridgeErrorEvent = { type: "bridge_error", t: now, error: msg };
      emitOut(ev);
      emitErr(`${fmt(new Date())} BRIDGE ERROR  ${msg}`);
      bridgeErrors++;
      return;
    }

    // Push sample and evict old entries
    buffer.push({ t: now, value });
    const cutoff = now - maxBufferMs;
    while (buffer.length > 0 && (buffer[0]?.t ?? 0) < cutoff) {
      buffer.shift();
    }

    const { stats, alerts, recoveries, newArmed } = evaluateWindow(buffer, now, armed, opts);
    armed = newArmed;
    ticks++;

    const tickEv: TickEvent = {
      type: "tick",
      t: now,
      channel: opts.channel,
      value,
      stats,
    };
    emitOut(tickEv);

    for (const a of alerts) {
      if (a.level === "clip") {
        clipAlerts++;
        const ev: AlertEvent = {
          type: "alert",
          t: now,
          level: "clip",
          peak: a.peak,
          threshold: a.threshold,
          tdPaused,
        };
        emitOut(ev);
        emitErr(
          `${fmt(new Date())} CLIP   peak=${(a.peak ?? 0).toFixed(4)} (threshold ${a.threshold})`,
        );
      } else {
        silenceAlerts++;
        const ev: AlertEvent = {
          type: "alert",
          t: now,
          level: "silence",
          silentForMs: a.silentForMs,
          threshold: a.threshold,
          tdPaused,
        };
        emitOut(ev);
        emitErr(
          `${fmt(new Date())} SILENCE  silent=${a.silentForMs ?? 0}ms (threshold ${a.threshold})${tdPaused ? " [TD PAUSED]" : ""}`,
        );
      }
    }

    for (const r of recoveries) {
      const ev: RecoverEvent = { type: "recover", t: now, level: r.level };
      emitOut(ev);
      emitErr(`${fmt(new Date())} ${r.level} cleared`);
    }
  };

  // Main loop
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const loop = () => {
      if (signal?.aborted) {
        if (timer !== null) clearTimeout(timer);
        resolve();
        return;
      }
      void tick().then(() => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        timer = setTimeout(loop, opts.sampleRateMs);
      });
    };

    signal?.addEventListener("abort", () => {
      if (timer !== null) clearTimeout(timer);
      resolve();
    });

    loop();
  });

  const durationMs = Date.now() - startMs;
  const summary: SoundcheckSummary = { ticks, clipAlerts, silenceAlerts, bridgeErrors, durationMs };

  const durationSec = Math.floor(durationMs / 1000);
  const mins = Math.floor(durationSec / 60);
  const secs = durationSec % 60;
  const durationStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

  emitErr(
    `Summary: ${ticks} ticks, ${clipAlerts} clip, ${silenceAlerts} silence, ${bridgeErrors} bridge errors over ${durationStr}`,
  );

  return summary;
}
