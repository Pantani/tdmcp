/**
 * Project RAG — scoring ground-truth (F2).
 *
 * Builds a tiny in-memory project index from the curated mock cards in
 * `_workspace/campaign_project_rag/scoring_ground_truth.json`, embeds each card
 * + query into a deterministic token-bag vector, and asserts the tuned scoring
 * (curated boost + copyleft penalty + composite weights) yields >=7/10 hits at
 * top-1.
 *
 * Why this test exists: F1 shipped a "basic" composite that produced
 * unpredictable rankings when permissive and copyleft cards matched the same
 * tokens. F2 introduces a copyleft tie-breaker penalty and a curated-source
 * reliability bump; this test is the regression boundary for both.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeProjectContentHash } from "../../../src/projectRag/cardParser.js";
import { ProjectJsonlIndexStore } from "../../../src/projectRag/indexStore.js";
import { computeProjectScore } from "../../../src/projectRag/scoring.js";
import type {
  ProjectEmbeddedCard,
  ProjectRagCard,
  ProjectRagLicense,
} from "../../../src/projectRag/types.js";

interface GroundTruth {
  weights: { technical: number; license: number; freshness: number; reliability: number };
  tokens: string[];
  cards: Array<{
    id: string;
    title: string;
    sourceName: string;
    license: ProjectRagLicense;
    tags: string[];
    body: string;
  }>;
  queries: Array<{ q: string; expectTop1: string }>;
}

const GT_PATH = join(process.cwd(), "_workspace/campaign_project_rag/scoring_ground_truth.json");
const GT = JSON.parse(readFileSync(GT_PATH, "utf8")) as GroundTruth;

/** Token-bag normalized vector keyed by GT.tokens order. */
function embed(text: string): number[] {
  const lower = text.toLowerCase();
  const vec: number[] = GT.tokens.map((t) => (lower.includes(t) ? 1 : 0));
  const sumSq = vec.reduce((a, b) => a + b * b, 0);
  if (sumSq === 0 && vec.length > 0) {
    // Avoid undefined cosine — bias to a single inert axis.
    vec[vec.length - 1] = 1;
  }
  const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0));
  return vec.map((v) => v / norm);
}

function makeCard(spec: GroundTruth["cards"][number]): ProjectRagCard {
  const card: ProjectRagCard = {
    schemaVersion: 2,
    id: spec.id,
    kind: "project",
    type: "component",
    title: spec.title,
    tags: spec.tags,
    contentHash: "",
    body: spec.body,
    provenance: {
      sourceName: spec.sourceName,
      sourceUrl: `https://example.test/${spec.id}`,
      canonical: spec.sourceName,
      fetchedAt: new Date().toISOString(),
    },
    license: spec.license,
    licenseConfidence: "spdx-detected",
  };
  card.score = computeProjectScore(card, GT.weights);
  card.contentHash = computeProjectContentHash(card);
  return card;
}

function makeEmbedded(card: ProjectRagCard): ProjectEmbeddedCard {
  const text = [card.title, card.tags.join(" "), card.body ?? ""].join("\n");
  const embedded: ProjectEmbeddedCard = {
    id: card.id,
    contentHash: card.contentHash,
    embeddingModel: "test-bag",
    embedding: embed(text),
    title: card.title,
    kind: "project",
    type: card.type,
    license: card.license,
    tags: card.tags,
    sourceUrl: card.provenance.sourceUrl,
    sourceName: card.provenance.sourceName,
  };
  if (card.score !== undefined) embedded.score = card.score;
  return embedded;
}

describe("Project RAG scoring — ground truth (F2)", () => {
  it("achieves >=7/10 top-1 hit rate against the curated ground truth", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prag-gt-"));
    try {
      const indexPath = join(dir, "index.jsonl");
      writeFileSync(indexPath, "", "utf8");
      const store = new ProjectJsonlIndexStore({ filePath: indexPath });
      const cards = GT.cards.map(makeCard);
      const embeddeds = cards.map(makeEmbedded);
      await store.upsert(embeddeds);
      let hits = 0;
      const misses: Array<{ q: string; expected: string; got: string }> = [];
      for (const { q, expectTop1 } of GT.queries) {
        const queryVec = embed(q);
        const results = await store.search(queryVec, 3);
        const top = results[0];
        if (top?.id === expectTop1) {
          hits += 1;
        } else {
          misses.push({ q, expected: expectTop1, got: top?.id ?? "<none>" });
        }
      }
      // Report misses on failure for fast triage.
      if (hits < 7) {
        throw new Error(
          `Hit-rate ${hits}/${GT.queries.length} < target 7/10. Misses: ${JSON.stringify(misses)}`,
        );
      }
      expect(hits).toBeGreaterThanOrEqual(7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("copyleft penalty: MIT mediapipe ranks above the GPL mediapipe fork", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prag-gt-copyleft-"));
    try {
      const indexPath = join(dir, "index.jsonl");
      writeFileSync(indexPath, "", "utf8");
      const store = new ProjectJsonlIndexStore({ filePath: indexPath });
      const mit = GT.cards.find((c) => c.id === "card_mediapipe_mit");
      const gpl = GT.cards.find((c) => c.id === "card_mediapipe_gpl");
      if (mit === undefined || gpl === undefined) throw new Error("ground-truth shape changed");
      await store.upsert([makeEmbedded(makeCard(mit)), makeEmbedded(makeCard(gpl))]);
      const results = await store.search(embed("mediapipe hand"), 5);
      expect(results[0]?.id).toBe("card_mediapipe_mit");
      // GPL still appears (penalty is a tie-breaker, not a block):
      expect(results.some((r) => r.id === "card_mediapipe_gpl")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
