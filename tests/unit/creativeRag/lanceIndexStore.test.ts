/**
 * LanceIndexStore — fully offline. The real `@lancedb/lancedb` optional dep is
 * NEVER required: every test injects an in-memory fake via the `moduleLoader`
 * seam. The only test that touches the real loader asserts it *rejects* with the
 * friendly typed error (the dep is absent in CI), so we never import it for real.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cosineSimilarity } from "../../../src/creativeRag/cosine.js";
import { JsonlIndexStore } from "../../../src/creativeRag/indexStore.js";
import { LanceIndexStore, loadLanceModule } from "../../../src/creativeRag/lanceIndexStore.js";
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

type LanceRow = Record<string, unknown> & { id: string; vector: number[] };

/**
 * In-memory fake of the slice of `@lancedb/lancedb` LanceIndexStore uses.
 * `vectorSearch().limit().toArray()` returns rows with a fabricated `_distance`
 * (so we prove the store ignores it and re-scores with cosine), in an order that
 * is intentionally NOT the cosine order, to catch any reliance on ANN ranking.
 */
function createFakeModule() {
  const tables = new Map<string, LanceRow[]>();

  function makeTable(name: string) {
    const rows = tables.get(name) as LanceRow[];
    return {
      async add(newRows: LanceRow[]): Promise<void> {
        rows.push(...newRows.map((r) => ({ ...r })));
      },
      async delete(predicate: string): Promise<void> {
        // predicate form: id = 'value'  (single-quotes escaped as '')
        const match = /^id = '(.*)'$/.exec(predicate);
        const id = match?.[1]?.replace(/''/g, "'");
        if (id === undefined) {
          return;
        }
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i]?.id === id) {
            rows.splice(i, 1);
          }
        }
      },
      query() {
        return {
          async toArray(): Promise<Record<string, unknown>[]> {
            return rows.map((r) => ({ ...r }));
          },
        };
      },
      vectorSearch(_vector: number[]) {
        let limit = rows.length;
        const api = {
          limit(k: number) {
            limit = k;
            return api;
          },
          async toArray(): Promise<Record<string, unknown>[]> {
            // Reverse insertion order + fabricated _distance to defeat any ANN-order reliance.
            return rows
              .slice()
              .reverse()
              .slice(0, limit)
              .map((r, i) => ({ ...r, _distance: i * 0.123 }));
          },
        };
        return api;
      },
    };
  }

  const module = {
    async connect(_dir: string) {
      return {
        async tableNames(): Promise<string[]> {
          return Array.from(tables.keys());
        },
        async createTable(name: string, initRows: LanceRow[]) {
          tables.set(
            name,
            initRows.map((r) => ({ ...r })),
          );
          return makeTable(name);
        },
        async openTable(name: string) {
          if (!tables.has(name)) {
            tables.set(name, []);
          }
          return makeTable(name);
        },
      };
    },
  };
  return { module, tables };
}

function newStore() {
  const { module } = createFakeModule();
  return new LanceIndexStore({ dir: "/tmp/lance-test", moduleLoader: async () => module });
}

