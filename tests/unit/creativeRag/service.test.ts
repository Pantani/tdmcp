import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { computeId, parseCard } from "../../../src/creativeRag/cardParser.js";
import { JsonlIndexStore } from "../../../src/creativeRag/indexStore.js";
import { OllamaEmbeddingsClient } from "../../../src/creativeRag/ollamaClient.js";
import { createCreativeRagService } from "../../../src/creativeRag/service.js";
import type { CreativeRagConfig, RawSourceItem, Source } from "../../../src/creativeRag/types.js";

const OLLAMA_BASE = "http://127.0.0.1:11434";
const IMG_URL = "https://example.test/img/public.jpg";

// Two raw items: one PublicDomain (allowlisted, has an image) and one Unknown
// (not allowlisted, has an image → binary must be skipped).
const PUBLIC_ITEM: RawSourceItem = {
  sourceUrl: "https://www.artic.edu/artworks/129884",
  sourceName: "Art Institute of Chicago",
  title: "Composition",
  artist: "Wassily Kandinsky",
  year: 1923,
  medium: "Oil on canvas",
  type: "artwork",
  tags: ["abstract", "geometric"],
  license: "PublicDomain",
  rightsNotes: "Public domain.",
  imageUrl: IMG_URL,
};
const UNKNOWN_ITEM: RawSourceItem = {
  sourceUrl: "https://www.metmuseum.org/art/collection/search/999",
  sourceName: "The Met",
  title: "Untitled (Restricted)",
  type: "artwork",
  tags: ["modern"],
  license: "Unknown",
  imageUrl: IMG_URL,
};

// A fake source that fetches a "manifest" over the injected fetchImpl (so msw is
// exercised) and maps it to the two raw items. Mirrors the 3-museum mock surface
// without depending on Builder D's not-yet-present sources/ module.
function makeFakeSource(name: string, manifestUrl: string, items: RawSourceItem[]): Source {
  return {
    name,
    displayName: name,
    async fetchItems(limit, fetchImpl): Promise<RawSourceItem[]> {
      const f = fetchImpl ?? fetch;
      await f(manifestUrl); // exercises the mocked museum endpoint
      // A source labels its own items, mirroring the real adapters where
      // item.sourceName === source.displayName (the join used for tombstone scoping).
      return items.slice(0, limit).map((item) => ({ ...item, sourceName: name }));
    },
  };
}

