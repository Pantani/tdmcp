/**
 * Creative RAG — deterministic fixtures shared across builders' tests.
 *
 * `SAMPLE_CARDS` are valid {@link CreativeRagCard}s (varied license/type) with
 * ids/hashes derived from the real helpers, so round-trip and hash tests stay
 * self-consistent. The `*_RESPONSE` constants are the canonical raw API payload
 * shapes documented in the spec; B/C/D/E mock their HTTP handlers from these so
 * every builder's mocks match the live wire format from one place.
 */

import { computeContentHash, computeId } from "./cardParser.js";
import type { CreativeRagCard } from "./types.js";

function buildCard(card: Omit<CreativeRagCard, "id" | "contentHash">): CreativeRagCard {
  const id = computeId(card.sourceUrl);
  const withId: CreativeRagCard = { ...card, id, contentHash: "" };
  return { ...withId, contentHash: computeContentHash(withId) };
}

/** ≥3 deterministic sample cards spanning licenses and types. */
export const SAMPLE_CARDS: CreativeRagCard[] = [
  buildCard({
    schemaVersion: 1,
    type: "artwork",
    title: "Composition",
    artist: "Wassily Kandinsky",
    sourceUrl: "https://www.artic.edu/artworks/129884",
    sourceName: "Art Institute of Chicago",
    license: "PublicDomain",
    rightsNotes: "Public domain — no copyright restrictions.",
    year: 1923,
    medium: "Oil on canvas",
    tools: [],
    tags: ["abstract", "geometric", "color-field"],
    visualLanguage: "hard-edged geometric abstraction, primary triads",
    palette: ["#d62828", "#003049", "#fcbf49"],
    tdmcpAffordances: ["create_generative_art", "create_color_grade"],
    body: "Kandinsky's interlocking circles and angular planes — a reference for\ngenerative geometric color studies.",
  }),
  buildCard({
    schemaVersion: 1,
    type: "technique",
    title: "Reaction-diffusion morphogenesis",
    sourceUrl: "https://example.org/techniques/reaction-diffusion",
    sourceName: "Creative RAG Seed",
    license: "CC0",
    rightsNotes: "CC0 1.0 — dedicated to the public domain.",
    tools: [],
    tags: ["organic", "pattern", "simulation"],
    motionLanguage: "slow emergent spotting and labyrinthine growth",
    tdmcpAffordances: ["create_reaction_diffusion", "create_growth_system"],
    body: "Gray-Scott parameters that drift from spots to stripes; couple to audio\nfor a breathing organic field.",
  }),
  buildCard({
    schemaVersion: 1,
    type: "artist",
    title: "Vincent van Gogh",
    artist: "Vincent van Gogh",
    sourceUrl: "https://www.metmuseum.org/art/collection/search/436535",
    sourceName: "The Metropolitan Museum of Art",
    license: "Unknown",
    rightsNotes: "Rights status not confirmed for this record.",
    tools: [],
    tags: ["impasto", "expressive", "landscape"],
    visualLanguage: "thick directional brushwork, swirling skies",
    tdmcpAffordances: ["create_displacement_warp", "create_pixel_sort"],
    body: "Reference for impasto-driven displacement and turbulent motion fields.",
  }),
];

/** Art Institute of Chicago — list response (`GET /api/v1/artworks`). */
export const ARTIC_LIST_RESPONSE = {
  pagination: { total: 126, limit: 2, offset: 0, total_pages: 63, current_page: 1 },
  data: [
    {
      id: 129884,
      title: "Composition",
      artist_display: "Wassily Kandinsky",
      date_display: "1923",
      medium_display: "Oil on canvas",
      classification_title: "painting",
      image_id: "b3974542-aaaa-bbbb-cccc-ddddeeeeffff",
      is_public_domain: true,
    },
    {
      id: 200154,
      title: "Untitled (Restricted)",
      artist_display: "Living Artist",
      date_display: "2010",
      medium_display: "Acrylic on panel",
      classification_title: "painting",
      image_id: "11112222-3333-4444-5555-666677778888",
      is_public_domain: false,
    },
  ],
  config: { iiif_url: "https://www.artic.edu/iiif/2", website_url: "https://www.artic.edu" },
} as const;

/**
 * AIC has no separate detail endpoint in the MVP path (the list `fields=` query
 * returns everything the adapter needs), so the "detail" fixture is one row of
 * the list payload for any test that wants a single object in isolation.
 */
export const ARTIC_DETAIL_RESPONSE = {
  data: ARTIC_LIST_RESPONSE.data[0],
  config: ARTIC_LIST_RESPONSE.config,
} as const;

/** The Met — search response (`GET /public/collection/v1/search`). */
export const MET_SEARCH_RESPONSE = {
  total: 3,
  objectIDs: [436535, 459123, 11417],
} as const;

/** The Met — object response (`GET /public/collection/v1/objects/{id}`). */
export const MET_OBJECT_RESPONSE = {
  objectID: 436535,
  isPublicDomain: true,
  primaryImage: "https://images.metmuseum.org/CRDImages/ep/original/full.jpg",
  primaryImageSmall: "https://images.metmuseum.org/CRDImages/ep/web-large/small.jpg",
  title: "Wheat Field with Cypresses",
  artistDisplayName: "Vincent van Gogh",
  objectDate: "1889",
  medium: "Oil on canvas",
  classification: "Paintings",
  objectURL: "https://www.metmuseum.org/art/collection/search/436535",
} as const;

/** Rijksmuseum — Search collection page (`GET data.rijksmuseum.nl/search/collection`). */
export const RIJKS_SEARCH_RESPONSE = {
  type: "OrderedCollectionPage",
  partOf: { type: "OrderedCollection", totalItems: 1234 },
  orderedItems: [{ id: "https://id.rijksmuseum.nl/200100988", type: "HumanMadeObject" }],
  next: { id: "https://data.rijksmuseum.nl/search/collection?pageToken=abc" },
} as const;

/** Rijksmuseum — Linked-Art object response (resolved from an `orderedItems[].id`). */
export const RIJKS_OBJECT_RESPONSE = {
  id: "https://id.rijksmuseum.nl/200100988",
  type: "HumanMadeObject",
  _label: "The Night Watch",
  identified_by: [{ type: "Name", content: "The Night Watch" }],
  produced_by: { carried_out_by: [{ _label: "Rembrandt van Rijn" }] },
  referred_to_by: [
    {
      type: "LinguisticObject",
      classified_as: [{ _label: "rights" }],
      content: "Public Domain",
    },
  ],
  representation: [{ id: "https://iiif.micr.io/abcd/image", type: "VisualItem" }],
} as const;

/** Ollama — `/api/embed` response (current array-of-vectors shape). */
export const OLLAMA_EMBED_RESPONSE = {
  model: "nomic-embed-text",
  embeddings: [[0.01, -0.02, 0.03]],
} as const;
