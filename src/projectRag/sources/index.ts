/**
 * Project RAG — source registry.
 *
 * Resolves the live source adapters for a sync run. F1 ships only the
 * `github-repo` adapter (parameterised by `TDMCP_PROJECT_RAG_GITHUB_REPOS`,
 * defaulting to `torinmb/mediapipe-touchdesigner`). Future phases add
 * `github-topic`, `derivative-local`, awesome-list discovery, etc.
 */

import { derivativeLocalSource } from "./derivativeLocal.js";
import { githubRepoSource, parseRepoListEnv } from "./githubRepo.js";
import { githubTopicSource, parseTopicListEnv } from "./githubTopic.js";
import type { SourceAdapter } from "./types.js";

export interface ResolveSourcesOptions {
  /** CSV from `TDMCP_PROJECT_RAG_GITHUB_REPOS` (default seed when undefined). */
  githubReposCsv?: string;
  /**
   * CSV from `TDMCP_PROJECT_RAG_GITHUB_TOPICS`. When undefined, the topic
   * scanner is registered but uses {@link DEFAULT_TOPICS}. To DISABLE it set
   * the env var to the literal `off`.
   */
  githubTopicsCsv?: string;
  /** Per-sync hard cap for the topic scanner (default 25). */
  topicCap?: number;
  /**
   * Explicit TouchDesigner install root for the `derivative-local` source
   * (from `TDMCP_PROJECT_RAG_DERIVATIVE_ROOT`). When undefined the source probes
   * OS-default install locations and skips itself when none is found.
   */
  derivativeRoot?: string;
  /** Restrict to specific source names (CLI `--source`). */
  names?: string[];
}

export function resolveProjectSources(opts: ResolveSourcesOptions = {}): SourceAdapter[] {
  const all: SourceAdapter[] = [githubRepoSource(parseRepoListEnv(opts.githubReposCsv))];
  if (opts.githubTopicsCsv !== "off") {
    const topics = parseTopicListEnv(opts.githubTopicsCsv);
    const topicOpts: { topics: string[]; cap?: number } = { topics };
    if (opts.topicCap !== undefined) topicOpts.cap = opts.topicCap;
    all.push(githubTopicSource(topicOpts));
  }
  all.push(
    derivativeLocalSource(
      opts.derivativeRoot !== undefined ? { installRoot: opts.derivativeRoot } : {},
    ),
  );
  if (opts.names === undefined || opts.names.length === 0) return all;
  const wanted = new Set(opts.names);
  return all.filter((s) => wanted.has(s.name));
}

export type { DerivativeLocalOptions } from "./derivativeLocal.js";
export { derivativeLocalSource } from "./derivativeLocal.js";
export { SourceSkippedError } from "./errors.js";
export {
  DEFAULT_GITHUB_REPOS,
  githubRepoSource,
  parseRepoListEnv,
  parseRepoSpec,
} from "./githubRepo.js";
export type { GithubTopicSourceOptions } from "./githubTopic.js";
export {
  DEFAULT_TOPICS,
  githubTopicSource,
  parseTopicListEnv,
} from "./githubTopic.js";
export type { RawProjectItem, SourceAdapter, SourceAdapterContext } from "./types.js";
