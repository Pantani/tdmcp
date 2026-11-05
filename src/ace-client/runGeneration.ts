import type { ToolExtra } from "../tools/types.js";
import type { Logger } from "../utils/logger.js";
import type { AceStepClient } from "./aceStepClient.js";
import { AceApiError, AceTimeoutError } from "./types.js";
import type { AceGenerateRequest, GenerateResult, JobStatus } from "./validators.js";

/**
 * The single generation driver shared by `generate_music`,
 * `generate_music_reactive` and `submit_music_job`: submit -> poll -> emit honest
 * progress -> honor client aborts -> decide sync-vs-job.
 *
 * What we report as progress is real elapsed wall-clock plus the server's own
 * job state; `total` is omitted (MCP-legal indeterminate progress) unless the
 * operator calibrated `TDMCP_ACE_RTF`. No fake percentages.
 */

/** Rough stand-in when the model picks the length, used only for the RTF estimate. */
export const UNSPECIFIED_DURATION_ASSUMPTION = 120;

export interface RunGenerationOptions {
  /** Per-call MCP context. Undefined on the CLI path -> progress + abort are no-ops. */
  extra?: ToolExtra;
  /** "auto" (estimate decides), "sync" (always block), "job" (always return a job_id). */
  mode: "auto" | "sync" | "job";
  /** TDMCP_ACE_SYNC_MAX_SECONDS. Estimates above this go async in "auto". */
  syncMaxSeconds: number;
  /**
   * TDMCP_ACE_RTF — wall-clock seconds of compute per second of audio at
   * `defaultSteps`. 0/undefined = UNCALIBRATED -> no estimate, no `total`, and
   * "auto" stays SYNC.
   */
  rtf?: number;
  /** TDMCP_ACE_DEFAULT_STEPS — the RTF calibration baseline. */
  defaultSteps: number;
  /** TDMCP_ACE_POLL_MS — poll + progress cadence. */
  pollMs: number;
  /** TDMCP_ACE_TIMEOUT_MS — how long a blocking generation may run. */
  timeoutMs: number;
  logger?: Logger;
  /** Injectable clock/sleep for deterministic tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type RunGenerationOutcome =
  | { kind: "sync"; result: GenerateResult; elapsedSeconds: number; observedRtf?: number }
  | { kind: "job"; jobId: string; estimatedSeconds?: number };

/** Conservative estimator: `undefined` whenever RTF is uncalibrated. */
export function estimateSeconds(
  req: AceGenerateRequest,
  opts: { rtf?: number; defaultSteps: number },
): number | undefined {
  if (!opts.rtf || opts.rtf <= 0) return undefined;
  const audio = req.audio_duration ?? UNSPECIFIED_DURATION_ASSUMPTION;
  return audio * opts.rtf * stepScale(req, opts.defaultSteps);
}

/** Diffusion steps are ~linear in wall-clock, so scale the estimate by them. */
function stepScale(req: AceGenerateRequest, defaultSteps: number): number {
  const steps = req.inference_steps ?? defaultSteps;
  return defaultSteps > 0 ? steps / defaultSteps : 1;
}

export interface ProgressReporter {
  emit(progressSeconds: number, message: string): void;
}

const NOOP_REPORTER: ProgressReporter = { emit: () => {} };

/**
 * MCP `notifications/progress` emitter. Silent unless the client supplied a
 * `progressToken`. `progress` is elapsed seconds (real); `total` is the RTF
 * estimate and is OMITTED when uncalibrated. Notification failures are swallowed:
 * progress must never be able to fail a generation.
 */
export function progressReporter(
  extra: ToolExtra | undefined,
  total: number | undefined,
): ProgressReporter {
  const token = extra?._meta?.progressToken;
  if (extra === undefined || token === undefined) return NOOP_REPORTER;
  let last = -1;
  return {
    emit(progressSeconds: number, message: string) {
      // Never report 100% before the audio exists.
      const progress =
        total !== undefined ? Math.min(progressSeconds, total * 0.99) : progressSeconds;
      if (progress <= last) return; // MCP requires strictly increasing progress
      last = progress;
      void extra
        .sendNotification({
          method: "notifications/progress",
          params: {
            progressToken: token,
            progress,
            ...(total !== undefined ? { total } : {}),
            message,
          },
        })
        .catch(() => {});
    },
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wall-clock per audio-second, normalized back to the `defaultSteps` baseline. */
function observedRtf(
  req: AceGenerateRequest,
  seconds: number,
  elapsedSeconds: number,
  defaultSteps: number,
): number | undefined {
  if (seconds <= 0 || elapsedSeconds <= 0) return undefined;
  const scale = stepScale(req, defaultSteps);
  if (scale <= 0) return undefined;
  return elapsedSeconds / seconds / scale;
}

/**
 * Throws `AceError` subclasses on transport/job failure — by design: every caller
 * wraps this in `guardAce()`, which turns them into friendly `isError` results.
 */
export async function runGeneration(
  client: AceStepClient,
  req: AceGenerateRequest,
  opts: RunGenerationOptions,
): Promise<RunGenerationOutcome> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const est = estimateSeconds(req, opts);
  const wantJob =
    opts.mode === "job" || (opts.mode === "auto" && est !== undefined && est > opts.syncMaxSeconds);
  const started = now();
  const elapsed = () => (now() - started) / 1000;
  const reporter = progressReporter(opts.extra, est);

  const { job_id: jobId } = await client.submitGenerate(req);

  if (wantJob) {
    reporter.emit(0, `job ${jobId} submitted`);
    return { kind: "job", jobId, estimatedSeconds: est };
  }
  return pollToCompletion(client, req, jobId, opts, {
    reporter,
    elapsed,
    sleep,
    signal: opts.extra?.signal,
  });
}

interface PollDeps {
  reporter: ProgressReporter;
  elapsed: () => number;
  sleep: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

/**
 * Maps a terminal job status to an outcome (or throws on error).
 * Returns `undefined` while the job is still running, so the poll loop keeps going.
 */
function terminalOutcome(
  st: JobStatus,
  req: AceGenerateRequest,
  elapsedSeconds: number,
  defaultSteps: number,
): RunGenerationOutcome | undefined {
  if (st.status === "error") throw new AceApiError(st.error ?? "ACE-Step job failed.");
  if (st.status !== "done") return undefined;
  if (!st.wavPath) throw new AceApiError("ACE-Step job finished without an audio file.");
  // Upstream may omit both when the model chose the length and the seed: 0 = unknown.
  const seconds = st.seconds ?? req.audio_duration ?? 0;
  const seed = st.seed ?? req.seed;
  return {
    kind: "sync",
    result: { wavPath: st.wavPath, seconds, ...(seed !== undefined ? { seed } : {}) },
    elapsedSeconds,
    observedRtf: observedRtf(req, seconds, elapsedSeconds, defaultSteps),
  };
}

function statusMessage(st: JobStatus, elapsedSeconds: number): string {
  return `${st.stage ?? st.status} — ${Math.round(elapsedSeconds)}s elapsed`;
}

/**
 * Upstream has no cancel route, so aborting or timing out only stops the waiting.
 * Both errors say so and name the job: the server keeps generating, and the result
 * can still be collected.
 */
async function pollToCompletion(
  client: AceStepClient,
  req: AceGenerateRequest,
  jobId: string,
  opts: RunGenerationOptions,
  deps: PollDeps,
): Promise<RunGenerationOutcome> {
  const stopIfAsked = () => {
    if (deps.signal?.aborted) {
      throw new AceApiError(
        `Stopped waiting: the client cancelled. ACE-Step has no cancel API, so job ${jobId} keeps running on the server; collect it later with get_music_job.`,
      );
    }
    if (deps.elapsed() * 1000 > opts.timeoutMs) {
      throw new AceTimeoutError(
        `Stopped waiting after ${opts.timeoutMs}ms (TDMCP_ACE_TIMEOUT_MS). Job ${jobId} keeps running on the server; collect it later with get_music_job.`,
      );
    }
  };
  for (;;) {
    stopIfAsked();
    const st = await client.getJob(jobId);
    const elapsedSeconds = deps.elapsed();
    deps.reporter.emit(elapsedSeconds, statusMessage(st, elapsedSeconds));
    const outcome = terminalOutcome(st, req, elapsedSeconds, opts.defaultSteps);
    if (outcome) return outcome;
    await deps.sleep(opts.pollMs);
  }
}
