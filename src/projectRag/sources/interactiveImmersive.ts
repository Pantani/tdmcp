/**
 * Project RAG — Interactive & Immersive HQ ("iihq") source adapter.
 *
 * Ingests the markdown TEXT of the GitBook-style TouchDesigner manual at
 * `interactiveimmersivehq/Introduction-to-touchdesigner` (default branch
 * `master`). Each `*.md` chapter file under a known chapter directory becomes
 * one {@link RawProjectItem} of `type: "tutorial"`.
 *
 * This is NOT a TouchDesigner tool — it touches no bridge, no Python exec, no
 * DMX. It is a pure HTTP fetch adapter mirroring `githubRepo.ts` (REST +
 * `ctx.ghToken` + {@link SourceSkippedError}) and `derivativeLocal.ts` (per-file
 * item minting, NO `binaryUrl`).
 *
 * License posture: the repo is CC-BY-NC-SA-4.0, declared only in README prose
 * (GitHub API reports `license:null`). The adapter hard-stamps
 * `license: "CC-BY-NC-SA"`, `licenseConfidence: "declared"` — never SPDX
 * detection — and ingests meta + body text only, NEVER binaries.
 */

import type { LicenseConfidence, ProjectRagLicense } from "../types.js";
import { SourceSkippedError } from "./errors.js";
import type { RawProjectItem, SourceAdapter, SourceAdapterContext } from "./types.js";

const DEFAULT_TIMEOUT_MS = 15_000;

export const IIHQ_SOURCE_NAME = "iihq";
export const IIHQ_REPO = "interactiveimmersivehq/Introduction-to-touchdesigner";
export const IIHQ_DEFAULT_REF = "master";
export const IIHQ_AUTHOR = "The Interactive & Immersive HQ";

/** Directory allowlist — only these top-level chapter dirs are ingested. */
export const IIHQ_CHAPTER_DIRS = [
  "Basics",
  "CHOPs",
  "COMPs",
  "DATs",
  "GLSL",
  "MATs",
  "Optimization",
  "Python",
  "SOPs",
  "TOPs",
  "User_Interface",
] as const;

/** Cap embedded markdown body per file. */
export const IIHQ_BODY_CHARS_CAP = 8_000;

export const IIHQ_RIGHTS_NOTES =
  "CC-BY-NC-SA-4.0 (declared in repo README). Non-commercial use only; share-alike " +
  "derivatives under the same license; attribute The Interactive & Immersive HQ. " +
  "Text ingested for reference — no binaries redistributed.";

const IIHQ_LICENSE: ProjectRagLicense = "CC-BY-NC-SA";
const IIHQ_LICENSE_CONFIDENCE: LicenseConfidence = "declared";

export interface InteractiveImmersiveOptions {
  fetchImpl?: typeof fetch;
  /** Branch/tag/SHA override; defaults to {@link IIHQ_DEFAULT_REF}. */
  ref?: string;
}

interface GithubTreeEntry {
  path?: string;
  type?: string;
}

interface GithubTreeResponse {
  tree?: GithubTreeEntry[];
  truncated?: boolean;
}

/** Top-level path segment (the chapter directory). */
function topSegment(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? path : path.slice(0, slash);
}

/**
 * true iff the path ends with `.md` (case-insensitive), its top segment is an
 * allowed chapter dir, and it is not under `img/` or
 * `TouchDesigner Example Files/`.
 */
export function isIngestibleMdPath(path: string): boolean {
  if (!path.toLowerCase().endsWith(".md")) return false;
  if (path.startsWith("img/") || path.startsWith("TouchDesigner Example Files/")) return false;
  const top = topSegment(path);
  return (IIHQ_CHAPTER_DIRS as readonly string[]).includes(top);
}

/** Top dir lowercased with `_`→`-` (e.g. `User_Interface` → `user-interface`). */
export function chapterSlug(path: string): string {
  return topSegment(path).toLowerCase().replace(/_/g, "-");
}

/**
 * Reads `{ tree: [{ path, type }] }`, keeps ingestible markdown blobs, sorts by
 * path for determinism, and slices to `limit`. Tolerates a missing/empty tree.
 */
export function parseTreeToMdPaths(treeJson: unknown, limit: number): string[] {
  const tree = (treeJson as GithubTreeResponse | null)?.tree;
  if (!Array.isArray(tree)) return [];
  const paths = tree
    .filter((e) => e.type === "blob" && typeof e.path === "string")
    .map((e) => e.path as string)
    .filter((p) => isIngestibleMdPath(p))
    .sort((a, b) => a.localeCompare(b));
  return paths.slice(0, Math.max(0, limit));
}

