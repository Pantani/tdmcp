/**
 * Project RAG — GitHub license extractor.
 *
 * Calls `GET /repos/{owner}/{repo}/license` (REST v3) and maps the returned
 * `license.spdx_id` through {@link classifyFromSpdx}. When the endpoint returns
 * 404 (no LICENSE file in the repo) or 403 (rate-limit / forbidden), returns
 * `Unknown` with `licenseConfidence: "unknown"` instead of throwing — the
 * service then refuses to store any binary for that card via the license gate.
 *
 * Reference: https://docs.github.com/en/rest/licenses/licenses
 */

import { classifyFromSpdx } from "../licensePolicy.js";
import type { LicenseConfidence, ProjectRagLicense } from "../types.js";

export interface GithubLicenseResult {
  license: ProjectRagLicense;
  confidence: LicenseConfidence;
  /** Path of the LICENSE file inside the repo (when known). */
  file?: string;
  /** Raw SPDX id from the API, for telemetry. */
  spdxId?: string;
}

export interface FetchGithubLicenseOptions {
  owner: string;
  repo: string;
  ghToken?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

interface GithubLicensePayload {
  path?: string;
  license?: { spdx_id?: string | null } | null;
}

/**
 * Fetches the SPDX-detected license for one GitHub repo. Never throws on
 * 404/403 — those degrade to `Unknown` (the license gate then blocks any
 * binary persistence). Throws only on unexpected I/O failures.
 */
export async function fetchGithubLicense(
  opts: FetchGithubLicenseOptions,
): Promise<GithubLicenseResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `https://api.github.com/repos/${opts.owner}/${opts.repo}/license`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  if (opts.ghToken !== undefined && opts.ghToken.length > 0) {
    headers.authorization = `Bearer ${opts.ghToken}`;
  }

  let response: Response;
  try {
    response = await fetchImpl(url, { signal: controller.signal, headers });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(
        `GitHub license request timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 404 || response.status === 403) {
    return { license: "Unknown", confidence: "unknown" };
  }
  if (!response.ok) {
    throw new Error(`GitHub license request failed: HTTP ${response.status}`);
  }
  const payload = (await response.json()) as GithubLicensePayload;
  const spdxId = payload?.license?.spdx_id ?? undefined;
  const license = classifyFromSpdx(spdxId);
  const result: GithubLicenseResult = {
    license,
    confidence: license === "Unknown" ? "unknown" : "spdx-detected",
  };
  if (payload?.path !== undefined) result.file = payload.path;
  if (spdxId !== undefined && spdxId !== null) result.spdxId = spdxId;
  return result;
}
