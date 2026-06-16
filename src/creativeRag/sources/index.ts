/**
 * Creative RAG — source registry.
 *
 * The three live adapters plus a name-based resolver for the CLI `--source` key.
 * The planned stubs live in `plannedStubs.ts` and are never wired into `sync`.
 */

import type { Source } from "../types.js";
import { articSource } from "./artic.js";
import { clevelandSource } from "./cleveland.js";
import { metSource } from "./met.js";
import { rijksmuseumSource } from "./rijksmuseum.js";

export const LIVE_SOURCES: Source[] = [articSource, rijksmuseumSource, metSource, clevelandSource];

/**
 * Resolve the live sources to use for a run. With no names, all live sources are
 * returned; otherwise only those whose `name` matches a requested key (first-seen
 * order, duplicates collapsed, unknown keys ignored) — so a repeated `--source`
 * never fetches the same source twice.
 */
export function resolveSources(names?: string[]): Source[] {
  if (!names || names.length === 0) return [...LIVE_SOURCES];
  const byName = new Map(LIVE_SOURCES.map((source) => [source.name, source]));
  const resolved: Source[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const source = byName.get(name);
    if (source) resolved.push(source);
  }
  return resolved;
}

export { PLANNED_SOURCE_STUBS } from "./plannedStubs.js";
export { articSource, clevelandSource, metSource, rijksmuseumSource };
