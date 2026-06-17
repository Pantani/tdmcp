/**
 * Creative RAG — versioned JSONL index line (serialize + tolerant parse).
 *
 * Each index line is a single {@link EmbeddedCard} wrapped with an
 * `indexVersion` tag so the on-disk format can evolve without dropping
 * persisted cards. The version lives ONLY on the line wrapper — it is never a
 * field of {@link EmbeddedCard} — so {@link parseIndexLine} strips it before
 * returning the card.
 *
 * Migration is tolerant:
 * - A legacy line (no `indexVersion`) is treated as v0 and migrated forward as
 *   long as it passes the {@link isEmbeddedCard} shape check — never dropped.
 * - A line tagged with a FUTURE version (> {@link INDEX_LINE_VERSION}) is
 *   skipped (`undefined`) rather than crashing an older reader.
 * - Malformed JSON or a failing shape check yields `undefined`.
 */

import type { EmbeddedCard } from "./types.js";

export const INDEX_LINE_VERSION = 1 as const;

/** Serialize an EmbeddedCard to a JSONL line tagged with indexVersion. */
export function serializeIndexLine(card: EmbeddedCard): string {
  return JSON.stringify({ indexVersion: INDEX_LINE_VERSION, ...card });
}

/** Parse one JSONL line tolerantly: legacy (no indexVersion) migrates to current; malformed ⇒ undefined. */
export function parseIndexLine(line: string): EmbeddedCard | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Malformed JSON line — skip defensively.
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const { indexVersion, ...rest } = parsed as Record<string, unknown>;
  if (typeof indexVersion === "number" && indexVersion > INDEX_LINE_VERSION) {
    // Future version written by a newer build — skip rather than crash.
    return undefined;
  }
  // `indexVersion` absent ⇒ legacy/v0 line, migrated on the next write.
  return isEmbeddedCard(rest) ? rest : undefined;
}

/** Structural guard mirroring the EmbeddedCard contract (ported from indexStore). */
export function isEmbeddedCard(value: unknown): value is EmbeddedCard {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const card = value as Record<string, unknown>;
  return (
    typeof card.id === "string" &&
    typeof card.contentHash === "string" &&
    typeof card.embeddingModel === "string" &&
    Array.isArray(card.embedding) &&
    card.embedding.length > 0 &&
    card.embedding.every((n) => typeof n === "number" && Number.isFinite(n)) &&
    typeof card.title === "string" &&
    typeof card.type === "string" &&
    typeof card.license === "string" &&
    typeof card.sourceUrl === "string" &&
    typeof card.sourceName === "string" &&
    Array.isArray(card.tags) &&
    card.tags.every((tag) => typeof tag === "string") &&
    (card.rightsNotes === undefined || typeof card.rightsNotes === "string")
  );
}
