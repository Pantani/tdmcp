/**
 * Creative RAG — source-adapter control errors.
 *
 * A source raises {@link SourceSkippedError} when it could NOT produce a trustworthy
 * comparison this run. This is deliberately distinct from "synced and returned zero
 * items": a skipped source MUST NOT count as a successful sync, otherwise `service.sync`
 * would tombstone every previously-synced card from that source (it saw none this run).
 * The sync loop catches this, logs a clear skip line, and leaves the source's existing
 * cards untouched.
 *
 * The `reason` discriminates two skip causes that look identical on disk (both yield no
 * items) but mean opposite things:
 *  - `"no-key"`  — a key-gated source has no credential configured. It never even
 *                  reached the upstream, so an empty result is meaningless. (Default:
 *                  the historical single meaning of this error.)
 *  - `"empty"`   — the source DID reach the upstream (key present / not key-gated) but
 *                  the response was empty in a way it cannot vouch for (e.g. a keyed
 *                  request that returned zero items, which may be a silent upstream
 *                  outage rather than a genuinely empty catalog). Signalling `"empty"`
 *                  keeps the sync from tombstoning on an untrustworthy zero.
 *
 * Both reasons are non-tombstoning by design — the discriminator only changes how the
 * skip is logged and lets callers/tests tell a misconfigured key-gated source apart from
 * a real-but-untrusted empty result, so a bad key never masquerades as an empty catalog.
 */

export type SourceSkipReason = "no-key" | "empty";

export class SourceSkippedError extends Error {
  readonly sourceName: string;
  readonly envKey: string;
  readonly reason: SourceSkipReason;

  constructor(sourceName: string, envKey: string, reason: SourceSkipReason = "no-key") {
    super(
      reason === "no-key"
        ? `${sourceName} source skipped: set ${envKey}`
        : `${sourceName} source skipped: upstream returned an untrusted empty result`,
    );
    this.name = "SourceSkippedError";
    this.sourceName = sourceName;
    this.envKey = envKey;
    this.reason = reason;
  }
}
