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

  it("throws SourceSkippedError(reason:'no-key') and does not fetch when the API key is absent", async () => {
    vi.stubEnv("TDMCP_RAG_EUROPEANA_KEY", "");
    // Skipped source, not an empty result — see SourceSkippedError / service.sync.
    const err = await europeanaSource.fetchItems(5, fetch).catch((e) => e);
    expect(err).toBeInstanceOf(SourceSkippedError);
    // The no-key skip must be discriminable so a misconfigured key never looks like an
    // empty catalog to the sync/tombstone logic.
    expect((err as SourceSkippedError).reason).toBe("no-key");
    expect(fetchCalls).toBe(0);
  });

  it("throws SourceSkippedError(reason:'empty') on a keyed request that returns zero items", async () => {
    // A keyed request that came back empty is an untrusted skip, NOT a successful empty
    // sync — otherwise a rejected key / silent upstream outage (HTTP 200, no items) would
    // tombstone every existing Europeana card. Distinct reason from the no-key case.
    vi.stubEnv("TDMCP_RAG_EUROPEANA_KEY", "test-key");
    let reached = false;
    server.use(
      http.get(EUROPEANA_SEARCH, () => {
        reached = true;
        return HttpResponse.json({ items: [] });
      }),
    );
    const err = await europeanaSource.fetchItems(5, fetch).catch((e) => e);
    expect(err).toBeInstanceOf(SourceSkippedError);
    expect((err as SourceSkippedError).reason).toBe("empty");
    // It DID reach the upstream (reason "empty" is only reachable post-fetch), unlike the
    // no-key case which short-circuits before any request.
    expect(reached).toBe(true);
  });
});

describe("europeana canonicalizeGuid (wskey never leaks into sourceUrl/id)", () => {
  // Regression for the wskey-strip lesson: Europeana appends the caller's API key to the
  // item `guid` as query params. The persisted `sourceUrl` (and `id = sha256(sourceUrl)`)
  // MUST be the canonical, key-free origin+path so it (a) never embeds the secret and
  // (b) stays stable across different keys. canonicalizeGuid is internal, so this pins the
  // rule through the public fetchItems mapping — both the URL-parse and string-fallback
  // branches.
  const KEY = "leaky-secret-key";

  function respond(guid: string): void {
    server.use(
      http.get(EUROPEANA_SEARCH, () =>
        HttpResponse.json({
          items: [
            {
              title: ["Item"],
              guid,
              rights: ["http://creativecommons.org/publicdomain/zero/1.0/"],
            },
          ],
        }),
      ),
    );
  }

  it("strips the wskey query string from a well-formed guid URL", async () => {
    vi.stubEnv("TDMCP_RAG_EUROPEANA_KEY", KEY);
    respond(
      `https://www.europeana.eu/item/0/abc?utm_source=api&utm_medium=api&utm_campaign=${KEY}`,
    );
    const [item] = await europeanaSource.fetchItems(1, fetch);
    expect(item?.sourceUrl).toBe("https://www.europeana.eu/item/0/abc");
    expect(item?.sourceUrl).not.toContain(KEY);
    expect(item?.sourceUrl).not.toContain("?");
    expect(item?.sourceUrl).not.toContain("wskey");
  });

  it("produces a key-stable sourceUrl regardless of which key is appended", async () => {
    const guidFor = (k: string) => `https://www.europeana.eu/item/0/abc?utm_campaign=${k}`;
    vi.stubEnv("TDMCP_RAG_EUROPEANA_KEY", "key-A");
    respond(guidFor("key-A"));
    const [a] = await europeanaSource.fetchItems(1, fetch);
    vi.stubEnv("TDMCP_RAG_EUROPEANA_KEY", "key-B");
    respond(guidFor("key-B"));
    const [b] = await europeanaSource.fetchItems(1, fetch);
    // Same canonical id across keys → the persisted id never drifts with the credential.
    expect(a?.sourceUrl).toBe(b?.sourceUrl);
    expect(a?.sourceUrl).toBe("https://www.europeana.eu/item/0/abc");
  });

  it("falls back to a manual '?' strip for a guid the URL constructor rejects", async () => {
    vi.stubEnv("TDMCP_RAG_EUROPEANA_KEY", KEY);
    // A relative (schemeless) guid makes `new URL()` throw, exercising the string-fallback
    // branch of canonicalizeGuid. The key past the '?' must still be dropped.
    respond(`item/0/abc?wskey=${KEY}`);
    const [item] = await europeanaSource.fetchItems(1, fetch);
    expect(item?.sourceUrl).toBe("item/0/abc");
    expect(item?.sourceUrl).not.toContain(KEY);
    expect(item?.sourceUrl).not.toContain("?");
  });
});
