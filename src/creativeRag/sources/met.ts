/**
 * The Met source adapter.
 *
 * Two-step: a `search` call yields object IDs, then each object is fetched. The
 * per-object loop is capped at `limit`. License via the `isPublicDomain` boolean;
 * `imageUrl` is only set when the policy would allow storing it (PublicDomain).
 * A single malformed object is skipped, never fatal.
 */

import { classifyMetLicense, shouldStoreBinary } from "../licensePolicy.js";
import type { CreativeRagLicense, RawSourceItem, Source } from "../types.js";
import { fetchWithTimeout } from "./http.js";

const NAME = "met";
const DISPLAY_NAME = "The Met";
const SOURCE_NAME = DISPLAY_NAME;
const API_BASE = "https://collectionapi.metmuseum.org/public/collection/v1";
const SEARCH_QUERY = "painting";

/** Binaries are only retained for these licenses (mirrors the default allowlist). */
const BINARY_ALLOWLIST: CreativeRagLicense[] = ["CC0", "PublicDomain"];

interface MetSearchResponse {
  total?: number;
  objectIDs?: number[] | null;
}

interface MetObject {
  objectID?: number;
  isPublicDomain?: boolean;
  primaryImage?: string;
  primaryImageSmall?: string;
  title?: string;
  artistDisplayName?: string;
  objectDate?: string;
  medium?: string;
  classification?: string;
  objectURL?: string;
}

function parseYear(objectDate?: string): number | undefined {
  if (!objectDate) return undefined;
  const match = objectDate.match(/\d{4}/);
  if (!match) return undefined;
  const year = Number.parseInt(match[0], 10);
  return Number.isFinite(year) ? year : undefined;
}

function buildItem(raw: MetObject, allowlist: CreativeRagLicense[]): RawSourceItem {
  const title = raw.title;
  const objectUrl = raw.objectURL;
  if (typeof title !== "string" || title.length === 0 || !objectUrl) {
    throw new Error("Met object missing title/objectURL");
  }
  const license = classifyMetLicense(raw.isPublicDomain === true);
  const tags: string[] = [];
  if (raw.classification) tags.push(raw.classification);

  const item: RawSourceItem = {
    sourceUrl: objectUrl,
    sourceName: SOURCE_NAME,
    title,
    type: "artwork",
    tags,
    license,
  };
  if (raw.artistDisplayName) item.artist = raw.artistDisplayName;
  const year = parseYear(raw.objectDate);
  if (year !== undefined) item.year = year;
  if (raw.medium) item.medium = raw.medium;

  if (raw.primaryImage && shouldStoreBinary(license, allowlist)) {
    item.imageUrl = raw.primaryImage;
  }
  return item;
}

export const metSource: Source = {
  name: NAME,
  displayName: DISPLAY_NAME,
  async fetchItems(
    limit: number,
    fetchImpl: typeof fetch = fetch,
    licenseAllowlist: CreativeRagLicense[] = BINARY_ALLOWLIST,
  ): Promise<RawSourceItem[]> {
    const searchUrl = `${API_BASE}/search?hasImages=true&q=${encodeURIComponent(SEARCH_QUERY)}`;
    const searchResponse = await fetchWithTimeout(searchUrl, fetchImpl, "Met search request");
    if (!searchResponse.ok) {
      throw new Error(`Met search request failed: HTTP ${searchResponse.status}`);
    }
    const searchBody = (await searchResponse.json()) as MetSearchResponse;
    const ids = Array.isArray(searchBody.objectIDs) ? searchBody.objectIDs : [];

    const items: RawSourceItem[] = [];
    for (const id of ids.slice(0, limit)) {
      try {
        const objResponse = await fetchWithTimeout(
          `${API_BASE}/objects/${id}`,
          fetchImpl,
          `Met object ${id}`,
        );
        if (!objResponse.ok) continue;
        const obj = (await objResponse.json()) as MetObject;
        items.push(buildItem(obj, licenseAllowlist));
      } catch {
        // Skip a single bad object — never abort the whole fetch.
      }
    }
    return items;
  },
};