/** First `# heading`, else filename without `.md` with `-`/`_`→spaces. */
export function deriveTitle(markdown: string, path: string): string {
  const heading = markdown.match(/^#\s+(.+)$/m);
  if (heading?.[1] !== undefined) return heading[1].trim();
  const base = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
  return base.replace(/[-_]/g, " ").trim();
}

function blobUrl(path: string, ref: string): string {
  return `https://github.com/${IIHQ_REPO}/blob/${ref}/${encodeURI(path)}`;
}

/** Mint one tutorial item from a fetched markdown file. NEVER sets binaryUrl. */
export function buildIihqItem(path: string, markdown: string, ref: string): RawProjectItem {
  const sourceUrl = blobUrl(path, ref);
  const body =
    markdown.length > IIHQ_BODY_CHARS_CAP
      ? `${markdown.slice(0, IIHQ_BODY_CHARS_CAP)}\n…[truncated]`
      : markdown;
  return {
    sourceName: `iihq:${path}`,
    sourceUrl,
    canonical: sourceUrl,
    pathInRepo: path,
    title: deriveTitle(markdown, path),
    type: "tutorial",
    tags: ["tutorial", "iihq", chapterSlug(path)],
    license: IIHQ_LICENSE,
    licenseConfidence: IIHQ_LICENSE_CONFIDENCE,
    rightsNotes: IIHQ_RIGHTS_NOTES,
    authors: [IIHQ_AUTHOR],
    commitOrVersion: ref,
    body,
  };
}

function authHeader(ghToken: string | undefined): Record<string, string> {
  return ghToken !== undefined && ghToken.length > 0 ? { authorization: `Bearer ${ghToken}` } : {};
}

async function timedFetch(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  label: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { signal: controller.signal, headers });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`iihq ${label} request timed out after ${DEFAULT_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function throwTreesFailure(response: Response): Promise<never> {
  const text = await response.text().catch(() => "");
  if (response.status === 403 && /rate limit|api rate/i.test(text)) {
    throw new SourceSkippedError(
      IIHQ_SOURCE_NAME,
      "GitHub unauthenticated rate-limit exceeded on trees — set TDMCP_PROJECT_RAG_GH_TOKEN",
    );
  }
  throw new SourceSkippedError(
    IIHQ_SOURCE_NAME,
    `GitHub trees request failed: HTTP ${response.status}`,
  );
}

async function fetchTreePaths(
  fetchImpl: typeof fetch,
  ref: string,
  limit: number,
  ghToken: string | undefined,
): Promise<string[]> {
  const url = `https://api.github.com/repos/${IIHQ_REPO}/git/trees/${ref}?recursive=1`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    ...authHeader(ghToken),
  };
  let response: Response;
  try {
    response = await timedFetch(fetchImpl, url, headers, "trees");
  } catch (err) {
    throw new SourceSkippedError(
      IIHQ_SOURCE_NAME,
      `GitHub trees request error: ${(err as Error).message}`,
    );
  }
  if (!response.ok) await throwTreesFailure(response);
  const json = (await response.json()) as unknown;
  return parseTreeToMdPaths(json, limit);
}

async function fetchMarkdown(
  fetchImpl: typeof fetch,
  path: string,
  ref: string,
  ghToken: string | undefined,
): Promise<string | undefined> {
  const url = `https://raw.githubusercontent.com/${IIHQ_REPO}/${ref}/${encodeURI(path)}`;
  let response: Response;
  try {
    response = await timedFetch(fetchImpl, url, authHeader(ghToken), "raw");
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;
  return response.text();
}

/** Factory — returns a SourceAdapter that ingests the iihq manual markdown. */
export function interactiveImmersiveSource(options?: InteractiveImmersiveOptions): SourceAdapter {
  const ref = options?.ref ?? IIHQ_DEFAULT_REF;
  return {
    name: IIHQ_SOURCE_NAME,
    displayName: "Interactive & Immersive HQ — Introduction to TouchDesigner (CC-BY-NC-SA)",
    async fetchItems(limit: number, ctx: SourceAdapterContext): Promise<RawProjectItem[]> {
      const fetchImpl = options?.fetchImpl ?? ctx.fetchImpl ?? fetch;
      const paths = await fetchTreePaths(fetchImpl, ref, limit, ctx.ghToken);
      if (paths.length === 0) {
        throw new SourceSkippedError(
          IIHQ_SOURCE_NAME,
          "no ingestible markdown found — the repo structure may have changed or the ref is wrong",
        );
      }
      const items: RawProjectItem[] = [];
      for (const path of paths) {
        const markdown = await fetchMarkdown(fetchImpl, path, ref, ctx.ghToken);
        if (markdown !== undefined) items.push(buildIihqItem(path, markdown, ref));
      }
      if (items.length === 0) {
        throw new SourceSkippedError(
          IIHQ_SOURCE_NAME,
          "every markdown fetch failed — the source is currently unreachable",
        );
      }
      return items;
    },
  };
}