const server = setupServer(
  http.get("https://api.artic.edu/manifest", () => HttpResponse.json({ ok: true })),
  http.get("https://collectionapi.metmuseum.org/manifest", () => HttpResponse.json({ ok: true })),
  http.get("https://data.rijksmuseum.nl/manifest", () => HttpResponse.json({ ok: true })),
  http.get(IMG_URL, () => HttpResponse.arrayBuffer(new Uint8Array([1, 2, 3, 4]).buffer)),
  http.post(`${OLLAMA_BASE}/api/embed`, async ({ request }) => {
    const body = (await request.json()) as { input: string[] };
    const embeddings = body.input.map((_text, i) => [0.1 * (i + 1), 0.2, 0.3]);
    return HttpResponse.json({ model: "nomic-embed-text", embeddings });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "crag-svc-"));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function makeConfig(): CreativeRagConfig {
  return {
    enabled: true,
    dataDir,
    ollamaUrl: OLLAMA_BASE,
    embedModel: "nomic-embed-text",
    licenseAllowlist: ["CC0", "PublicDomain"],
  };
}

function makeService(sources: Source[]) {
  const config = makeConfig();
  return createCreativeRagService({
    config,
    sources,
    embeddings: new OllamaEmbeddingsClient({ baseUrl: OLLAMA_BASE }),
    store: new JsonlIndexStore({ filePath: join(dataDir, "index.jsonl") }),
  });
}

describe("creativeRag service.sync", () => {
  it("writes a card file per item and stores a binary only for allowlisted licenses", async () => {
    const sources = [
      makeFakeSource("artic", "https://api.artic.edu/manifest", [PUBLIC_ITEM]),
      makeFakeSource("met", "https://collectionapi.metmuseum.org/manifest", [UNKNOWN_ITEM]),
    ];
    const report = await makeService(sources).sync({});

    expect(report.added).toBe(2);
    expect(report.binariesStored).toBe(1); // only PublicDomain
    expect(report.skippedNoLicense).toBe(1); // Unknown image skipped
    expect(report.perSource).toEqual({ artic: 1, met: 1 });

    const cardsDir = join(dataDir, "cards");
    const publicId = parseCard(
      readFileSync(join(cardsDir, `${hashUrl(PUBLIC_ITEM.sourceUrl)}.md`), "utf8"),
    ).id;
    expect(publicId).toBe(hashUrl(PUBLIC_ITEM.sourceUrl));

    // Binary stored for the PublicDomain card; absent for the Unknown one.
    expect(existsSync(join(dataDir, "binaries", `${hashUrl(PUBLIC_ITEM.sourceUrl)}.jpg`))).toBe(
      true,
    );
    expect(existsSync(join(dataDir, "binaries", `${hashUrl(UNKNOWN_ITEM.sourceUrl)}.jpg`))).toBe(
      false,
    );
  });

  it("tombstones a card dropped on the second sync (does not delete it)", async () => {
    const both = [
      makeFakeSource("artic", "https://api.artic.edu/manifest", [PUBLIC_ITEM, UNKNOWN_ITEM]),
    ];
    await makeService(both).sync({});

    // Second run returns only the PublicDomain item → the Unknown one is tombstoned.
    const fewer = [makeFakeSource("artic", "https://api.artic.edu/manifest", [PUBLIC_ITEM])];
    const report = await makeService(fewer).sync({});
    expect(report.tombstoned).toBe(1);

    const droppedPath = join(dataDir, "cards", `${hashUrl(UNKNOWN_ITEM.sourceUrl)}.md`);
    expect(existsSync(droppedPath)).toBe(true); // not deleted
    expect(parseCard(readFileSync(droppedPath, "utf8")).tombstone).toBe(true);

    // getCard hides a tombstoned card.
    const card = await makeService(fewer).getCard(hashUrl(UNKNOWN_ITEM.sourceUrl));
    expect(card).toBeUndefined();
  });

  it("respects the --source filter via sync opts", async () => {
    const sources = [
      makeFakeSource("artic", "https://api.artic.edu/manifest", [PUBLIC_ITEM]),
      makeFakeSource("met", "https://collectionapi.metmuseum.org/manifest", [UNKNOWN_ITEM]),
    ];
    const report = await makeService(sources).sync({ sources: ["artic"] });
    expect(report.perSource).toEqual({ artic: 1 });
    expect(report.added).toBe(1);
  });

  it("does not tombstone cards from sources not synced this run", async () => {
    const sources = [
      makeFakeSource("artic", "https://api.artic.edu/manifest", [PUBLIC_ITEM]),
      makeFakeSource("met", "https://collectionapi.metmuseum.org/manifest", [UNKNOWN_ITEM]),
    ];
    await makeService(sources).sync({});

    // A targeted refresh of only "artic" must leave "met"'s card untouched.
    const report = await makeService(sources).sync({ sources: ["artic"] });
    expect(report.tombstoned).toBe(0);

    const metPath = join(dataDir, "cards", `${hashUrl(UNKNOWN_ITEM.sourceUrl)}.md`);
    expect(parseCard(readFileSync(metPath, "utf8")).tombstone).not.toBe(true);
    expect(await makeService(sources).getCard(hashUrl(UNKNOWN_ITEM.sourceUrl))).toBeDefined();
  });

  it("does not tombstone cards from a source whose fetch failed this run", async () => {
    await makeService([
      makeFakeSource("artic", "https://api.artic.edu/manifest", [PUBLIC_ITEM]),
      makeFakeSource("met", "https://collectionapi.metmuseum.org/manifest", [UNKNOWN_ITEM]),
    ]).sync({});

    // Met now throws; artic still returns its item. Met's card must survive the run.
    const failingMet: Source = {
      name: "met",
      displayName: "met",
      async fetchItems() {
        throw new Error("met upstream is down");
      },
    };
    const report = await makeService([
      makeFakeSource("artic", "https://api.artic.edu/manifest", [PUBLIC_ITEM]),
      failingMet,
    ]).sync({});
    expect(report.tombstoned).toBe(0);

    const metPath = join(dataDir, "cards", `${hashUrl(UNKNOWN_ITEM.sourceUrl)}.md`);
    expect(parseCard(readFileSync(metPath, "utf8")).tombstone).not.toBe(true);
  });
});

describe("creativeRag service.index", () => {
  it("embeds uncached cards and skips cached ones on a re-run", async () => {
    const sources = [
      makeFakeSource("artic", "https://api.artic.edu/manifest", [PUBLIC_ITEM, UNKNOWN_ITEM]),
    ];
    await makeService(sources).sync({});

    const svc = makeService(sources);
    const first = await svc.index();
    expect(first.total).toBe(2);
    expect(first.embedded).toBe(2);
    expect(first.cachedSkipped).toBe(0);

    const second = await svc.index();
    expect(second.embedded).toBe(0);
    expect(second.cachedSkipped).toBe(2);
  });

  it("purges tombstoned cards from the search index", async () => {
    const both = [
      makeFakeSource("artic", "https://api.artic.edu/manifest", [PUBLIC_ITEM, UNKNOWN_ITEM]),
    ];
    await makeService(both).sync({});
    await makeService(both).index();

    // Drop the Unknown item, re-sync (tombstones it) then re-index (must purge its row).
    const fewer = [makeFakeSource("artic", "https://api.artic.edu/manifest", [PUBLIC_ITEM])];
    await makeService(fewer).sync({});
    await makeService(fewer).index();

    const results = await makeService(fewer).search("anything", 10);
    const droppedId = hashUrl(UNKNOWN_ITEM.sourceUrl);
    expect(results.some((r) => r.id === droppedId)).toBe(false);
    expect(results.some((r) => r.id === hashUrl(PUBLIC_ITEM.sourceUrl))).toBe(true);
  });

  it("re-embeds a card whose Markdown was edited without bumping its frontmatter hash", async () => {
    const sources = [makeFakeSource("artic", "https://api.artic.edu/manifest", [PUBLIC_ITEM])];
    await makeService(sources).sync({});
    expect((await makeService(sources).index()).embedded).toBe(1);

    // Simulate a hand-edit: change the title in the frontmatter but leave the stale
    // `contentHash` untouched — the index must recompute the hash and re-embed.
    const cardPath = join(dataDir, "cards", `${hashUrl(PUBLIC_ITEM.sourceUrl)}.md`);
    const edited = readFileSync(cardPath, "utf8").replace(
      "title: Composition",
      "title: Composition (revised)",
    );
    writeFileSync(cardPath, edited, "utf8");

    const report = await makeService(sources).index();
    expect(report.embedded).toBe(1);
    expect(report.cachedSkipped).toBe(0);
  });
});

describe("creativeRag service.search", () => {
  it("returns ranked results carrying sourceUrl and license", async () => {
    const sources = [
      makeFakeSource("artic", "https://api.artic.edu/manifest", [PUBLIC_ITEM, UNKNOWN_ITEM]),
    ];
    await makeService(sources).sync({});
    await makeService(sources).index();

    const results = await makeService(sources).search("geometric abstraction", 5);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(typeof r.sourceUrl).toBe("string");
      expect(r.license).toBeTruthy();
    }
    // Sorted descending by score.
    const scores = results.map((r) => r.score);
    const sorted = [...scores].sort((a, b) => b - a);
    expect(scores).toEqual(sorted);
  });
});

function hashUrl(url: string): string {
  return computeId(url);
}
