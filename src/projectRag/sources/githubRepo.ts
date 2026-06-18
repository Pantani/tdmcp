/**
 * Project RAG — GitHub repo source adapter.
 *
 * Single-repo adapter parameterised by `owner/repo[@ref]`. Uses the GitHub REST
 * API (no local `git clone` — robust for CI + cap-friendly). For each configured
 * repo it produces ONE {@link RawProjectItem} carrying:
 *
 * - `provenance`: stable canonical = `github:<owner>/<repo>[@ref]`.
 * - `license`: SPDX-detected via {@link fetchGithubLicense} (falls back to
 *   `Unknown`, which the license gate then blocks from binary persistence).
 * - `body`: README contents (markdown), truncated to a sane bound for the embedder.
 * - `files`: top-level `.tox`/`.toe` filenames discovered in the default branch.
 * - `binaryUrl`: download URL of the first `.tox`/`.toe` (when present); the
 *   service downloads it only when the license policy permits.
 *
 * Rate-limit handling: when an unauthenticated request returns HTTP 403 with the
 * "rate limit exceeded" body, the adapter raises {@link SourceSkippedError} with
 * an explicit "set TDMCP_PROJECT_RAG_GH_TOKEN" hint — never a silent zero-items
 * return (which would tombstone the existing cards).
 *
 * Default seed: when `TDMCP_PROJECT_RAG_GITHUB_REPOS` is unset, the adapter
 * ships with `torinmb/mediapipe-touchdesigner` (MIT) as the first source.
 */

import { fetchGithubLicense } from "../extractors/githubLicense.js";
import type { LicenseConfidence, ProjectRagLicense, ProjectRagType } from "../types.js";
import { SourceSkippedError } from "./errors.js";
import type { RawProjectItem, SourceAdapter, SourceAdapterContext } from "./types.js";

const DEFAULT_TIMEOUT_MS = 15_000;
/** Cap embedded body at ~32KB — README only, never source code. */
const README_BODY_BYTES_CAP = 32_768;
/** Only top-level `.tox`/`.toe` files are inspected; deeper paths are a F2+ concern. */
const TD_BINARY_EXTENSIONS = [".tox", ".toe"];

/** Default seed (MIT) when no override CSV is configured. */
export const DEFAULT_GITHUB_REPOS = ["torinmb/mediapipe-touchdesigner"] as const;

export interface GithubRepoSpec {
  owner: string;
  repo: string;
  /** Optional branch/tag/SHA; defaults to the repo's default branch. */
  ref?: string;
}

/** Parses `owner/repo[@ref]` strings; ignores blank entries; throws on malformed. */
export function parseRepoSpec(raw: string): GithubRepoSpec {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error("repo spec is empty");
  }
  const [coords, ref] = trimmed.split("@", 2);
  if (coords === undefined) {
    throw new Error(`invalid repo spec "${raw}" (expected owner/repo[@ref])`);
  }
  const slashIdx = coords.indexOf("/");
  if (slashIdx <= 0 || slashIdx === coords.length - 1) {
    throw new Error(`invalid repo spec "${raw}" (expected owner/repo[@ref])`);
  }
  const owner = coords.slice(0, slashIdx);
  const repo = coords.slice(slashIdx + 1);
  const spec: GithubRepoSpec = { owner, repo };
  if (ref !== undefined && ref.length > 0) spec.ref = ref;
  return spec;
}

/** Parses the CSV env var into a list of repo specs. */
export function parseRepoListEnv(csv: string | undefined): GithubRepoSpec[] {
  if (csv === undefined || csv.trim().length === 0) {
    return DEFAULT_GITHUB_REPOS.map((s) => parseRepoSpec(s));
  }
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => parseRepoSpec(s));
}

interface GithubRepoMetadata {
  name: string;
  full_name: string;
  html_url: string;
  description?: string | null;
  default_branch?: string;
  topics?: string[];
  owner?: { login?: string };
  pushed_at?: string;
  fork?: boolean;
}

interface GithubContentEntry {
  name: string;
  path: string;
  type: "file" | "dir" | string;
  size?: number;
  download_url?: string | null;
  html_url?: string | null;
}

/**
 * Build the GitHub repo source adapter for a fixed list of specs.
 * `name` matches the CLI `--source github-repo` flag.
 */
export function githubRepoSource(specs: GithubRepoSpec[]): SourceAdapter {
  return {
    name: "github-repo",
    displayName: "GitHub repo allowlist (TDMCP_PROJECT_RAG_GITHUB_REPOS)",
    async fetchItems(limit: number, ctx: SourceAdapterContext): Promise<RawProjectItem[]> {
      if (specs.length === 0) {
        throw new SourceSkippedError(
          "github-repo",
          "no repos configured (set TDMCP_PROJECT_RAG_GITHUB_REPOS=owner/repo[,owner/repo])",
        );
      }
      const fetchImpl = ctx.fetchImpl ?? fetch;
      const items: RawProjectItem[] = [];
      // Cap is per-sync across all configured repos; one item per repo today.
      const capped = specs.slice(0, Math.max(0, limit));
      for (const spec of capped) {
        const item = await fetchOneRepo(spec, fetchImpl, ctx.ghToken);
        items.push(item);
      }
      return items;
    },
  };
}

