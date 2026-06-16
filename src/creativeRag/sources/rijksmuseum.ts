/**
 * Rijksmuseum source adapter (data.rijksmuseum.nl, keyless).
 *
 * Two-step Linked-Art (JSON-LD): a `search/collection` page yields object ids,
 * then each id resolves to a Linked-Art object. The JSON-LD shape is the riskiest
 * to parse (nested `identified_by` / `produced_by` / `referred_to_by` /
 * `representation`), so every field map is defensive: optional-chaining with
 * per-field fallbacks, and a single bad object is skipped, never fatal.
 *
 * UNVERIFIED — probe live: the field map below is from docs, not a live capture.
 */

import { classifyRijksLicense, shouldStoreBinary } from "../licensePolicy.js";
import type { CreativeRagLicense, RawSourceItem, Source } from "../types.js";

const NAME = "rijksmuseum";
const DISPLAY_NAME = "Rijksmuseum";
const SOURCE_NAME = DISPLAY_NAME;
const SEARCH_URL = "https://data.rijksmuseum.nl/search/collection?imageAvailable=true";

/** Binaries are only retained for these licenses (mirrors the default allowlist). */
const BINARY_ALLOWLIST: CreativeRagLicense[] = ["CC0", "PublicDomain"];

interface RijksSearchPage {
  orderedItems?: Array<{ id?: string }> | null;
}

interface RijksName {
  type?: string;
  content?: string;
}

interface RijksAgent {
  _label?: string;
}

interface RijksLinguistic {
  type?: string;
  classified_as?: Array<{ _label?: string }>;
  content?: string;
}

interface RijksRepresentation {
  id?: string;
  type?: string;
}

interface RijksObject {
  id?: string;
  _label?: string;
  identified_by?: RijksName[];
  produced_by?: { carried_out_by?: RijksAgent[] };
  referred_to_by?: RijksLinguistic[];
  representation?: RijksRepresentation[];
}

function extractTitle(obj: RijksObject): string | undefined {
  const named = obj.identified_by?.find(
    (n) => n.type === "Name" && typeof n.content === "string" && n.content.length > 0,
  );
  if (named?.content) return named.content;
  if (typeof obj._label === "string" && obj._label.length > 0) return obj._label;
  return undefined;
}

function extractArtist(obj: RijksObject): string | undefined {
  const agent = obj.produced_by?.carried_out_by?.find(
    (a) => typeof a._label === "string" && a._label.length > 0,
  );
  return agent?._label;
}

function extractRights(obj: RijksObject): string | undefined {
  const rights = obj.referred_to_by?.find((r) =>
    r.classified_as?.some((c) => typeof c._label === "string" && /rights/i.test(c._label)),
  );
  return rights?.content;
}

function extractImageUrl(obj: RijksObject): string | undefined {
  const rep = obj.representation?.find((r) => typeof r.id === "string" && r.id.length > 0);
  return rep?.id;
}

function buildItem(obj: RijksObject): RawSourceItem {
  const sourceUrl = obj.id;
  const title = extractTitle(obj);
  if (!sourceUrl || !title) {
    throw new Error("Rijksmuseum object missing id/title");
  }
  const rightsStatement = extractRights(obj);
  const license = classifyRijksLicense(rightsStatement);

  const item: RawSourceItem = {
    sourceUrl,
    sourceName: SOURCE_NAME,
    title,
    type: "artwork",
    tags: [],
    license,
  };
  const artist = extractArtist(obj);
  if (artist) item.artist = artist;
  if (rightsStatement) item.rightsNotes = rightsStatement;

  const imageUrl = extractImageUrl(obj);
  if (imageUrl && shouldStoreBinary(license, BINARY_ALLOWLIST)) {
    item.imageUrl = imageUrl;
  }
  return item;
}

export const rijksmuseumSource: Source = {
  name: NAME,
  displayName: DISPLAY_NAME,
  async fetchItems(limit: number, fetchImpl: typeof fetch = fetch): Promise<RawSourceItem[]> {
    const searchResponse = await fetchImpl(SEARCH_URL);
    if (!searchResponse.ok) {
      throw new Error(`Rijksmuseum search request failed: HTTP ${searchResponse.status}`);
    }
    const page = (await searchResponse.json()) as RijksSearchPage;
    const ordered = Array.isArray(page.orderedItems) ? page.orderedItems : [];
    const ids = ordered
      .map((entry) => entry?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);

    const items: RawSourceItem[] = [];
    for (const id of ids.slice(0, limit)) {
      try {
        const objResponse = await fetchImpl(id);
        if (!objResponse.ok) continue;
        const obj = (await objResponse.json()) as RijksObject;
        items.push(buildItem(obj));
      } catch {
        // Skip a single bad object — never abort the whole fetch.
      }
    }
    return items;
  },
};