describe("LanceIndexStore", () => {
  describe("upsert + loadAll", () => {
    it("round-trips cards (tags survive JSON round-trip)", async () => {
      const store = newStore();
      await store.upsert([makeCard({ id: "a", tags: ["kinetic", "mono"] }), makeCard({ id: "b" })]);
      const loaded = await store.loadAll();
      expect(loaded.map((c) => c.id).sort()).toEqual(["a", "b"]);
      const a = loaded.find((c) => c.id === "a");
      expect(a?.tags).toEqual(["kinetic", "mono"]);
    });

    it("dedups by id, newest wins (within one call)", async () => {
      const store = newStore();
      await store.upsert([
        makeCard({ id: "a", title: "first" }),
        makeCard({ id: "a", title: "second", contentHash: "h2" }),
      ]);
      const loaded = await store.loadAll();
      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.title).toBe("second");
      expect(loaded[0]?.contentHash).toBe("h2");
    });

    it("dedups by id, newest wins (across calls)", async () => {
      const store = newStore();
      await store.upsert([makeCard({ id: "a", title: "old" })]);
      await store.upsert([makeCard({ id: "a", title: "new", contentHash: "h2" })]);
      const loaded = await store.loadAll();
      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.title).toBe("new");
    });

    it("preserves rightsNotes presence/absence", async () => {
      const store = newStore();
      await store.upsert([
        makeCard({ id: "with", rightsNotes: "CC0 — no rights reserved" }),
        makeCard({ id: "without" }),
      ]);
      const loaded = await store.loadAll();
      expect(loaded.find((c) => c.id === "with")?.rightsNotes).toBe("CC0 — no rights reserved");
      expect(loaded.find((c) => c.id === "without")).not.toHaveProperty("rightsNotes");
    });
  });

  describe("search — parity with JsonlIndexStore", () => {
    let dir: string;
    let jsonl: JsonlIndexStore;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "lance-parity-"));
      jsonl = new JsonlIndexStore({ filePath: join(dir, "index.jsonl") });
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("returns cosine-scored results in the SAME order as JsonlIndexStore", async () => {
      const cards = [
        makeCard({ id: "far", embedding: [0, 1, 0] }),
        makeCard({ id: "near", embedding: [1, 0, 0] }),
        makeCard({ id: "mid", embedding: [1, 1, 0] }),
      ];
      const lance = newStore();
      await lance.upsert(cards);
      await jsonl.upsert(cards);

      const query = [1, 0, 0];
      const lanceResults = await lance.search(query, 3);
      const jsonlResults = await jsonl.search(query, 3);

      expect(lanceResults.map((r) => r.id)).toEqual(["near", "mid", "far"]);
      expect(lanceResults.map((r) => r.id)).toEqual(jsonlResults.map((r) => r.id));
      lanceResults.forEach((r, i) => {
        expect(r.score).toBeCloseTo(jsonlResults[i]?.score ?? Number.NaN, 12);
      });
      // Scores are cosine 0..1, NOT the fabricated _distance from the fake ANN.
      expect(lanceResults[0]?.score).toBeCloseTo(cosineSimilarity(query, [1, 0, 0]), 12);
      expect(lanceResults[2]?.score).toBe(0);
    });

    it("respects k (slice)", async () => {
      const store = newStore();
      await store.upsert([
        makeCard({ id: "a", embedding: [1, 0, 0] }),
        makeCard({ id: "b", embedding: [1, 1, 0] }),
      ]);
      const results = await store.search([1, 0, 0], 1);
      expect(results).toHaveLength(1);
      expect(results[0]?.id).toBe("a");
    });

    it("k <= 0 returns empty", async () => {
      const store = newStore();
      await store.upsert([makeCard({ id: "a" })]);
      await expect(store.search([1, 0, 0], 0)).resolves.toEqual([]);
    });

    it("filters by license", async () => {
      const store = newStore();
      await store.upsert([
        makeCard({ id: "cc0", license: "CC0" }),
        makeCard({ id: "pd", license: "PublicDomain" }),
      ]);
      const results = await store.search([1, 0, 0], 5, { license: ["CC0"] });
      expect(results.map((r) => r.id)).toEqual(["cc0"]);
    });

    it("filters by type", async () => {
      const store = newStore();
      await store.upsert([
        makeCard({ id: "art", type: "artwork" }),
        makeCard({ id: "tech", type: "technique" }),
      ]);
      const results = await store.search([1, 0, 0], 5, { type: ["technique"] });
      expect(results.map((r) => r.id)).toEqual(["tech"]);
    });

    it("filters by tags (card must have ALL requested)", async () => {
      const store = newStore();
      await store.upsert([
        makeCard({ id: "both", tags: ["kinetic", "monochrome", "extra"] }),
        makeCard({ id: "one", tags: ["kinetic"] }),
        makeCard({ id: "none", tags: [] }),
      ]);
      const results = await store.search([1, 0, 0], 5, { tags: ["kinetic", "monochrome"] });
      expect(results.map((r) => r.id)).toEqual(["both"]);
    });

    it("carries / omits rightsNotes in results", async () => {
      const store = newStore();
      await store.upsert([
        makeCard({ id: "with", rightsNotes: "CC0" }),
        makeCard({ id: "without" }),
      ]);
      const results = await store.search([1, 0, 0], 5);
      expect(results.find((r) => r.id === "with")?.rightsNotes).toBe("CC0");
      expect(results.find((r) => r.id === "without")).not.toHaveProperty("rightsNotes");
    });
  });

  describe("remove", () => {
    it("drops the given ids and keeps the rest", async () => {
      const store = newStore();
      await store.upsert([makeCard({ id: "a" }), makeCard({ id: "b" }), makeCard({ id: "c" })]);
      await store.remove(["b"]);
      const ids = (await store.loadAll()).map((c) => c.id).sort();
      expect(ids).toEqual(["a", "c"]);
    });

    it("is a no-op for an empty id list", async () => {
      const store = newStore();
      await store.upsert([makeCard({ id: "a" })]);
      await expect(store.remove([])).resolves.toBeUndefined();
      expect((await store.loadAll()).map((c) => c.id)).toEqual(["a"]);
    });
  });

  describe("existingFingerprints", () => {
    it("keys by id:contentHash:embeddingModel", async () => {
      const store = newStore();
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

  describe("loadLanceModule (real, optional dep absent)", () => {
    it("rejects with the friendly typed error when the dep is not installed", async () => {
      await expect(loadLanceModule()).rejects.toThrow(
        "LanceDB backend requires the optional dependency '@lancedb/lancedb'. " +
          "Install it or use TDMCP_RAG_BACKEND=jsonl.",
      );
    });
  });
});
