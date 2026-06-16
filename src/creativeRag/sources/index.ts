/**
 * Creative RAG — source registry.
 *
 * The three live adapters plus a name-based resolver for the CLI `--source` key.
 * The planned stubs live in `plannedStubs.ts` and are never wired into `sync`.
 */

import type { Source } from "../types.js";
import { articSource } from "./artic.js";
import { metSource } from "./met.js";
import { rijksmuseumSource } from "./rijksmuseum.js";

export const LIVE_SOURCES: Source[] = [articSource, rijksmuseumSource, metSource];

/**
 * Resolve the live sources to use for a run. With no names, all live sources are
 * returned; otherwise only those whose `name` matches a requested key (order of
 * `names`, unknown keys ignored).
 */
export function resolveSources(names?: string[]): Source[] {
  if (!names || names.length === 0) return [...LIVE_SOURCES];
  const byName = new Map(LIVE_SOURCES.map((source) => [source.name, source]));
  const resolved: Source[] = [];
  for (const name of names) {
    const source = byName.get(name);
    if (source) resolved.push(source);
  }
  return resolved;
}

export { PLANNED_SOURCE_STUBS } from "./plannedStubs.js";
export { articSource, metSource, rijksmuseumSource };
