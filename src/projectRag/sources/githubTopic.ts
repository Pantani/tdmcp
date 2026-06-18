/**
 * Project RAG — GitHub topic scanner.
 *
 * Uses the GitHub REST search API (`GET /search/repositories?q=topic:<t>`) to
 * discover public repos that self-tag with TouchDesigner-relevant topics. Each
 * page is filtered HARD before any further work:
 *
 *  1. SPDX allowlist (configurable; copyleft accepted but flagged downstream).
 *  2. Min stars + min `pushed_at` recency (cheap signal-quality gates).
 *  3. Per-sync cap (default 25) to avoid card explosion.
 *
 * Pagination uses GitHub's `page` query param; the adapter stops as soon as the
 * cap is met or the API returns an empty/incomplete page. Rate-limit (HTTP 403
 * with "rate limit" body) becomes a typed {@link SourceSkippedError} so prior
 * cards are not tombstoned by an empty result.
 *
 * Hard rule: this adapter ONLY surfaces metadata + READMEs + top-level file
 * listings. It does NOT clone repos or download binaries — the service's
 * license-gated binary path remains the single place that touches `.tox`/`.toe`
 * bytes.
 */

import { fetchGithubLicense } from "../extractors/githubLicense.js";
import { classifyFromSpdx } from "../licensePolicy.js";
import type { LicenseConfidence, ProjectRagLicense, ProjectRagType } from "../types.js";
import { SourceSkippedError } from "./errors.js";
import type { RawProjectItem, SourceAdapter, SourceAdapterContext } from "./types.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const README_BODY_BYTES_CAP = 32_768;
const TD_BINARY_EXTENSIONS = [".tox", ".toe"];
const SEARCH_PAGE_SIZE = 30;

/** Topics scanned by default. Order is preserved in result ranking. */
export const DEFAULT_TOPICS = [
  "touchdesigner-components",
  "touchdesigner-tool",
  "touchdesigner-tools",
  "touchdesigner",
] as const;

/** SPDX ids accepted as "clean permissive" (no copyleft flag). */
const DEFAULT_CLEAN_SPDX: ReadonlySet<string> = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "Unlicense",
  "CC0-1.0",
]);

/** SPDX ids accepted but marked copyleft. */
const DEFAULT_COPYLEFT_SPDX: ReadonlySet<string> = new Set([
  "GPL-2.0",
  "GPL-3.0",
  "LGPL-2.1",
  "LGPL-3.0",
  "AGPL-3.0",
]);

export interface GithubTopicSpec {
  topic: string;
  /** Min star count required (default 5). */
  minStars?: number;
  /** Repo must have been pushed at or after this ISO date (default 2024-01-01). */
  pushedSince?: string;
}

export interface GithubTopicSourceOptions {
  /** Topics to scan; defaults to {@link DEFAULT_TOPICS}. */
  topics?: readonly string[];
  /** Hard cap of repos converted to cards per sync run (default 25). */
  cap?: number;
  /** Min stars filter shared across all topics (default 5). */
  minStars?: number;
  /** Recency filter shared across all topics (default 2024-01-01). */
  pushedSince?: string;
}

interface GithubSearchItem {
  full_name: string;
  html_url: string;
  description?: string | null;
  default_branch?: string;
  topics?: string[];
  owner?: { login?: string };
  pushed_at?: string;
  stargazers_count?: number;
  fork?: boolean;
  license?: { spdx_id?: string | null } | null;
}

interface GithubSearchResponse {
  total_count?: number;
  incomplete_results?: boolean;
  items?: GithubSearchItem[];
}

interface GithubContentEntry {
  name: string;
  path: string;
  type: "file" | "dir" | string;
  download_url?: string | null;
}

/**
 * Build a topic-scanner source adapter. Use {@link parseTopicListEnv} to feed
 * topics from a CSV env var like `TDMCP_PROJECT_RAG_GITHUB_TOPICS`.
 */
