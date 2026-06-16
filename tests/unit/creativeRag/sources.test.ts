import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { articSource } from "../../../src/creativeRag/sources/artic.js";
import { LIVE_SOURCES, resolveSources } from "../../../src/creativeRag/sources/index.js";
import { metSource } from "../../../src/creativeRag/sources/met.js";
import { PLANNED_SOURCE_STUBS } from "../../../src/creativeRag/sources/plannedStubs.js";
import { rijksmuseumSource } from "../../../src/creativeRag/sources/rijksmuseum.js";

const ARTIC_LIST = "https://api.artic.edu/api/v1/artworks";
const MET_SEARCH = "https://collectionapi.metmuseum.org/public/collection/v1/search";
const MET_OBJECTS = "https://collectionapi.metmuseum.org/public/collection/v1/objects/:id";
const RIJKS_SEARCH = "https://data.rijksmuseum.nl/search/collection";

const ARTIC_LIST_RESPONSE = {
  pagination: { total: 126, limit: 2, offset: 0, total_pages: 63, current_page: 1 },
  data: [
    {
      id: 129884,
      title: "Composition",
      artist_display: "Wassily Kandinsky",
      date_display: "1923",
      medium_display: "Oil on canvas",
      classification_title: "painting",
      image_id: "b3974542-aaaa",
      is_public_domain: true,
    },
    {
      id: 200001,
      title: "Restricted Work",
      artist_display: "Modern Artist",
      date_display: "1990",
      medium_display: "Acrylic",
      classification_title: "painting",
      image_id: "c0000000-bbbb",
      is_public_domain: false,
    },
    // Malformed item: no id/title — must be skipped, not fatal.
    { artist_display: "Anonymous" },
  ],
  config: { iiif_url: "https://www.artic.edu/iiif/2", website_url: "https://www.artic.edu" },
};

const MET_SEARCH_RESPONSE = { total: 3, objectIDs: [436535, 459123, 11417] };

const MET_OBJECT_RESPONSES: Record<number, unknown> = {
  436535: {
    objectID: 436535,
    isPublicDomain: true,
    primaryImage: "https://images.metmuseum.org/cypresses/full.jpg",
    primaryImageSmall: "https://images.metmuseum.org/cypresses/small.jpg",
    title: "Wheat Field with Cypresses",
    artistDisplayName: "Vincent van Gogh",
    objectDate: "1889",
    medium: "Oil on canvas",
    classification: "Paintings",
    objectURL: "https://www.metmuseum.org/art/collection/search/436535",
  },
  459123: {
    objectID: 459123,
    isPublicDomain: false,
    primaryImage: "https://images.metmuseum.org/modern/full.jpg",
    title: "Copyrighted Painting",
    artistDisplayName: "Living Artist",
    objectDate: "1995",
    medium: "Oil on canvas",
    classification: "Paintings",
    objectURL: "https://www.metmuseum.org/art/collection/search/459123",
  },
  // 11417: malformed — missing title/objectURL, must be skipped.
  11417: { objectID: 11417, isPublicDomain: true },
};

const RIJKS_OBJECT_CC0 = "https://id.rijksmuseum.nl/200100988";
const RIJKS_OBJECT_UNKNOWN = "https://id.rijksmuseum.nl/200100999";
const RIJKS_OBJECT_BAD = "https://id.rijksmuseum.nl/000000000";

const RIJKS_SEARCH_RESPONSE = {
  type: "OrderedCollectionPage",
  partOf: { type: "OrderedCollection", totalItems: 1234 },
  orderedItems: [
    { id: RIJKS_OBJECT_CC0, type: "HumanMadeObject" },
    { id: RIJKS_OBJECT_UNKNOWN, type: "HumanMadeObject" },
    { id: RIJKS_OBJECT_BAD, type: "HumanMadeObject" },
  ],
  next: { id: "https://data.rijksmuseum.nl/search/collection?pageToken=next" },
};

// REAL data.rijksmuseum.nl Linked-Art shape (captured live):
//  - license is a CC URI under subject_of[].subject_to[].Right.classified_as[].id
//  - artist is a role-prefixed, parenthetical string in produced_by.referred_to_by[].content
//  - image is referenced via shows[] (VisualItem) — resolution is a follow-up, so imageUrl stays unset
const RIJKS_OBJECT_RESPONSES: Record<string, unknown> = {
  [RIJKS_OBJECT_CC0]: {
    id: RIJKS_OBJECT_CC0,
    type: "HumanMadeObject",
    _label: "The Night Watch",
    identified_by: [{ type: "Name", content: "The Night Watch" }],
    produced_by: {
      referred_to_by: [
        { type: "LinguisticObject", content: "printmaker: Nicolaas Wijnberg (signed by artist)" },
      ],
    },
    subject_of: [
      {
        type: "LinguisticObject",
        subject_to: [
          {
            type: "Right",
            classified_as: [
              { id: "https://creativecommons.org/publicdomain/zero/1.0/", type: "Type" },
            ],
          },
        ],
      },
    ],
    shows: [{ id: "https://id.rijksmuseum.nl/visualitem-nightwatch", type: "VisualItem" }],
  },
  [RIJKS_OBJECT_UNKNOWN]: {
    id: RIJKS_OBJECT_UNKNOWN,
    type: "HumanMadeObject",
    identified_by: [{ type: "Name", content: "Modern Loan" }],
    produced_by: {
      referred_to_by: [{ type: "LinguisticObject", content: "artist: Anon (attributed)" }],
    },
    subject_of: [
      {
        type: "LinguisticObject",
        subject_to: [
          {
            type: "Right",
            classified_as: [{ id: "https://example.org/all-rights", type: "Type" }],
          },
        ],
      },
    ],
    shows: [{ id: "https://id.rijksmuseum.nl/visualitem-loan", type: "VisualItem" }],
  },
  // Malformed — no id/label, must be skipped.
  [RIJKS_OBJECT_BAD]: { type: "HumanMadeObject" },
};

