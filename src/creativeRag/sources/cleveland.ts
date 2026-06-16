/**
 * Cleveland Museum of Art Open Access source adapter.
 *
 * Single-call list endpoint, keyless. License via `share_license_status`
 * ("CC0" ⇒ CC0); `imageUrl` (`images.web.url`) is only set when the policy would
 * allow storing it. A single malformed item is skipped, never fatal.
 */

import { classifyClevelandLicense, shouldStoreBinary } from "../licensePolicy.js";
import type { CreativeRagLicense, RawSourceItem, Source } from "../types.js";
import { fetchWithTimeout } from "./http.js";

const NAME = "cleveland";
const DISPLAY_NAME = "Cleveland Museum of Art";
const SOURCE_NAME = DISPLAY_NAME;
const API_BASE = "https://openaccess-api.clevelandart.org/api/artworks";

/** Binaries are only retained for these licenses (mirrors the default allowlist). */
const BINARY_ALLOWLIST: CreativeRagLicense[] = ["CC0", "PublicDomain"];

interface ClevelandCreator {
  description?: string;
}

interface ClevelandArtwork {
  id?: number;
  title?: string;
  share_license_status?: string;
  creation_date?: string;
  technique?: string;
  url?: string;
  creators?: ClevelandCreator[];
  images?: { web?: { url?: string } };
}

interface ClevelandListResponse {
  data?: ClevelandArtwork[];
}

function parseYear(raw?: string): number | undefined {
  if (!raw) return undefined;
  const match = raw.match(/\d{4}/);
  const year = match?.[0];
  return year ? Number.parseInt(year, 10) : undefined;
}

/** First creator's `description` ("Name (nationality, dates)"), parenthetical stripped. */
function extractArtist(creators?: ClevelandCreator[]): string | undefined {
  const desc = creators?.find(
    (c) => typeof c.description === "string" && c.description.length > 0,
  )?.description;
  if (desc === undefined) return undefined;
  const cleaned = desc.replace(/\s*\(.*\)\s*$/, "").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function buildItem(raw: ClevelandArtwork, allowlist: CreativeRagLicense[]): RawSourceItem {
  const sourceUrl = raw.url;
  const title = raw.title;
  if (!sourceUrl || !title) {
    throw new Error("Cleveland artwork missing url/title");
  }
  const license = classifyClevelandLicense(raw.share_license_status);

  const item: RawSourceItem = {
    sourceUrl,
    sourceName: SOURCE_NAME,
    title,
    type: "artwork",
    tags: [],
    license,
  };
  const artist = extractArtist(raw.creators);
  if (artist) item.artist = artist;
  const year = parseYear(raw.creation_date);
  if (year !== undefined) item.year = year;
  if (raw.technique) item.medium = raw.technique;

  const imageUrl = raw.images?.web?.url;
  if (imageUrl && shouldStoreBinary(license, allowlist)) {
    item.imageUrl = imageUrl;
  }
  return item;
}

export const clevelandSource: Source = {
  name: NAME,
  displayName: DISPLAY_NAME,
  async fetchItems(
    limit: number,
    fetchImpl: typeof fetch = fetch,
    licenseAllowlist: CreativeRagLicense[] = BINARY_ALLOWLIST,
  ): Promise<RawSourceItem[]> {
    const url = `${API_BASE}?limit=${limit}&has_image=1`;
    const response = await fetchWithTimeout(url, fetchImpl, "Cleveland list request");
    if (!response.ok) {
      throw new Error(`Cleveland list request failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as ClevelandListResponse;
    const data = Array.isArray(body.data) ? body.data : [];

    const items: RawSourceItem[] = [];
    for (const raw of data.slice(0, limit)) {
      try {
        items.push(buildItem(raw, licenseAllowlist));
      } catch {
        // Skip a single bad item — never abort the whole fetch.
      }
    }
    return items;
  },
};
