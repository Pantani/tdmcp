/**
 * Smithsonian Open Access source adapter (key-gated).
 *
 * Single-call search endpoint. Requires `TDMCP_RAG_SMITHSONIAN_KEY` in the
 * environment, read inside `fetchItems`; absent/empty ⇒ one clear log line and a
 * no-op `[]` (so a `sync` over all sources still succeeds). The key is never
 * logged. License via `online_media.media[0].usage.access` ("CC0" ⇒ CC0); the
 * `imageUrl` is only set when the policy would allow storing it. A single
 * malformed item is skipped, never fatal.
 */

import { classifySmithsonianLicense, shouldStoreBinary } from "../licensePolicy.js";
import type { CreativeRagLicense, RawSourceItem, Source } from "../types.js";
import { SourceSkippedError } from "./errors.js";
import { fetchWithTimeout } from "./http.js";

const NAME = "smithsonian";
const DISPLAY_NAME = "Smithsonian Open Access";
const SOURCE_NAME = DISPLAY_NAME;
const API_BASE = "https://api.si.edu/openaccess/api/v1.0/search";
const QUERY = 'online_media_type:"Images" AND media_usage:CC0';
const ENV_KEY = "TDMCP_RAG_SMITHSONIAN_KEY";

/** Binaries are only retained for these licenses (mirrors the default allowlist). */
const BINARY_ALLOWLIST: CreativeRagLicense[] = ["CC0", "PublicDomain"];

interface SmithsonianMedia {
  content?: string;
  thumbnail?: string;
  usage?: { access?: string };
}

interface SmithsonianContent {
  title?: string;
  descriptiveNonRepeating?: {
    title?: { content?: string };
    record_link?: string;
    record_ID?: string;
    guid?: string;
    online_media?: { media?: SmithsonianMedia[] };
  };
  freetext?: { name?: { content?: string }[] };
}

interface SmithsonianRow {
  content?: SmithsonianContent;
}

interface SmithsonianResponse {
  response?: { rows?: SmithsonianRow[] };
}

function extractTitle(content: SmithsonianContent): string | undefined {
  const fromDescriptive = content.descriptiveNonRepeating?.title?.content;
  if (typeof fromDescriptive === "string" && fromDescriptive.length > 0) return fromDescriptive;
  return typeof content.title === "string" && content.title.length > 0 ? content.title : undefined;
}

function extractSourceUrl(content: SmithsonianContent): string | undefined {
  const dnr = content.descriptiveNonRepeating;
  return dnr?.record_link || dnr?.record_ID || dnr?.guid || undefined;
}

function extractArtist(content: SmithsonianContent): string | undefined {
  const name = content.freetext?.name?.find(
    (n) => typeof n.content === "string" && n.content.length > 0,
  )?.content;
  return name && name.length > 0 ? name : undefined;
}

function buildItem(content: SmithsonianContent, allowlist: CreativeRagLicense[]): RawSourceItem {
  const title = extractTitle(content);
  const sourceUrl = extractSourceUrl(content);
  if (!title || !sourceUrl) {
    throw new Error("Smithsonian item missing title/sourceUrl");
  }
  const media = content.descriptiveNonRepeating?.online_media?.media?.[0];
  const license = classifySmithsonianLicense(media?.usage?.access);

  const item: RawSourceItem = {
    sourceUrl,
    sourceName: SOURCE_NAME,
    title,
    type: "artwork",
    tags: [],
    license,
  };
  const artist = extractArtist(content);
  if (artist) item.artist = artist;

  const imageUrl = media?.content;
  if (imageUrl && shouldStoreBinary(license, allowlist)) {
    item.imageUrl = imageUrl;
  }
  return item;
}

export const smithsonianSource: Source = {
  name: NAME,
  displayName: DISPLAY_NAME,
  async fetchItems(
    limit: number,
    fetchImpl: typeof fetch = fetch,
    licenseAllowlist: CreativeRagLicense[] = BINARY_ALLOWLIST,
  ): Promise<RawSourceItem[]> {
    const key = process.env[ENV_KEY];
    if (!key) {
      // Throw (not return []): a missing key is a SKIPPED source, not a successful
      // empty sync. Returning [] would let service.sync tombstone every existing
      // Smithsonian card. The sync loop catches this and leaves them intact.
      throw new SourceSkippedError("Smithsonian", ENV_KEY);
    }
    const url = `${API_BASE}?q=${encodeURIComponent(QUERY)}&rows=${limit}&api_key=${encodeURIComponent(key)}`;
    const response = await fetchWithTimeout(url, fetchImpl, "Smithsonian search request");
    if (!response.ok) {
      throw new Error(`Smithsonian search request failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as SmithsonianResponse;
    const rows = Array.isArray(body.response?.rows) ? body.response.rows : [];

    const items: RawSourceItem[] = [];
    for (const row of rows.slice(0, limit)) {
      try {
        if (!row.content) throw new Error("Smithsonian row missing content");
        items.push(buildItem(row.content, licenseAllowlist));
      } catch {
        // Skip a single bad item — never abort the whole fetch.
      }
    }
    return items;
  },
};