const server = setupServer(
  http.get(ARTIC_LIST, () => HttpResponse.json(ARTIC_LIST_RESPONSE)),
  http.get(MET_SEARCH, () => HttpResponse.json(MET_SEARCH_RESPONSE)),
  http.get(MET_OBJECTS, ({ params }) => {
    const id = Number(params.id);
    const obj = MET_OBJECT_RESPONSES[id];
    return obj ? HttpResponse.json(obj) : new HttpResponse(null, { status: 404 });
  }),
  http.get(RIJKS_SEARCH, () => HttpResponse.json(RIJKS_SEARCH_RESPONSE)),
  http.get("https://id.rijksmuseum.nl/:id", ({ request }) => {
    const obj = RIJKS_OBJECT_RESPONSES[request.url];
    return obj ? HttpResponse.json(obj) : new HttpResponse(null, { status: 404 });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("articSource", () => {
  it("yields RawSourceItems with correct fields and an imageUrl for public-domain items", async () => {
    const items = await articSource.fetchItems(5, fetch);
    expect(items).toHaveLength(2); // malformed item skipped

    const pd = items[0];
    expect(pd?.title).toBe("Composition");
    expect(pd?.artist).toBe("Wassily Kandinsky");
    expect(pd?.year).toBe(1923);
    expect(pd?.sourceUrl).toBe("https://www.artic.edu/artworks/129884");
    expect(pd?.license).toBe("PublicDomain");
    expect(pd?.imageUrl).toBe("https://www.artic.edu/iiif/2/b3974542-aaaa/full/843,/0/default.jpg");

    const restricted = items[1];
    expect(restricted?.license).toBe("Unknown");
    expect(restricted?.imageUrl).toBeUndefined();
  });
});

describe("metSource", () => {
  it("two-step search→object, public-domain gets imageUrl, non-PD does not", async () => {
    const items = await metSource.fetchItems(5, fetch);
    expect(items).toHaveLength(2); // malformed object skipped

    const pd = items[0];
    expect(pd?.title).toBe("Wheat Field with Cypresses");
    expect(pd?.artist).toBe("Vincent van Gogh");
    expect(pd?.year).toBe(1889);
    expect(pd?.sourceUrl).toBe("https://www.metmuseum.org/art/collection/search/436535");
    expect(pd?.license).toBe("PublicDomain");
    expect(pd?.imageUrl).toBe("https://images.metmuseum.org/cypresses/full.jpg");

    const restricted = items[1];
    expect(restricted?.license).toBe("Unknown");
    expect(restricted?.imageUrl).toBeUndefined();
  });

  it("caps the object loop at the limit", async () => {
    const items = await metSource.fetchItems(1, fetch);
    expect(items).toHaveLength(1);
    expect(items[0]?.sourceUrl).toBe("https://www.metmuseum.org/art/collection/search/436535");
  });
});

describe("rijksmuseumSource", () => {
  it("parses Linked-Art defensively and classifies rights", async () => {
    const items = await rijksmuseumSource.fetchItems(5, fetch);
    expect(items).toHaveLength(2); // malformed object skipped

    const cc0 = items.find((i) => i.title === "The Night Watch");
    expect(cc0?.artist).toBe("Nicolaas Wijnberg");
    expect(cc0?.sourceUrl).toBe(RIJKS_OBJECT_CC0);
    expect(cc0?.license).toBe("CC0");
    expect(cc0?.rightsNotes).toContain("creativecommons.org");
    // Image binary resolution is a documented follow-up — imageUrl stays unset.
    expect(cc0?.imageUrl).toBeUndefined();

    // A non-license taxonomy URI must NOT be promoted to the rights statement: the
    // object's only classification id is non-CC, so license stays Unknown and no
    // misleading rightsNotes is set.
    const unknown = items.find((i) => i.title === "Modern Loan");
    expect(unknown?.license).toBe("Unknown");
    expect(unknown?.rightsNotes).toBeUndefined();
    expect(unknown?.imageUrl).toBeUndefined();
  });
});

describe("resolveSources", () => {
  it("returns all live sources with no names", () => {
    expect(resolveSources()).toEqual(LIVE_SOURCES);
    expect(resolveSources([])).toEqual(LIVE_SOURCES);
  });

  it("filters to the requested source", () => {
    const resolved = resolveSources(["artic"]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.name).toBe("artic");
  });

  it("ignores unknown source keys", () => {
    expect(resolveSources(["nope"])).toHaveLength(0);
  });
});

describe("PLANNED_SOURCE_STUBS", () => {
  it("has 10 entries each with a non-empty reason and planned status", () => {
    expect(PLANNED_SOURCE_STUBS).toHaveLength(10);
    for (const stub of PLANNED_SOURCE_STUBS) {
      expect(stub.status).toBe("planned");
      expect(stub.name.length).toBeGreaterThan(0);
      expect(stub.reason.trim().length).toBeGreaterThan(0);
    }
  });
});
