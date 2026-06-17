/**
 * Creative RAG — source-adapter control errors.
 *
 * A key-gated source raises {@link SourceSkippedError} when its credential is
 * absent. This is deliberately distinct from "synced and returned zero items":
 * a skipped source MUST NOT count as a successful sync, otherwise `service.sync`
 * would tombstone every previously-synced card from that source (it saw none this
 * run). The sync loop catches this, logs a clear skip line, and leaves the
 * source's existing cards untouched.
 */

export class SourceSkippedError extends Error {
  readonly sourceName: string;
  readonly envKey: string;

  constructor(sourceName: string, envKey: string) {
    super(`${sourceName} source skipped: set ${envKey}`);
    this.name = "SourceSkippedError";
    this.sourceName = sourceName;
    this.envKey = envKey;
  }
}
