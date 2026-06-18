/**
 * Project RAG — source registry.
 *
 * Resolves the live source adapters for a sync run. F1 ships only the
 * `github-repo` adapter (parameterised by `TDMCP_PROJECT_RAG_GITHUB_REPOS`,
 * defaulting to `torinmb/mediapipe-touchdesigner`). Future phases add
 * `github-topic`, `derivative-local`, awesome-list discovery, etc.
 */

import { githubRepoSource, parseRepoListEnv } from "./githubRepo.js";
import type { SourceAdapter } from "./types.js";

export interface ResolveSourcesOptions {
  /** CSV from `TDMCP_PROJECT_RAG_GITHUB_REPOS` (default seed when undefined). */
  githubReposCsv?: string;
  /** Restrict to specific source names (CLI `--source`). */
  names?: string[];
}

export function resolveProjectSources(opts: ResolveSourcesOptions = {}): SourceAdapter[] {
  const all: SourceAdapter[] = [githubRepoSource(parseRepoListEnv(opts.githubReposCsv))];
  if (opts.names === undefined || opts.names.length === 0) return all;
  const wanted = new Set(opts.names);
  return all.filter((s) => wanted.has(s.name));
}

export { SourceSkippedError } from "./errors.js";
export {
  DEFAULT_GITHUB_REPOS,
  githubRepoSource,
  parseRepoListEnv,
  parseRepoSpec,
} from "./githubRepo.js";
export type { RawProjectItem, SourceAdapter, SourceAdapterContext } from "./types.js";
