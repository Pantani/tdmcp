import type { ToolExtra } from "../tools/types.js";
import type { Logger } from "../utils/logger.js";
import type { AceStepClient } from "./aceStepClient.js";
import { AceApiError } from "./types.js";
import type { AceGenerateRequest, GenerateResult } from "./validators.js";

/**
 * The single generation driver shared by `generate_music`,
 * `generate_music_reactive` and `submit_music_job`: submit -> poll -> emit honest
 * progress -> honor client cancellation -> decide sync-vs-job.
 *
 * Honesty constraint (see `_workspace/01_design_p2_ace.md`): ACE-Step exposes no
 * per-step hook, so there is NO real progress signal. What we report is real job
 * state plus real elapsed wall-clock; `total` is omitted (MCP-legal indeterminate
 * progress) unless the operator calibrated `TDMCP_ACE_RTF`. No fake percentages,
 * no tqdm scraping.
 */

/** ACE randomizes ~30-240 s when `audio_duration <= 0`; 120 is that midpoint. */
export const UNSPECIFIED_DURATION_ASSUMPTION = 120;

export interface RunGenerationOptions {
  /** Per-call MCP context (F4). Undefined on the CLI path -> progress + abort are no-ops. */
  extra?: ToolExtra;
  /** "auto" (F6 decision), "sync" (always block), "job" (always return a job_id). */
  mode: "auto" | "sync" | "job";
  /** TDMCP_ACE_SYNC_MAX_SECONDS. Estimates above this go async in "auto". */
  syncMaxSeconds: number;
  /**
   * TDMCP_ACE_RTF — wall-clock seconds of compute per second of audio at
   * `defaultSteps`. 0/undefined = UNCALIBRATED -> no estimate, no `total`, and
   * "auto" stays SYNC (F6 is inert by default, on purpose).
   */
  rtf?: number;
  /** TDMCP_ACE_DEFAULT_STEPS — the RTF calibration baseline. */
  defaultSteps: number;
  /** TDMCP_ACE_POLL_MS — poll + progress cadence. */
  pollMs: number;
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
  const audio = req.audio_duration > 0 ? req.audio_duration : UNSPECIFIED_DURATION_ASSUMPTION;
  return audio * opts.rtf * stepScale(req, opts.defaultSteps);
}

/** Diffusion steps are ~linear in wall-clock, so scale the estimate by them. */
function stepScale(req: AceGenerateRequest, defaultSteps: number): number {
  const steps = req.infer_step ?? defaultSteps;
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
      // Never report 100% before the WAV exists.
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

  if (client.mode === "native") {
    return runNative(client, req, opts, { est, wantJob, elapsed });
  }

  const { job_id: jobId } = await client.submitGenerate(req);

  if (wantJob) {
    progressReporter(opts.extra, est).emit(0, `job ${jobId} submitted`);
    return { kind: "job", jobId, estimatedSeconds: est };
  }

  const reporter = progressReporter(opts.extra, est);
  const signal = opts.extra?.signal;
  const onAbort = () => {
    void client.cancelJob(jobId).catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await pollToCompletion(client, req, jobId, opts, { reporter, elapsed, sleep, signal });
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

interface PollDeps {
  reporter: ProgressReporter;
  elapsed: () => number;
  sleep: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

async function pollToCompletion(
  client: AceStepClient,
  req: AceGenerateRequest,
  jobId: string,
  opts: RunGenerationOptions,
  deps: PollDeps,
): Promise<RunGenerationOutcome> {
  const cancelled = () => {
    if (deps.signal?.aborted) {
      throw new AceApiError(
        `Generation cancelled by the client (job ${jobId} killed; VRAM released).`,
      );
    }
  };
  for (;;) {
    cancelled();
    const st = await client.getJob(jobId);
    const elapsedSeconds = deps.elapsed();
    deps.reporter.emit(elapsedSeconds, `${st.status} — ${Math.round(elapsedSeconds)}s elapsed`);
    if (st.status === "done") {
      if (!st.wavPath) throw new AceApiError("ACE job finished without a wavPath.");
      const seconds = st.seconds ?? 0;
      return {
        kind: "sync",
        result: { wavPath: st.wavPath, seconds, seed: st.seed ?? 0 },
        elapsedSeconds,
        observedRtf: observedRtf(req, seconds, elapsedSeconds, opts.defaultSteps),
      };
    }
    if (st.status === "error") throw new AceApiError(st.error ?? "ACE job failed.");
    if (st.status === "cancelled") throw new AceApiError(`Job ${jobId} was cancelled.`);
    await deps.sleep(opts.pollMs);
    cancelled();
  }
}

/**
 * Native ACE (`infer-api.py`) has no job API: one blocking call, no cancellation,
 * heartbeat progress only (elapsed seconds — the honest maximum).
 */
async function runNative(
  client: AceStepClient,
  req: AceGenerateRequest,
  opts: RunGenerationOptions,
  ctx: { est?: number; wantJob: boolean; elapsed: () => number },
): Promise<RunGenerationOutcome> {
  if (ctx.wantJob) {
    throw new AceApiError(
      "Job control is not supported in native ACE mode (infer-api.py is synchronous " +
        "and has no job API). Set TDMCP_ACE_MODE=wrapper.",
    );
  }
  const reporter = progressReporter(opts.extra, ctx.est);
  reporter.emit(0, "generating (native, no job control — cannot cancel)");
  const heartbeat = setInterval(() => {
    const e = ctx.elapsed();
    reporter.emit(e, `running — ${Math.round(e)}s elapsed`);
  }, opts.pollMs);
  try {
    const result = await client.generate(req);
    const elapsedSeconds = ctx.elapsed();
    return {
      kind: "sync",
      result,
      elapsedSeconds,
      observedRtf: observedRtf(req, result.seconds, elapsedSeconds, opts.defaultSteps),
    };
  } finally {
    clearInterval(heartbeat);
  }
}
