import { describe, expect, it, vi } from "vitest";
import { RateGate, rateGateFromConfig, wrapWithRateGate } from "../../src/server/rateGate.js";
import { silentLogger } from "../../src/utils/logger.js";

/** A clock the test drives explicitly. */
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

/** A sleep that resolves instantly and records every ms it was asked to wait. */
function sleepSpy() {
  const calls: number[] = [];
  const sleep = vi.fn(async (ms: number) => {
    calls.push(ms);
  });
  return { sleep, calls };
}

describe("RateGate", () => {
  it("a fast call arms nothing — the next beforeCall never waits", async () => {
    const clock = fakeClock(0);
    const { sleep, calls } = sleepSpy();
    const gate = new RateGate({ slowMs: 10, cooldownMs: 100, now: clock.now, sleep });

    await gate.beforeCall();
    gate.afterCall(5); // 5 <= 10, not slow

    await gate.beforeCall();
    expect(calls).toHaveLength(0);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("a slow call arms a cooldown the next call pays", async () => {
    const clock = fakeClock(0);
    const { sleep, calls } = sleepSpy();
    const gate = new RateGate({ slowMs: 10, cooldownMs: 100, now: clock.now, sleep });

    gate.afterCall(50); // arms cooldownUntil = 0 + 100 = 100
    clock.advance(30); // now = 30

    await gate.beforeCall(); // wait = 100 - 30 = 70
    expect(calls).toEqual([70]);
  });

  it("consumes the cooldown once — the following call does not wait again", async () => {
    const clock = fakeClock(0);
    const { sleep, calls } = sleepSpy();
    const gate = new RateGate({ slowMs: 10, cooldownMs: 100, now: clock.now, sleep });

    gate.afterCall(50);
    await gate.beforeCall(); // pays it
    await gate.beforeCall(); // nothing left
    expect(calls).toHaveLength(1);
  });

  it("does not wait when the cooldown has already elapsed", async () => {
    const clock = fakeClock(0);
    const { sleep, calls } = sleepSpy();
    const gate = new RateGate({ slowMs: 10, cooldownMs: 100, now: clock.now, sleep });

    gate.afterCall(50); // cooldownUntil = 100
    clock.set(200); // already past it → wait <= 0

    await gate.beforeCall();
    expect(calls).toHaveLength(0);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("treats the slow threshold as strict `>` — duration == slowMs does not arm", async () => {
    const clock = fakeClock(0);
    const { sleep, calls } = sleepSpy();
    const gate = new RateGate({ slowMs: 10, cooldownMs: 100, now: clock.now, sleep });

    gate.afterCall(10); // exactly at threshold, not slow
    await gate.beforeCall();
    expect(calls).toHaveLength(0);
  });
});

describe("wrapWithRateGate", () => {
  it("preserves the handler result and forwards args untouched", async () => {
    const clock = fakeClock(0);
    const { sleep } = sleepSpy();
    const gate = new RateGate({ slowMs: 10, cooldownMs: 100, now: clock.now, sleep });

    const handler = vi.fn(async (args: { a: number }) => ({ ok: args.a * 2 }));
    const wrapped = wrapWithRateGate(gate, handler);

    const result = await wrapped({ a: 21 });
    expect(result).toEqual({ ok: 42 });
    expect(handler).toHaveBeenCalledWith({ a: 21 });
  });

  it("records duration on a throwing handler and re-throws (not swallowed)", async () => {
    const clock = fakeClock(0);
    const { sleep, calls } = sleepSpy();
    const gate = new RateGate({ slowMs: 10, cooldownMs: 100, now: clock.now, sleep });

    const boom = new Error("handler failed");
    const wrapped = wrapWithRateGate(gate, async () => {
      clock.advance(50); // handler takes 50ms of monotonic time
      throw boom;
    });

    await expect(wrapped(undefined)).rejects.toBe(boom);

    // The 50ms duration was recorded despite the throw → a cooldown is now armed.
    await gate.beforeCall();
    expect(calls).toHaveLength(1); // paid the cooldown from the failed-but-slow call
  });

  it("measures a fast handler and arms nothing", async () => {
    const clock = fakeClock(0);
    const { sleep, calls } = sleepSpy();
    const gate = new RateGate({ slowMs: 10, cooldownMs: 100, now: clock.now, sleep });

    const wrapped = wrapWithRateGate(gate, async () => {
      clock.advance(3); // fast
      return "ok";
    });

    await wrapped(undefined);
    await gate.beforeCall();
    expect(calls).toHaveLength(0);
  });
});

describe("rateGateFromConfig", () => {
  it("returns undefined with no warning when both are 0", () => {
    const warn = vi.fn();
    const logger = { ...silentLogger, warn };
    const gate = rateGateFromConfig({ rateLimitSlowMs: 0, rateLimitCooldownMs: 0 }, logger);
    expect(gate).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns and disables when only slowMs is set", () => {
    const warn = vi.fn();
    const logger = { ...silentLogger, warn };
    const gate = rateGateFromConfig({ rateLimitSlowMs: 100, rateLimitCooldownMs: 0 }, logger);
    expect(gate).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("warns and disables when only cooldownMs is set", () => {
    const warn = vi.fn();
    const logger = { ...silentLogger, warn };
    const gate = rateGateFromConfig({ rateLimitSlowMs: 0, rateLimitCooldownMs: 100 }, logger);
    expect(gate).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("returns a RateGate and logs info when both are set", () => {
    const info = vi.fn();
    const logger = { ...silentLogger, info };
    const gate = rateGateFromConfig({ rateLimitSlowMs: 100, rateLimitCooldownMs: 200 }, logger);
    expect(gate).toBeInstanceOf(RateGate);
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("forwards injected now/sleep deps into the created gate", async () => {
    const clock = fakeClock(0);
    const { sleep, calls } = sleepSpy();
    const gate = rateGateFromConfig(
      { rateLimitSlowMs: 10, rateLimitCooldownMs: 100 },
      silentLogger,
      { now: clock.now, sleep },
    );
    expect(gate).toBeDefined();

    gate?.afterCall(50);
    clock.advance(30);
    await gate?.beforeCall();
    expect(calls).toEqual([70]); // proves the injected clock+sleep are wired in
  });
});
