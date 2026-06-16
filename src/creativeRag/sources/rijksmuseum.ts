/**
 * Rijksmuseum source adapter (data.rijksmuseum.nl, keyless).
 *
 * Two-step Linked-Art (JSON-LD): a `search/collection` page yields object ids,
 * then each id resolves to a Linked-Art object. The JSON-LD shape is the riskiest
 * to parse, so every field map is defensive: optional-chaining with per-field
 * fallbacks, and a single bad object is skipped, never fatal.
 *
 * Field maps below were corrected against a LIVE capture of `id.rijksmuseum.nl/2001`:
 *  - License (CC0) lives under `subject_of[].subject_to[].Right.classified_as[].id`
 *    as a Creative Commons URI — NOT top-level `referred_to_by`.
 *  - Artist is in `produced_by.referred_to_by[].content` (a role-prefixed,
 *    parenthetical string) — NOT `produced_by.carried_out_by`.
 *  - There is no `representation` field; the image is referenced via
 *    `shows[].id` (VisualItem) and needs two more fetches to resolve a URL.
 */

import { classifyRijksLicense, shouldStoreBinary } from "../licensePolicy.js";
import type { CreativeRagLicense, RawSourceItem, Source } from "../types.js";
import { fetchWithTimeout } from "./http.js";

/** Binaries are only retained for these licenses (mirrors the default allowlist). */
const BINARY_ALLOWLIST: CreativeRagLicense[] = ["CC0", "PublicDomain"];

/** A license URI we recognise — Creative Commons or a public-domain mark/statement. */
function isLicenseUri(id: string): boolean {
  return /creativecommons\.org|\/publicdomain\/|rightsstatements\.org/i.test(id);
}

const NAME = "rijksmuseum";
const DISPLAY_NAME = "Rijksmuseum";
const SOURCE_NAME = DISPLAY_NAME;
const SEARCH_URL = "https://data.rijksmuseum.nl/search/collection?imageAvailable=true";

interface RijksSearchPage {
  orderedItems?: Array<{ id?: string }> | null;
}

interface RijksName {
  type?: string;
  content?: string;
}

/** A Linked-Art `Right` node carrying the license as a CC URI in `classified_as[].id`. */
interface RijksRight {
  type?: string;
  classified_as?: Array<{ id?: string; type?: string }>;
}

/** A `LinguisticObject` (or similar) that may carry `subject_to[]` Right nodes. */
interface RijksSubjectOf {
  type?: string;
  subject_to?: RijksRight[];
}

/** `produced_by.referred_to_by[]` entries carry the artist name in `content`. */
interface RijksProducedRef {
  type?: string;
  content?: string;
}

interface RijksObject {
  id?: string;
  _label?: string;
  identified_by?: RijksName[];
  produced_by?: { referred_to_by?: RijksProducedRef[] };
  subject_of?: RijksSubjectOf[];
  subject_to?: RijksRight[];
  shows?: Array<{ id?: string }>;
}

/** A `VisualItem` (object.shows[]) pointing to one or more digital surrogates. */
interface RijksVisualItem {
  digitally_shown_by?: Array<{ id?: string }>;
}

/** A `DigitalObject` whose `access_point[].id` is the actual (IIIF) image URL. */
interface RijksDigitalObject {
  access_point?: Array<{ id?: string }>;
}

function extractTitle(obj: RijksObject): string | undefined {
  const named = obj.identified_by?.find(
    (n) => n.type === "Name" && typeof n.content === "string" && n.content.length > 0,
  );
  if (named?.content) return named.content;
  if (typeof obj._label === "string" && obj._label.length > 0) return obj._label;
  return undefined;
}

/**
 * Artist from `produced_by.referred_to_by[].content`, e.g.
 * `"printmaker: Nicolaas Wijnberg (signed by artist)"`. Strip a leading role
 * prefix and a trailing parenthetical, prefer the shortest clean entry.
 */
function extractArtist(obj: RijksObject): string | undefined {
  const refs = obj.produced_by?.referred_to_by ?? [];
  let best: string | undefined;
  for (const ref of refs) {
    if (typeof ref.content !== "string") continue;
    const cleaned = ref.content
      .replace(/^[^:]+:\s*/, "")
      .replace(/\s*\(.*\)\s*$/, "")
      .trim();
    if (cleaned.length === 0) continue;
    if (best === undefined || cleaned.length < best.length) best = cleaned;
  }
  return best;
}

