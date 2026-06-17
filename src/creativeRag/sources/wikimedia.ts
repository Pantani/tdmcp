/**
 * Wikimedia Commons source adapter.
 *
 * Keyless, single-call list endpoint: `generator=categorymembers` over a
 * CC-licensed category combined with `prop=imageinfo&iiprop=url|extmetadata|mime`
 * returns the file list, each file's license code, url, and mime in one request.
 * License is read from the machine-readable `extmetadata.License.value` code
 * (e.g. "cc0", "pd", "cc-by-2.0", "cc-by-sa-3.0"); `imageUrl` is only set when the
 * policy would allow storing it. A single malformed page is skipped, never fatal.
 */

import { classifyWikimediaLicense, shouldStoreBinary } from "../licensePolicy.js";
import type { CreativeRagLicense, RawSourceItem, Source } from "../types.js";
import { fetchWithTimeout } from "./http.js";

const NAME = "wikimedia";
const DISPLAY_NAME = "Wikimedia Commons";
const SOURCE_NAME = DISPLAY_NAME;
const API_BASE = "https://commons.wikimedia.org/w/api.php";
const DEFAULT_CATEGORY = "Category:CC-Zero";

/** Binaries are only retained for these licenses (mirrors the default allowlist). */
const BINARY_ALLOWLIST: CreativeRagLicense[] = ["CC0", "PublicDomain"];

interface MetaValue {
  value?: string;
}

interface WikimediaExtMetadata {
  License?: MetaValue;
  LicenseShortName?: MetaValue;
  Artist?: MetaValue;
}

interface WikimediaImageInfo {
  url?: string;
  mime?: string;
  extmetadata?: WikimediaExtMetadata;
}

interface WikimediaPage {
  title?: string;
  imageinfo?: WikimediaImageInfo[];
}

interface WikimediaResponse {
  query?: { pages?: Record<string, WikimediaPage> };
}

/** Strip HTML tags from an extmetadata blob (e.g. "<bdi>Jane</bdi>" ⇒ "Jane"). */
function stripHtml(raw?: string): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/<[^>]*>/g, "").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

/** Drop a leading "File:" namespace prefix from a Commons page title. */
function stripFilePrefix(title: string): string {
  return title.replace(/^File:/, "");
}

function buildItem(page: WikimediaPage, allowlist: CreativeRagLicense[]): RawSourceItem {
  const rawTitle = page.title;
  const info = page.imageinfo?.[0];
  if (!rawTitle || !info) {
    throw new Error("Wikimedia page missing title/imageinfo");
  }
  const meta = info.extmetadata;
  const license = classifyWikimediaLicense(meta?.License?.value);

  const item: RawSourceItem = {
    sourceUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(rawTitle)}`,
    sourceName: SOURCE_NAME,
    title: stripFilePrefix(rawTitle),
    type: "artwork",
    tags: [],
    license,
  };

  const artist = stripHtml(meta?.Artist?.value);
  if (artist) item.artist = artist;
  const rightsNotes = meta?.LicenseShortName?.value;
  if (rightsNotes) item.rightsNotes = rightsNotes;

  if (info.url && shouldStoreBinary(license, allowlist)) {
    item.imageUrl = info.url;
  }
  return item;
}

export const wikimediaSource: Source = {
  name: NAME,
  displayName: DISPLAY_NAME,
  async fetchItems(
    limit: number,
    fetchImpl: typeof fetch = fetch,
    licenseAllowlist: CreativeRagLicense[] = BINARY_ALLOWLIST,
  ): Promise<RawSourceItem[]> {
    const params = new URLSearchParams({
      action: "query",
      format: "json",
      generator: "categorymembers",
      gcmtitle: DEFAULT_CATEGORY,
      gcmtype: "file",
      gcmlimit: String(limit),
      prop: "imageinfo",
      iiprop: "url|extmetadata|mime",
    });
    const url = `${API_BASE}?${params.toString()}`;
    const response = await fetchWithTimeout(url, fetchImpl, "Wikimedia list request");
    if (!response.ok) {
      throw new Error(`Wikimedia list request failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as WikimediaResponse;
    const pages = body.query?.pages ?? {};

    const items: RawSourceItem[] = [];
    for (const page of Object.values(pages)) {
      try {
        items.push(buildItem(page, licenseAllowlist));
      } catch {
        // Skip a single bad page — never abort the whole fetch.
      }
    }
    return items;
  },
};
