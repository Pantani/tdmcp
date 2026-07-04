import { performance } from "node:perf_hooks";
import type { Logger } from "../utils/logger.js";

/** Real async delay backed by `setTimeout`, resolving after `ms` milliseconds. */
function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RateGateOptions {
  slowMs: number;
  cooldownMs: number;
  /** Monotonic clock in ms. Injected in tests; defaults to `performance.now()`. */
  now?: () => number;
  /** Async delay. Injected in tests to resolve immediately; defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  logger?: Pick<Logger, "debug">;
}

/**
 * Reactive rate gate: a slow tool call arms a cooldown that the NEXT call pays.
 * A slow call never delays itself — it delays whatever call follows, exactly
 * like Derivative's official TDMCP `request_gate.py`. Fast calls stay fast.
 *
 * Clock and sleep are injectable so tests exercise the timing logic with zero
 * real elapsed time. The default clock is monotonic (`performance.now()`), so a
 * system-clock adjustment cannot skew the computed wait.
 */
export class RateGate {
  private readonly slowMs: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger?: Pick<Logger, "debug">;
  /** Absolute clock time before which the next call must wait. 0 = no pending cooldown. */
  private cooldownUntil = 0;

  constructor(options: RateGateOptions) {
    this.slowMs = options.slowMs;
    this.cooldownMs = options.cooldownMs;
    this.now = options.now ?? (() => performance.now());
    this.sleep = options.sleep ?? realSleep;
    this.logger = options.logger;
  }

  /** The injected monotonic clock — used by `wrapWithRateGate` to time handlers. */
  nowMs(): number {
    return this.now();
  }

  /** Await any armed cooldown before the next call runs. */
  async beforeCall(): Promise<void> {
    if (this.cooldownUntil <= 0) return;
    const wait = this.cooldownUntil - this.now();
    this.cooldownUntil = 0; // consume the arming regardless of remaining wait
    if (wait > 0) {
      this.logger?.debug("rate gate cooldown", { waitMs: wait });
      await this.sleep(wait);
    }
  }

  /** Record a completed call's duration; arm a cooldown if it was slow. */
  afterCall(durationMs: number): void {
    if (durationMs > this.slowMs) {
      this.cooldownUntil = this.now() + this.cooldownMs;
    }
  }
}

/**
 * Wraps a tool handler so the rate gate pays any armed cooldown before it runs
 * and records its wall-clock duration after. `try/finally` (not `catch`) so a
 * handler error propagates untouched while the duration is still recorded.
 */
export function wrapWithRateGate<A, R>(
  gate: RateGate,
  handler: (args: A) => Promise<R> | R,
): (args: A) => Promise<R> {
  return async (args: A): Promise<R> => {
    await gate.beforeCall();
    const start = gate.nowMs();
    try {
      return await handler(args);
    } finally {
      gate.afterCall(gate.nowMs() - start);
    }
  };
}

/**
 * Builds a `RateGate` from config, enforcing the both-or-nothing enable rule.
 * Active iff both thresholds are > 0. A half-configured gate is disabled AND
 * warned about (loud, not silent). Both 0 → disabled with no warning.
 */
export function rateGateFromConfig(
  config: { rateLimitSlowMs: number; rateLimitCooldownMs: number },
  logger: Logger,
  deps: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): RateGate | undefined {
  const slow = config.rateLimitSlowMs;
  const cool = config.rateLimitCooldownMs;
  if (slow <= 0 && cool <= 0) return undefined;
  if (slow <= 0 || cool <= 0) {
    logger.warn(
      "rate gate disabled: both TDMCP_RATE_LIMIT_SLOW_MS and TDMCP_RATE_LIMIT_COOLDOWN_MS must be > 0",
      { slow, cool },
    );
    return undefined;
  }
  logger.info("rate gate active", { slowMs: slow, cooldownMs: cool });
  return new RateGate({ slowMs: slow, cooldownMs: cool, ...deps, logger });
}
