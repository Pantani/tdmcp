import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlIndexStore } from "../../../src/creativeRag/indexStore.js";
import type { EmbeddedCard } from "../../../src/creativeRag/types.js";

function makeCard(overrides: Partial<EmbeddedCard> & Pick<EmbeddedCard, "id">): EmbeddedCard {
  return {
    contentHash: "hash",
    embeddingModel: "nomic-embed-text",
    embedding: [1, 0, 0],
    title: `card-${overrides.id}`,
    type: "artwork",
    license: "PublicDomain",
    tags: [],
    sourceUrl: `https://example.com/${overrides.id}`,
    sourceName: "Example",
    ...overrides,
  };
}

describe("JsonlIndexStore", () => {
  let dir: string;
  let filePath: string;
  let store: JsonlIndexStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "creative-rag-index-"));
    filePath = join(dir, "index.jsonl");
    store = new JsonlIndexStore({ filePath });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("loadAll", () => {
    it("returns empty for a missing file", async () => {
      await expect(store.loadAll()).resolves.toEqual([]);
    });

    it("round-trips upserted cards", async () => {
      const a = makeCard({ id: "a" });
      const b = makeCard({ id: "b" });
      await store.upsert([a, b]);
      const loaded = await store.loadAll();
      expect(loaded).toHaveLength(2);
      expect(loaded.map((c) => c.id).sort()).toEqual(["a", "b"]);
    });

    it("skips blank and malformed lines defensively", async () => {
      const valid = JSON.stringify(makeCard({ id: "a" }));
      writeFileSync(filePath, `${valid}\n\n  \nnot-json\n{"id":"partial"}\n`, "utf8");
      const loaded = await store.loadAll();
      expect(loaded.map((c) => c.id)).toEqual(["a"]);
    });
  });

  describe("upsert", () => {
    it("dedups by id, newest wins (across calls)", async () => {
      await store.upsert([makeCard({ id: "a", title: "old" })]);
      await store.upsert([makeCard({ id: "a", title: "new", contentHash: "h2" })]);
      const loaded = await store.loadAll();
      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.title).toBe("new");
      expect(loaded[0]?.contentHash).toBe("h2");
    });

    it("dedups by id, newest wins (within one call)", async () => {
      await store.upsert([
        makeCard({ id: "a", title: "first" }),
        makeCard({ id: "a", title: "second" }),
      ]);
      const loaded = await store.loadAll();
      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.title).toBe("second");
    });
  });

  describe("search", () => {
    it("returns empty for a missing file", async () => {
      await expect(store.search([1, 0, 0], 5)).resolves.toEqual([]);
    });

    it("ranks by cosine similarity descending", async () => {
      await store.upsert([
        makeCard({ id: "far", embedding: [0, 1, 0] }),
        makeCard({ id: "near", embedding: [1, 0, 0] }),
        makeCard({ id: "mid", embedding: [1, 1, 0] }),
      ]);
      const results = await store.search([1, 0, 0], 3);
      expect(results.map((r) => r.id)).toEqual(["near", "mid", "far"]);
      expect(results[0]?.score).toBeCloseTo(1, 10);
      expect(results[2]?.score).toBe(0);
    });

    it("respects k (slice)", async () => {
      await store.upsert([
        makeCard({ id: "a", embedding: [1, 0, 0] }),
        makeCard({ id: "b", embedding: [1, 1, 0] }),
      ]);
      const results = await store.search([1, 0, 0], 1);
      expect(results).toHaveLength(1);
      expect(results[0]?.id).toBe("a");
    });

    it("filters by license", async () => {
      await store.upsert([
        makeCard({ id: "cc0", license: "CC0" }),
        makeCard({ id: "pd", license: "PublicDomain" }),
      ]);
      const results = await store.search([1, 0, 0], 5, { license: ["CC0"] });
      expect(results.map((r) => r.id)).toEqual(["cc0"]);
    });

    it("filters by type", async () => {
      await store.upsert([
        makeCard({ id: "art", type: "artwork" }),
        makeCard({ id: "tech", type: "technique" }),
      ]);
      const results = await store.search([1, 0, 0], 5, { type: ["technique"] });
      expect(results.map((r) => r.id)).toEqual(["tech"]);
    });

    it("filters by tags (card must have ALL requested)", async () => {
      await store.upsert([
        makeCard({ id: "both", tags: ["kinetic", "monochrome", "extra"] }),
        makeCard({ id: "one", tags: ["kinetic"] }),
        makeCard({ id: "none", tags: [] }),
      ]);
      const results = await store.search([1, 0, 0], 5, { tags: ["kinetic", "monochrome"] });
      expect(results.map((r) => r.id)).toEqual(["both"]);
    });

    it("carries rightsNotes into the result when present", async () => {
      await store.upsert([makeCard({ id: "a", rightsNotes: "CC0 — no rights reserved" })]);
      const results = await store.search([1, 0, 0], 5);
      expect(results[0]?.rightsNotes).toBe("CC0 — no rights reserved");
    });

    it("omits rightsNotes when absent", async () => {
      await store.upsert([makeCard({ id: "a" })]);
      const results = await store.search([1, 0, 0], 5);
      expect(results[0]).not.toHaveProperty("rightsNotes");
    });
  });

  describe("existingFingerprints", () => {
    it("returns empty set for a missing file", async () => {
      const fps = await store.existingFingerprints();
      expect(fps.size).toBe(0);
    });

    it("keys by id:contentHash:embeddingModel", async () => {
      await store.upsert([
        makeCard({ id: "a", contentHash: "h1", embeddingModel: "m1" }),
        makeCard({ id: "b", contentHash: "h2", embeddingModel: "m2" }),
      ]);
      const fps = await store.existingFingerprints();
      expect(fps.has("a:h1:m1")).toBe(true);
      expect(fps.has("b:h2:m2")).toBe(true);
      expect(fps.has("a:h2:m1")).toBe(false);
      expect(fps.size).toBe(2);
    });
  });

  describe("remove", () => {
    it("drops the given ids and keeps the rest", async () => {
      await store.upsert([makeCard({ id: "a" }), makeCard({ id: "b" }), makeCard({ id: "c" })]);
      await store.remove(["b"]);
      const ids = (await store.loadAll()).map((card) => card.id).sort();
      expect(ids).toEqual(["a", "c"]);
    });

    it("is a no-op for an empty id list or a missing file", async () => {
      await expect(store.remove([])).resolves.toBeUndefined();
      await expect(store.remove(["nope"])).resolves.toBeUndefined();
      await store.upsert([makeCard({ id: "a" })]);
      await store.remove([]);
      expect((await store.loadAll()).map((card) => card.id)).toEqual(["a"]);
    });

    it("empties the index when all ids are removed", async () => {
      await store.upsert([makeCard({ id: "a" }), makeCard({ id: "b" })]);
      await store.remove(["a", "b"]);
      await expect(store.loadAll()).resolves.toEqual([]);
    });
  });
});