async function fetchOneRepo(
  spec: GithubRepoSpec,
  fetchImpl: typeof fetch,
  ghToken: string | undefined,
): Promise<RawProjectItem> {
  const sourceName = `github:${spec.owner}/${spec.repo}`;
  const meta = await fetchRepoMetadata(spec, fetchImpl, ghToken);
  const ref = spec.ref ?? meta.default_branch ?? "main";
  const canonical = spec.ref !== undefined ? `${sourceName}@${spec.ref}` : sourceName;
  const sourceUrl = meta.html_url;
  const licenseInfo = await fetchGithubLicense({
    owner: spec.owner,
    repo: spec.repo,
    ...(ghToken !== undefined ? { ghToken } : {}),
    fetchImpl,
  });
  const license: ProjectRagLicense = licenseInfo.license;
  const licenseConfidence: LicenseConfidence = licenseInfo.confidence;

  const readme = await fetchReadme(spec, ref, fetchImpl, ghToken);
  const topLevel = await fetchTopLevelEntries(spec, ref, fetchImpl, ghToken);
  const tdFiles = topLevel
    .filter((entry) => entry.type === "file" && hasTdExtension(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const fileNames = tdFiles.map((entry) => entry.name);
  const tags = buildTags(meta, fileNames);
  const type = inferType(meta, fileNames);

  const item: RawProjectItem = {
    sourceName,
    sourceUrl,
    canonical,
    title: meta.full_name,
    type,
    tags,
    license,
    licenseConfidence,
    commitOrVersion: ref,
  };
  if (licenseInfo.file !== undefined) item.licenseFile = licenseInfo.file;
  if (meta.description) {
    item.rightsNotes =
      license === "Unknown" || license === "Restricted"
        ? "No SPDX-detected license — binary download blocked. See repo for usage terms."
        : undefined;
  }
  if (readme !== undefined) item.body = readme;
  if (meta.owner?.login !== undefined) item.authors = [meta.owner.login];
  if (fileNames.length > 0) item.files = fileNames;

  const first = tdFiles[0];
  if (first?.download_url !== undefined && first.download_url !== null) {
    item.binaryUrl = first.download_url;
    item.pathInRepo = first.path;
  }
  return item;
}

async function fetchRepoMetadata(
  spec: GithubRepoSpec,
  fetchImpl: typeof fetch,
  ghToken: string | undefined,
): Promise<GithubRepoMetadata> {
  const url = `https://api.github.com/repos/${spec.owner}/${spec.repo}`;
  const response = await ghFetch(url, fetchImpl, ghToken, "repo metadata");
  return (await response.json()) as GithubRepoMetadata;
}

async function fetchReadme(
  spec: GithubRepoSpec,
  ref: string,
  fetchImpl: typeof fetch,
  ghToken: string | undefined,
): Promise<string | undefined> {
  const url = `https://api.github.com/repos/${spec.owner}/${spec.repo}/readme?ref=${encodeURIComponent(ref)}`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github.raw",
    "x-github-api-version": "2022-11-28",
  };
  if (ghToken !== undefined && ghToken.length > 0) {
    headers.authorization = `Bearer ${ghToken}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: controller.signal, headers });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`GitHub readme request timed out after ${DEFAULT_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 404) return undefined;
  if (response.status === 403) {
    await throwRateLimitOrFailure(response, "readme");
  }
  if (!response.ok) {
    throw new Error(`GitHub readme request failed: HTTP ${response.status}`);
  }
  const text = await response.text();
  return text.length > README_BODY_BYTES_CAP
    ? `${text.slice(0, README_BODY_BYTES_CAP)}\n…[truncated]`
    : text;
}

async function fetchTopLevelEntries(
  spec: GithubRepoSpec,
  ref: string,
  fetchImpl: typeof fetch,
  ghToken: string | undefined,
): Promise<GithubContentEntry[]> {
  const url = `https://api.github.com/repos/${spec.owner}/${spec.repo}/contents/?ref=${encodeURIComponent(ref)}`;
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
  if (ghToken !== undefined && ghToken.length > 0) {
    headers.authorization = `Bearer ${ghToken}`;
  }
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
      "github-repo",
      `GitHub unauthenticated rate-limit exceeded on ${label} — set TDMCP_PROJECT_RAG_GH_TOKEN`,
    );
  }
  throw new Error(`GitHub ${label} request failed: HTTP 403 (${text.slice(0, 120)})`);
}

function hasTdExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return TD_BINARY_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function buildTags(meta: GithubRepoMetadata, fileNames: string[]): string[] {
  const tags = new Set<string>();
  for (const topic of meta.topics ?? []) tags.add(topic);
  if (fileNames.some((n) => n.toLowerCase().endsWith(".toe"))) tags.add("toe");
  if (fileNames.some((n) => n.toLowerCase().endsWith(".tox"))) tags.add("tox");
  if (meta.fork === true) tags.add("fork");
  return [...tags].sort();
}

function inferType(meta: GithubRepoMetadata, fileNames: string[]): ProjectRagType {
  const hasToe = fileNames.some((n) => n.toLowerCase().endsWith(".toe"));
  const hasTox = fileNames.some((n) => n.toLowerCase().endsWith(".tox"));
  if (hasToe && !hasTox) return "project";
  if (hasTox && !hasToe) return "component";
  if (hasToe && hasTox) return "project";
  // Repos with READMEs but no .toe/.tox at top-level read more like a framework/SDK.
  return "framework";
}
