/**
 * Project RAG — awesome-list discovery source (SUGGEST-ONLY).
 *
 * Parses the `monkeymonk/awesome-touchdesigner` README into a read-only
 * *discovery queue*: candidate links/titles for an operator to review. This is
 * deliberately NOT a {@link SourceAdapter} — it never enters
 * `resolveProjectSources`, never clones repos, never downloads binaries, and
 * never produces index-eligible cards. Every item is hard-stamped
 * `license: "Unknown"` / `licenseConfidence: "unknown"` / `suggestOnly: true`,
 * so the license-gate stays intact: nothing here can be auto-ingested.
 *
 * Hard filters keep the queue clean: only `https://` URLs survive, and any
 * binary URL (`.tox`/`.toe`/`.zip`/`.7z` or a `/releases/download/` link) is
 * dropped.
 */

import type { LicenseConfidence, ProjectRagLicense } from "../types.js";
import { SourceSkippedError } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_CAP = 60;
const BINARY_EXTENSIONS = [".tox", ".toe", ".zip", ".7z"];

export const AWESOME_SOURCE_NAME = "awesome-touchdesigner";
export const AWESOME_README_URL =
  "https://raw.githubusercontent.com/monkeymonk/awesome-touchdesigner/master/README.md";

/**
 * One suggested discovery candidate. Provenance and license are MANDATORY: the
 * license is always `"Unknown"` (suggest-only — not yet resolved) and
 * `suggestOnly` is a literal `true` proving no downstream auto-ingest.
 */
export interface DiscoveryItem {
  title: string;
  url: string;
  section: string;
  description?: string;
  provenance: {
    sourceName: "awesome-touchdesigner";
    sourceUrl: string;
    discoveredAt: string;
  };
  license: ProjectRagLicense;
  licenseConfidence: LicenseConfidence;
  suggestOnly: true;
}

/** `https://` URLs only — drop anchors, relative, mailto, plain http. */
export function isHttpsUrl(url: string): boolean {
  return url.startsWith("https://");
}

/** Reject TD/archive binaries and GitHub release-download links. */
export function isBinaryUrl(url: string): boolean {
  if (url.includes("/releases/download/")) return true;
  let pathname: string;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    pathname = url.toLowerCase();
  }
  return BINARY_EXTENSIONS.some((ext) => pathname.endsWith(ext));
}

/**
 * Fetch + parse the awesome-list README into a capped discovery queue. A
 * non-2xx response, network error, or timeout becomes a typed
 * {@link SourceSkippedError}; an empty parse result is allowed (returns `[]`).
 */
export async function fetchAwesomeListDiscovery(opts?: {
  fetchImpl?: typeof fetch;
  cap?: number;
}): Promise<DiscoveryItem[]> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const cap = opts?.cap ?? DEFAULT_CAP;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(AWESOME_README_URL, { signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new SourceSkippedError(
        AWESOME_SOURCE_NAME,
        `README request timed out after ${DEFAULT_TIMEOUT_MS}ms`,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new SourceSkippedError(AWESOME_SOURCE_NAME, `README request failed: ${message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new SourceSkippedError(
      AWESOME_SOURCE_NAME,
      `README request failed: HTTP ${response.status}`,
    );
  }
  const markdown = await response.text();
  return parseAwesomeReadme(markdown, AWESOME_README_URL, cap);
}

/**
 * Pure parser: track the current `##`/`###` heading as `section`, then extract
 * https links from list items, dropping binary URLs. `discoveredAt` is computed
 * once for the whole parse.
 */
export function parseAwesomeReadme(
  markdown: string,
  sourceUrl: string,
  cap: number,
): DiscoveryItem[] {
  const discoveredAt = new Date().toISOString();
  const items: DiscoveryItem[] = [];
  let section = "";
  for (const rawLine of markdown.split("\n")) {
    if (items.length >= cap) break;
    const line = rawLine.trimEnd();
    const heading = parseHeading(line);
    if (heading !== undefined) {
      section = heading;
      continue;
    }
    if (!isListItem(line)) continue;
    for (const item of extractLinksFromLine(line, section, sourceUrl, discoveredAt)) {
      if (items.length >= cap) break;
      items.push(item);
    }
  }
  return items;
}

function parseHeading(line: string): string | undefined {
  const match = /^(#{2,3})\s+(.*)$/.exec(line.trim());
  return match?.[2]?.trim();
}

function isListItem(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith("- ") || trimmed.startsWith("* ");
}

const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;

/** Extract every accepted `[text](url)` link in one list-item line. */
export function extractLinksFromLine(
  line: string,
  section: string,
  sourceUrl: string,
  discoveredAt: string,
): DiscoveryItem[] {
  const items: DiscoveryItem[] = [];
  for (const match of line.matchAll(LINK_RE)) {
    const title = match[1]?.trim();
    const url = match[2]?.trim();
    if (title === undefined || url === undefined) continue;
    if (!isHttpsUrl(url) || isBinaryUrl(url)) continue;
    const item: DiscoveryItem = {
      title,
      url,
      section,
      provenance: { sourceName: AWESOME_SOURCE_NAME, sourceUrl, discoveredAt },
      license: "Unknown",
      licenseConfidence: "unknown",
      suggestOnly: true,
    };
    const description = trailingDescription(line, match);
    if (description.length > 0) item.description = description;
    items.push(item);
  }
  return items;
}

/** Prose after the link on the same line, stripped of leading separators. */
function trailingDescription(line: string, match: RegExpMatchArray): string {
  const end = (match.index ?? 0) + match[0].length;
  return line
    .slice(end)
    .replace(/^[\s\-—:]+/u, "")
    .trim();
}
