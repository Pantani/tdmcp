import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  computeContentHash,
  computeId,
  parseCard,
  serializeCard,
} from "../../../src/creativeRag/cardParser.js";
import { SAMPLE_CARDS } from "../../../src/creativeRag/fixtures.js";
import type { CreativeRagCard } from "../../../src/creativeRag/types.js";

describe("computeId", () => {
  it("is the stable sha256 hex of the sourceUrl", () => {
    const url = "https://www.artic.edu/artworks/129884";
    const expected = createHash("sha256").update(url, "utf8").digest("hex");
    expect(computeId(url)).toBe(expected);
    expect(computeId(url)).toBe(computeId(url));
  });

  it("differs for different urls", () => {
    expect(computeId("https://a")).not.toBe(computeId("https://b"));
  });
});

describe("computeContentHash", () => {
  const base = SAMPLE_CARDS[0] as CreativeRagCard;

  it("ignores embedding and embeddingModel", () => {
    const withEmbedding: CreativeRagCard = {
      ...base,
      embedding: [0.1, 0.2, 0.3],
      embeddingModel: "nomic-embed-text",
    };
    expect(computeContentHash(withEmbedding)).toBe(computeContentHash(base));
  });

  it("ignores the contentHash field itself", () => {
    const tampered: CreativeRagCard = { ...base, contentHash: "different" };
    expect(computeContentHash(tampered)).toBe(computeContentHash(base));
  });

  it("changes when meaningful text changes", () => {
    const edited: CreativeRagCard = { ...base, title: `${base.title} (revised)` };
    expect(computeContentHash(edited)).not.toBe(computeContentHash(base));
  });
});

describe("serializeCard / parseCard round-trip", () => {
  it("is identity for every sample card (without the embedding fields)", () => {
    for (const card of SAMPLE_CARDS) {
      const { embedding: _embedding, embeddingModel: _embeddingModel, ...persisted } = card;
      const parsed = parseCard(serializeCard(card));
      expect(parsed).toEqual(persisted);
    }
  });

  it("does not write the embedding into the card file", () => {
    const card: CreativeRagCard = {
      ...(SAMPLE_CARDS[0] as CreativeRagCard),
      embedding: [0.5, 0.6],
      embeddingModel: "nomic-embed-text",
    };
    const text = serializeCard(card);
    expect(text).not.toContain("embedding");
    expect(text).not.toContain("0.5");
  });

  it("round-trips a card with no body", () => {
    const { body: _body, ...noBody } = SAMPLE_CARDS[1] as CreativeRagCard;
    const card = noBody as CreativeRagCard;
    expect(parseCard(serializeCard(card))).toEqual(card);
  });

  it("throws on markdown missing a frontmatter block", () => {
    expect(() => parseCard("no frontmatter here")).toThrow();
  });

  it("throws on an unterminated frontmatter block", () => {
    expect(() => parseCard("---\ntitle: x\n")).toThrow();
  });
});
