export class OAuthClockRollbackError extends Error {
  override readonly name = "OAuthClockRollbackError";
}

/**
 * OAuth lifetimes use epoch seconds because they are persisted and exchanged
 * across protocol boundaries. A backwards wall-clock step could otherwise
 * extend a code, consent, client, or token lifetime. Latch the first invalid or
 * backwards observation so the process fails closed until it is restarted.
 */
export function createRollbackGuardedClock(clock: () => number): () => number {
  let lastObserved: number | undefined;
  let failed = false;

  return () => {
    if (failed) throw new OAuthClockRollbackError("OAuth clock safety check failed");
    const now = clock();
    if (!Number.isInteger(now) || now < 0 || (lastObserved !== undefined && now < lastObserved)) {
      failed = true;
      throw new OAuthClockRollbackError("OAuth clock safety check failed");
    }
    lastObserved = now;
    return now;
  };
}
