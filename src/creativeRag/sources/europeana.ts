/**
 * Europeana Search API source adapter (key-gated).
 *
 * Single-call search endpoint. The API key is read from
 * `process.env.TDMCP_RAG_EUROPEANA_KEY` INSIDE `fetchItems`: if it is absent or
 * empty the adapter throws `SourceSkippedError` (reason `"no-key"`) so the sync treats
 * this source as skipped (NOT an empty success) and never tombstones its existing cards.
 * A keyed request that comes back with zero items is likewise treated as an untrusted
 * skip (reason `"empty"`) — a rejected key or a silent upstream outage returning HTTP 200
 * must not tombstone the whole source. The key value is NEVER logged.
 *
 * License signal is the per-item `rights[0]` CC/RS URI (e.g.
 * `http://creativecommons.org/publicdomain/zero/1.0/`), classified by the
 * existing `classifyRijksLicense` (it already maps CC/RS URIs). `imageUrl`
 * (`edmPreview[0]`) is only set when the policy would allow storing it.
 *
 * The `guid` Europeana returns has the wskey appended as `?utm_campaign=<key>`;
 * {@link canonicalizeGuid} strips the query string so the persisted `sourceUrl`
 * (and the `id = sha256(sourceUrl)`) never embed the API key and stay stable
 * across different keys. Field map verified against a live keyed sync.
 */

import { classifyRijksLicense, shouldStoreBinary } from "../licensePolicy.js";
import type { CreativeRagLicense, RawSourceItem, Source } from "../types.js";
import { SourceSkippedError } from "./errors.js";
import { fetchWithTimeout } from "./http.js";

const NAME = "europeana";
const DISPLAY_NAME = "Europeana";
const SOURCE_NAME = DISPLAY_NAME;
const SEARCH_URL = "https://api.europeana.eu/record/v2/search.json";
const QUERY = "*";
const KEY_ENV = "TDMCP_RAG_EUROPEANA_KEY";

/** Binaries are only retained for these licenses (mirrors the default allowlist). */
const BINARY_ALLOWLIST: CreativeRagLicense[] = ["CC0", "PublicDomain"];

interface EuropeanaItem {
  title?: string[];
  dcCreator?: string[];
  guid?: string;
  rights?: string[];
  edmPreview?: string[];
  year?: string[];
}

interface EuropeanaSearchResponse {
  items?: EuropeanaItem[];
}

function firstString(values?: string[]): string | undefined {
  const value = values?.[0];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseYear(values?: string[]): number | undefined {
  const raw = firstString(values);
  if (raw === undefined) return undefined;
  const year = Number.parseInt(raw, 10);
  return Number.isNaN(year) ? undefined : year;
}

/**
 * Strip the query string from a Europeana `guid`. Europeana appends the caller's
 * wskey as `?utm_source=api&utm_medium=api&utm_campaign=<key>`, so the raw guid
 * leaks the API key into the persisted `sourceUrl`/`id`. Keeping only origin+path
 * yields the stable canonical item URL, key-free and identical across keys.
 */
function canonicalizeGuid(guid: string): string {
  try {
    const url = new URL(guid);
    return `${url.origin}${url.pathname}`;
  } catch {
    const queryStart = guid.indexOf("?");
    return queryStart === -1 ? guid : guid.slice(0, queryStart);
  }
}

function buildItem(raw: EuropeanaItem, allowlist: CreativeRagLicense[]): RawSourceItem {
  const title = firstString(raw.title);
  if (!raw.guid || !title) {
    throw new Error("Europeana item missing guid/title");
  }
  // Drop the query string so the persisted sourceUrl/id never carries the wskey.
  const sourceUrl = canonicalizeGuid(raw.guid);
  const rightsUri = firstString(raw.rights);
  const license = classifyRijksLicense(rightsUri);

  const item: RawSourceItem = {
    sourceUrl,
    sourceName: SOURCE_NAME,
    title,
    type: "artwork",
    tags: [],
    license,
  };
  const artist = firstString(raw.dcCreator);
  if (artist) item.artist = artist;
  const year = parseYear(raw.year);
  if (year !== undefined) item.year = year;
  if (rightsUri) item.rightsNotes = rightsUri;

  const imageUrl = firstString(raw.edmPreview);
  if (imageUrl && shouldStoreBinary(license, allowlist)) {
    item.imageUrl = imageUrl;
  }
  return item;
}

export const europeanaSource: Source = {
  name: NAME,
  displayName: DISPLAY_NAME,
  async fetchItems(
    limit: number,
    fetchImpl: typeof fetch = fetch,
    licenseAllowlist: CreativeRagLicense[] = BINARY_ALLOWLIST,
  ): Promise<RawSourceItem[]> {
    const key = process.env[KEY_ENV];
    if (!key) {
      // Throw (not return []): a missing key is a SKIPPED source, not a successful
      // empty sync — see SourceSkippedError. Returning [] would let service.sync
      // tombstone every existing Europeana card. reason "no-key" is the default.
      throw new SourceSkippedError("Europeana", KEY_ENV, "no-key");
    }

    const url =
      `${SEARCH_URL}?wskey=${encodeURIComponent(key)}` +
      `&query=${encodeURIComponent(QUERY)}&rows=${limit}&media=true&reusability=open`;
    const response = await fetchWithTimeout(url, fetchImpl, "Europeana search request");
    if (!response.ok) {
      throw new Error(`Europeana search request failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as EuropeanaSearchResponse;
    const data = Array.isArray(body.items) ? body.items : [];

    if (data.length === 0) {
      // Keyed request that returned zero items for the `*` catalog query. A truly empty
      // Europeana is implausible, so this is far more likely a silent upstream hiccup or
      // a rejected/misconfigured key that still returned HTTP 200. Signal an untrusted
      // "empty" SKIP (reason "empty") rather than returning [] — that would tombstone
      // every existing Europeana card on what may be a transient outage.
      throw new SourceSkippedError("Europeana", KEY_ENV, "empty");
    }

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
