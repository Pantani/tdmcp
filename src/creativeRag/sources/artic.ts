/**
 * Art Institute of Chicago source adapter.
 *
 * Single-call list endpoint with an inline IIIF config. License via the
 * `is_public_domain` boolean; `imageUrl` is only set when the policy would allow
 * storing it (PublicDomain). A single malformed item is skipped, never fatal.
 */

import { classifyArticLicense, shouldStoreBinary } from "../licensePolicy.js";
import type { CreativeRagLicense, RawSourceItem, Source } from "../types.js";
import { fetchWithTimeout } from "./http.js";

const NAME = "artic";
const DISPLAY_NAME = "Art Institute of Chicago";
const SOURCE_NAME = DISPLAY_NAME;
const API_BASE = "https://api.artic.edu/api/v1";
const FIELDS =
  "id,title,artist_display,date_display,medium_display,classification_title,image_id,is_public_domain";

/** Binaries are only retained for these licenses (mirrors the default allowlist). */
const BINARY_ALLOWLIST: CreativeRagLicense[] = ["CC0", "PublicDomain"];

interface ArticArtwork {
  id?: number;
  title?: string;
  artist_display?: string;
  date_display?: string;
  medium_display?: string;
  classification_title?: string;
  image_id?: string | null;
  is_public_domain?: boolean;
}

interface ArticListResponse {
  data?: ArticArtwork[];
  config?: { iiif_url?: string };
}

function parseYear(dateDisplay?: string): number | undefined {
  if (!dateDisplay) return undefined;
  const match = dateDisplay.match(/\d{4}/);
  if (!match) return undefined;
  const year = Number.parseInt(match[0], 10);
  return Number.isFinite(year) ? year : undefined;
}

function buildItem(
  raw: ArticArtwork,
  iiifUrl: string | undefined,
  allowlist: CreativeRagLicense[],
): RawSourceItem {
  const id = raw.id;
  const title = raw.title;
  if (typeof id !== "number" || typeof title !== "string" || title.length === 0) {
    throw new Error("AIC item missing id/title");
  }
  const license = classifyArticLicense(raw.is_public_domain === true);
  const tags: string[] = [];
  if (raw.classification_title) tags.push(raw.classification_title);

  const item: RawSourceItem = {
    sourceUrl: `https://www.artic.edu/artworks/${id}`,
    sourceName: SOURCE_NAME,
    title,
    type: "artwork",
    tags,
    license,
  };
  if (raw.artist_display) item.artist = raw.artist_display;
  const year = parseYear(raw.date_display);
  if (year !== undefined) item.year = year;
  if (raw.medium_display) item.medium = raw.medium_display;

  if (raw.image_id && iiifUrl && shouldStoreBinary(license, allowlist)) {
    item.imageUrl = `${iiifUrl}/${raw.image_id}/full/843,/0/default.jpg`;
  }
  return item;
}

export const articSource: Source = {
  name: NAME,
  displayName: DISPLAY_NAME,
  async fetchItems(
    limit: number,
    fetchImpl: typeof fetch = fetch,
    licenseAllowlist: CreativeRagLicense[] = BINARY_ALLOWLIST,
  ): Promise<RawSourceItem[]> {
    const url = `${API_BASE}/artworks?limit=${limit}&fields=${FIELDS}`;
    const response = await fetchWithTimeout(url, fetchImpl, "AIC list request");
    if (!response.ok) {
      throw new Error(`AIC list request failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as ArticListResponse;
    const iiifUrl = body.config?.iiif_url;
    const data = Array.isArray(body.data) ? body.data : [];

    const items: RawSourceItem[] = [];
    for (const raw of data.slice(0, limit)) {
      try {
        items.push(buildItem(raw, iiifUrl, licenseAllowlist));
      } catch {
        // Skip a single bad item — never abort the whole fetch.
      }
    }
    return items;
  },
};
