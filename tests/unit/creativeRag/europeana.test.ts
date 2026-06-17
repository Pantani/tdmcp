import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SourceSkippedError } from "../../../src/creativeRag/sources/errors.js";
import { europeanaSource } from "../../../src/creativeRag/sources/europeana.js";

const EUROPEANA_SEARCH = "https://api.europeana.eu/record/v2/search.json";

const EUROPEANA_RESPONSE = {
  items: [
    {
      title: ["X"],
      dcCreator: ["Artist"],
      // Europeana appends the caller's wskey to the guid — the adapter must strip it.
      guid: "https://www.europeana.eu/item/0/abc?utm_source=api&utm_medium=api&utm_campaign=test-key",
      rights: ["http://creativecommons.org/publicdomain/zero/1.0/"],
      edmPreview: ["https://example.org/thumb.jpg"],
      year: ["1888"],
    },
    {
      title: ["Restricted Work"],
      dcCreator: ["Living Artist"],
      guid: "https://www.europeana.eu/item/0/def",
      rights: ["http://rightsstatements.org/vocab/InC/1.0/"],
      edmPreview: ["https://example.org/restricted.jpg"],
      year: ["1995"],
    },
  ],
};

let fetchCalls = 0;

const server = setupServer(
  http.get(EUROPEANA_SEARCH, () => {
    fetchCalls += 1;
    return HttpResponse.json(EUROPEANA_RESPONSE);
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  vi.unstubAllEnvs();
  fetchCalls = 0;
});
afterAll(() => server.close());

describe("europeanaSource", () => {
  it("maps open-rights items (with image) and classifies restricted ones as Unknown", async () => {
    vi.stubEnv("TDMCP_RAG_EUROPEANA_KEY", "test-key");
    const items = await europeanaSource.fetchItems(5, fetch);
    expect(items).toHaveLength(2);

    const open = items.find((i) => i.title === "X");
    expect(open?.license).toBe("CC0");
    expect(open?.artist).toBe("Artist");
    expect(open?.year).toBe(1888);
    // guid query string (carrying the wskey) is stripped → canonical, key-free sourceUrl.
    expect(open?.sourceUrl).toBe("https://www.europeana.eu/item/0/abc");
    expect(open?.sourceUrl).not.toContain("test-key");
    expect(open?.imageUrl).toBe("https://example.org/thumb.jpg");
    expect(open?.rightsNotes).toBe("http://creativecommons.org/publicdomain/zero/1.0/");

    const restricted = items.find((i) => i.title === "Restricted Work");
    expect(restricted?.license).toBe("Unknown");
    expect(restricted?.imageUrl).toBeUndefined();
  });

  it("suppresses imageUrl under an empty allowlist", async () => {
    vi.stubEnv("TDMCP_RAG_EUROPEANA_KEY", "test-key");
    const items = await europeanaSource.fetchItems(5, fetch, []);
    expect(items.find((i) => i.title === "X")?.imageUrl).toBeUndefined();
  });

  it("throws SourceSkippedError (not an empty sync) and does not fetch when the API key is absent", async () => {
    vi.stubEnv("TDMCP_RAG_EUROPEANA_KEY", "");
    // Skipped source, not an empty result — see SourceSkippedError / service.sync.
    await expect(europeanaSource.fetchItems(5, fetch)).rejects.toBeInstanceOf(SourceSkippedError);
    expect(fetchCalls).toBe(0);
  });
});
