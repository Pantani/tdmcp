/**
 * Project RAG — source-adapter control errors.
 *
 * Mirrors the Creative RAG `SourceSkippedError` convention: an adapter raises
 * this when a hard pre-condition is missing (no token + unauthenticated quota
 * hit, missing local install, etc). The service treats it as a no-op skip —
 * NEVER as a fetch returning zero items — so cards from that source are not
 * tombstoned.
 */

export class SourceSkippedError extends Error {
  readonly sourceName: string;
  readonly hint: string;

  constructor(sourceName: string, hint: string) {
    super(`${sourceName} skipped: ${hint}`);
    this.name = "ProjectRagSourceSkippedError";
    this.sourceName = sourceName;
    this.hint = hint;
  }
}
