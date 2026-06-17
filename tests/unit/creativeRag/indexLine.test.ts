import { describe, expect, it } from "vitest";
import {
  INDEX_LINE_VERSION,
  isEmbeddedCard,
  parseIndexLine,
  serializeIndexLine,
} from "../../../src/creativeRag/indexLine.js";
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

describe("indexLine", () => {
  describe("serializeIndexLine", () => {
    it("tags the line with the current indexVersion on the wrapper", () => {
      const card = makeCard({ id: "a" });
      const parsed = JSON.parse(serializeIndexLine(card));
      expect(parsed.indexVersion).toBe(INDEX_LINE_VERSION);
      // The card fields live alongside the wrapper, unchanged.
      expect(parsed.id).toBe("a");
    });
  });

  describe("parseIndexLine", () => {
    it("round-trips: serialize→parse equals the input card minus the wrapper", () => {
      const card = makeCard({ id: "a", rightsNotes: "CC0 — no rights reserved" });
      const parsed = parseIndexLine(serializeIndexLine(card));
      expect(parsed).toEqual(card);
      // The version tag must not leak onto the returned EmbeddedCard.
      expect(parsed).not.toHaveProperty("indexVersion");
    });

    it("migrates a legacy line (no indexVersion) to the current card, never dropping it", () => {
      const card = makeCard({ id: "legacy" });
      const legacyLine = JSON.stringify(card);
      expect(legacyLine).not.toContain("indexVersion");
      expect(parseIndexLine(legacyLine)).toEqual(card);
    });

    it("skips a future indexVersion line (returns undefined, does not crash)", () => {
      const card = makeCard({ id: "future" });
      const futureLine = JSON.stringify({ indexVersion: 999, ...card });
      expect(parseIndexLine(futureLine)).toBeUndefined();
    });

    it("returns undefined for malformed JSON", () => {
      expect(parseIndexLine("not-json")).toBeUndefined();
      expect(parseIndexLine('{"id":"partial"')).toBeUndefined();
    });

    it("returns undefined when the shape guard fails (empty embedding)", () => {
      const bad = makeCard({ id: "a", embedding: [] });
      expect(parseIndexLine(serializeIndexLine(bad))).toBeUndefined();
      // Same guard holds for a legacy line.
      expect(parseIndexLine(JSON.stringify(bad))).toBeUndefined();
    });

    it("returns undefined for a JSON primitive or null line", () => {
      expect(parseIndexLine("42")).toBeUndefined();
      expect(parseIndexLine("null")).toBeUndefined();
    });
  });

  describe("isEmbeddedCard", () => {
    it("accepts a well-formed card and rejects a partial one", () => {
      expect(isEmbeddedCard(makeCard({ id: "a" }))).toBe(true);
      expect(isEmbeddedCard({ id: "partial" })).toBe(false);
    });

    it("rejects a card whose optional rightsNotes is the wrong type", () => {
      expect(isEmbeddedCard({ ...makeCard({ id: "a" }), rightsNotes: 42 })).toBe(false);
      expect(isEmbeddedCard({ ...makeCard({ id: "a" }), rightsNotes: "CC0" })).toBe(true);
    });
  });
});