/**
 * License (CC0 etc.) from the real shape: `subject_of[].subject_to[].Right`'s
 * `classified_as[].id` Creative Commons URI. Also accepts a top-level
 * `subject_to[]` for extra robustness. Returns the first CC URI found.
 */
function extractRightsUri(obj: RijksObject): string | undefined {
  const rights: RijksRight[] = [];
  for (const subjectOf of obj.subject_of ?? []) {
    for (const right of subjectOf.subject_to ?? []) rights.push(right);
  }
  for (const right of obj.subject_to ?? []) rights.push(right);

  // Only a recognised license URI (CC / public-domain) is returned — a non-license
  // taxonomy URI must never masquerade as the rights statement, so if none match we
  // return undefined (license stays Unknown, no misleading rightsNotes).
  for (const right of rights) {
    for (const cls of right.classified_as ?? []) {
      if (typeof cls.id === "string" && isLicenseUri(cls.id)) return cls.id;
    }
  }
  return undefined;
}

function buildItem(obj: RijksObject): RawSourceItem {
  const sourceUrl = obj.id;
  const title = extractTitle(obj);
  if (!sourceUrl || !title) {
    throw new Error("Rijksmuseum object missing id/title");
  }
  const rightsUri = extractRightsUri(obj);
  const license = classifyRijksLicense(rightsUri);

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
  if (rightsUri) item.rightsNotes = rightsUri;

  // imageUrl is resolved separately in fetchItems (only for allowlisted licenses):
  // the object has no `representation` field — the image is reached via the
  // shows → VisualItem → DigitalObject → access_point chain (two extra fetches).
  return item;
}

/**
 * Resolve a Rijksmuseum image URL by walking the Linked-Art chain:
 * `object.shows[].id` (VisualItem) → `digitally_shown_by[].id` (DigitalObject) →
 * `access_point[].id` (the IIIF image). Two extra fetches; any failure (or a
 * non-OK response / missing link) resolves to undefined so the item is still kept.
 */
async function resolveImageUrl(
  obj: RijksObject,
  fetchImpl: typeof fetch,
): Promise<string | undefined> {
  const visualId = obj.shows?.find((s) => typeof s.id === "string" && s.id.length > 0)?.id;
  if (visualId === undefined) return undefined;
  try {
    const visualRes = await fetchWithTimeout(visualId, fetchImpl, `Rijksmuseum visual ${visualId}`);
    if (!visualRes.ok) return undefined;
    const visual = (await visualRes.json()) as RijksVisualItem;
    const digitalId = visual.digitally_shown_by?.find(
      (d) => typeof d.id === "string" && d.id.length > 0,
    )?.id;
    if (digitalId === undefined) return undefined;
    const digitalRes = await fetchWithTimeout(
      digitalId,
      fetchImpl,
      `Rijksmuseum digital ${digitalId}`,
    );
    if (!digitalRes.ok) return undefined;
    const digital = (await digitalRes.json()) as RijksDigitalObject;
    return digital.access_point?.find((a) => typeof a.id === "string" && a.id.length > 0)?.id;
  } catch {
    return undefined;
  }
}

export const rijksmuseumSource: Source = {
  name: NAME,
  displayName: DISPLAY_NAME,
  async fetchItems(limit: number, fetchImpl: typeof fetch = fetch): Promise<RawSourceItem[]> {
    const searchResponse = await fetchWithTimeout(
      SEARCH_URL,
      fetchImpl,
      "Rijksmuseum search request",
    );
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
        const objResponse = await fetchWithTimeout(id, fetchImpl, `Rijksmuseum object ${id}`);
        if (!objResponse.ok) continue;
        const obj = (await objResponse.json()) as RijksObject;
        const item = buildItem(obj);
        // Resolve + attach an image only when the license allows storing a binary —
        // no point spending two extra fetches on items whose binary we'd never keep.
        if (shouldStoreBinary(item.license, BINARY_ALLOWLIST)) {
          const imageUrl = await resolveImageUrl(obj, fetchImpl);
          if (imageUrl !== undefined) item.imageUrl = imageUrl;
        }
        items.push(item);
      } catch {
        // Skip a single bad object — never abort the whole fetch.
      }
    }
    return items;
  },
};