export function githubTopicSource(options: GithubTopicSourceOptions = {}): SourceAdapter {
  const topics = options.topics ?? DEFAULT_TOPICS;
  const cap = options.cap ?? 25;
  const minStars = options.minStars ?? 5;
  const pushedSince = options.pushedSince ?? "2024-01-01";
  return {
    name: "github-topic",
    displayName: `GitHub topic scanner (${topics.join(", ")})`,
    async fetchItems(limit: number, ctx: SourceAdapterContext): Promise<RawProjectItem[]> {
      const fetchImpl = ctx.fetchImpl ?? fetch;
      const effectiveCap = Math.max(0, Math.min(cap, limit));
      if (effectiveCap === 0) return [];
      const items: RawProjectItem[] = [];
      const seen = new Set<string>();
      for (const topic of topics) {
        if (items.length >= effectiveCap) break;
        await scanTopic({
          topic,
          fetchImpl,
          ghToken: ctx.ghToken,
          minStars,
          pushedSince,
          remaining: () => effectiveCap - items.length,
          onItem: (item) => {
            if (seen.has(item.canonical)) return;
            seen.add(item.canonical);
            items.push(item);
          },
        });
      }
      return items;
    },
  };
}

/** Parse a CSV of topics; falls back to {@link DEFAULT_TOPICS} when empty. */
export function parseTopicListEnv(csv: string | undefined): string[] {
  if (csv === undefined || csv.trim().length === 0) return [...DEFAULT_TOPICS];
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface ScanArgs {
  topic: string;
  fetchImpl: typeof fetch;
  ghToken: string | undefined;
  minStars: number;
  pushedSince: string;
  remaining: () => number;
  onItem: (item: RawProjectItem) => void;
}

async function scanTopic(args: ScanArgs): Promise<void> {
  const { topic, fetchImpl, ghToken, minStars, pushedSince, remaining, onItem } = args;
  // GitHub query syntax: `topic:foo pushed:>=DATE stars:>=N` — sorted by stars desc.
  const q = `topic:${topic} pushed:>=${pushedSince} stars:>=${minStars}`;
  let page = 1;
  // 3 pages * 30 = 90 candidates per topic is plenty before hitting our hard cap.
  const MAX_PAGES = 3;
  while (page <= MAX_PAGES && remaining() > 0) {
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=${SEARCH_PAGE_SIZE}&page=${page}&sort=stars&order=desc`;
    const response = await ghFetch(url, fetchImpl, ghToken, `topic search "${topic}"`);
    const payload = (await response.json()) as GithubSearchResponse;
    const candidates = payload.items ?? [];
    if (candidates.length === 0) return;
    for (const candidate of candidates) {
      if (remaining() <= 0) return;
      if (candidate.fork === true) continue;
      const spdxId = candidate.license?.spdx_id ?? undefined;
      const acceptance = acceptSpdx(spdxId);
      if (acceptance === "reject") continue;
      const item = await buildItemFromSearch(candidate, fetchImpl, ghToken, topic);
      if (item !== undefined) onItem(item);
    }
    if (candidates.length < SEARCH_PAGE_SIZE) return;
    page += 1;
  }
}

type SpdxAcceptance = "clean" | "copyleft" | "reject";

function acceptSpdx(spdxId: string | undefined): SpdxAcceptance {
  if (spdxId === undefined || spdxId === null) return "reject"; // unknown → reject
  const normalized = spdxId.trim();
  if (DEFAULT_CLEAN_SPDX.has(normalized)) return "clean";
  if (DEFAULT_COPYLEFT_SPDX.has(normalized)) return "copyleft";
  return "reject";
}

async function buildItemFromSearch(
  candidate: GithubSearchItem,
  fetchImpl: typeof fetch,
  ghToken: string | undefined,
  matchedTopic: string,
): Promise<RawProjectItem | undefined> {
  const fullName = candidate.full_name;
  const [owner, repo] = fullName.split("/", 2);
  if (owner === undefined || repo === undefined) return undefined;
  const ref = candidate.default_branch ?? "main";
  const sourceName = `github:${fullName}`;
  const canonical = sourceName;
  const sourceUrl = candidate.html_url;

  // Use the License extractor for the file path and consistent confidence value.
  const licenseInfo = await fetchGithubLicense({
    owner,
    repo,
    ...(ghToken !== undefined ? { ghToken } : {}),
    fetchImpl,
  }).catch(() => undefined);

  // Fall back to the search-result SPDX (search payload includes license) when
  // the dedicated /license endpoint failed.
  const license: ProjectRagLicense =
    licenseInfo?.license ?? classifyFromSpdx(candidate.license?.spdx_id ?? undefined);
  const licenseConfidence: LicenseConfidence =
    licenseInfo?.confidence ?? (license === "Unknown" ? "unknown" : "spdx-detected");

  const readme = await fetchReadme(owner, repo, ref, fetchImpl, ghToken).catch(() => undefined);
  const topLevel = await fetchTopLevelEntries(owner, repo, ref, fetchImpl, ghToken).catch(
    () => [] as GithubContentEntry[],
  );
  const tdFiles = topLevel
    .filter((entry) => entry.type === "file" && hasTdExtension(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const fileNames = tdFiles.map((e) => e.name);

  const tags = new Set<string>([matchedTopic]);
  for (const t of candidate.topics ?? []) tags.add(t);
  if (fileNames.some((n) => n.toLowerCase().endsWith(".toe"))) tags.add("toe");
  if (fileNames.some((n) => n.toLowerCase().endsWith(".tox"))) tags.add("tox");

  const type = inferType(fileNames);
  const item: RawProjectItem = {
    sourceName,
    sourceUrl,
    canonical,
    title: fullName,
    type,
    tags: [...tags].sort(),
    license,
    licenseConfidence,
    commitOrVersion: ref,
  };
  if (licenseInfo?.file !== undefined) item.licenseFile = licenseInfo.file;
  if (readme !== undefined) item.body = readme;
  if (candidate.owner?.login !== undefined) item.authors = [candidate.owner.login];
  if (fileNames.length > 0) item.files = fileNames;
  const first = tdFiles[0];
  if (first?.download_url !== undefined && first.download_url !== null) {
    item.binaryUrl = first.download_url;
    item.pathInRepo = first.path;
  }
  return item;
}

async function fetchReadme(
  owner: string,
  repo: string,
  ref: string,
  fetchImpl: typeof fetch,
  ghToken: string | undefined,
): Promise<string | undefined> {
  const url = `https://api.github.com/repos/${owner}/${repo}/readme?ref=${encodeURIComponent(ref)}`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github.raw",
    "x-github-api-version": "2022-11-28",
  };
  if (ghToken !== undefined && ghToken.length > 0) headers.authorization = `Bearer ${ghToken}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers });
    if (response.status === 404) return undefined;
    if (response.status === 403) {
      await throwRateLimitOrFailure(response, "readme");
    }
    if (!response.ok) return undefined;
    const text = await response.text();
    return text.length > README_BODY_BYTES_CAP
      ? `${text.slice(0, README_BODY_BYTES_CAP)}\n…[truncated]`
      : text;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTopLevelEntries(
  owner: string,
  repo: string,
  ref: string,
  fetchImpl: typeof fetch,
  ghToken: string | undefined,
): Promise<GithubContentEntry[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/?ref=${encodeURIComponent(ref)}`;
  const response = await ghFetch(url, fetchImpl, ghToken, "contents listing");
  const payload = (await response.json()) as GithubContentEntry[] | GithubContentEntry;
  return Array.isArray(payload) ? payload : [payload];
}

async function ghFetch(
  url: string,
  fetchImpl: typeof fetch,
  ghToken: string | undefined,
  label: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  if (ghToken !== undefined && ghToken.length > 0) headers.authorization = `Bearer ${ghToken}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: controller.signal, headers });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`GitHub ${label} request timed out after ${DEFAULT_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 403) {
    await throwRateLimitOrFailure(response, label);
  }
  if (!response.ok) {
    throw new Error(`GitHub ${label} request failed: HTTP ${response.status}`);
  }
  return response;
}

async function throwRateLimitOrFailure(response: Response, label: string): Promise<never> {
  const text = await response.text().catch(() => "");
  if (/rate limit|api rate/i.test(text)) {
    throw new SourceSkippedError(
      "github-topic",
      `GitHub unauthenticated rate-limit exceeded on ${label} — set TDMCP_PROJECT_RAG_GH_TOKEN`,
    );
  }
  throw new Error(`GitHub ${label} request failed: HTTP 403 (${text.slice(0, 120)})`);
}

function hasTdExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return TD_BINARY_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function inferType(fileNames: string[]): ProjectRagType {
  const hasToe = fileNames.some((n) => n.toLowerCase().endsWith(".toe"));
  const hasTox = fileNames.some((n) => n.toLowerCase().endsWith(".tox"));
  if (hasToe && !hasTox) return "project";
  if (hasTox) return hasToe ? "project" : "component";
  return "framework";
}
