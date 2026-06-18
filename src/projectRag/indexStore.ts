/**
 * Project RAG — local JSONL index store.
 *
 * One {@link ProjectEmbeddedCard} per line; cosine top-k in memory. Mirrors the
 * Creative RAG `JsonlIndexStore` shape but indexes `kind:"project"` cards with
 * the additional `operators` / `score` fields and AND-matches them in
 * {@link matchesFilters}. Writes are atomic; reads ignore blank/malformed lines.
 *
 * Final search score is `cosineSim * (composite ?? 1)`. When a card has no
 * `score`, ranking collapses to plain cosine — keeps F0 usable before scoring
 * lands in F1.
 */

import { readFileSync } from "node:fs";
import { cosineSimilarity } from "../creativeRag/cosine.js";
import { atomicWriteFileSync } from "../utils/atomicWrite.js";
import type {
  ProjectEmbeddedCard,
  ProjectIndexStore,
  ProjectSearchFilters,
  ProjectSearchResult,
} from "./types.js";

export interface ProjectJsonlIndexStoreOptions {
  filePath: string;
}

export class ProjectJsonlIndexStore implements ProjectIndexStore {
  private readonly filePath: string;

  constructor(options: ProjectJsonlIndexStoreOptions) {
    this.filePath = options.filePath;
  }

  async upsert(cards: ProjectEmbeddedCard[]): Promise<void> {
    const byId = new Map<string, ProjectEmbeddedCard>();
    for (const existing of await this.loadAll()) {
      byId.set(existing.id, existing);
    }
    for (const card of cards) {
      byId.set(card.id, card);
    }
    const body = `${Array.from(byId.values())
      .map((card) => JSON.stringify(card))
      .join("\n")}\n`;
    atomicWriteFileSync(this.filePath, body, "utf8");
  }

  async remove(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const drop = new Set(ids);
    const kept = (await this.loadAll()).filter((card) => !drop.has(card.id));
    const body =
      kept.length === 0 ? "" : `${kept.map((card) => JSON.stringify(card)).join("\n")}\n`;
    atomicWriteFileSync(this.filePath, body, "utf8");
  }

  async loadAll(): Promise<ProjectEmbeddedCard[]> {
    const raw = this.readRaw();
    if (raw === undefined) return [];
    const cards: ProjectEmbeddedCard[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed = JSON.parse(trimmed) as ProjectEmbeddedCard;
        // Defensive: skip rows that lost their embedding (would crash cosine).
        if (parsed && Array.isArray(parsed.embedding) && typeof parsed.id === "string") {
          cards.push(parsed);
        }
      } catch {
        // Skip a corrupt/partial line rather than aborting the whole load.
      }
    }
    return cards;
  }

  async search(
    queryEmbedding: number[],
    k: number,
    filters?: ProjectSearchFilters,
  ): Promise<ProjectSearchResult[]> {
    const cards = await this.loadAll();
    if (cards.length === 0) return [];
    const scored = cards
      .filter((card) => matchesFilters(card, filters))
      .map((card) => {
        const cosine = cosineSimilarity(queryEmbedding, card.embedding);
        const composite = card.score?.composite ?? 1;
        return { card, cosine, composite, final: cosine * composite };
      });
    scored.sort((a, b) => b.final - a.final);
    return scored
      .slice(0, Math.max(0, k))
      .map(({ card, cosine, composite, final }) => toSearchResult(card, final, cosine, composite));
  }

  async existingFingerprints(): Promise<Set<string>> {
    const cards = await this.loadAll();
    const set = new Set<string>();
    for (const card of cards) {
      set.add(`${card.id}:${card.contentHash}:${card.embeddingModel}`);
    }
    return set;
  }

  private readRaw(): string | undefined {
    try {
      return readFileSync(this.filePath, "utf8");
    } catch (err) {
      // Only a missing file is an empty index; any other I/O error must propagate.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }
}

function matchesFilters(card: ProjectEmbeddedCard, filters?: ProjectSearchFilters): boolean {
  if (filters === undefined) return true;
  if (filters.license !== undefined && !filters.license.includes(card.license)) return false;
  if (filters.type !== undefined && !filters.type.includes(card.type)) return false;
  if (filters.tags !== undefined && filters.tags.length > 0) {
    const cardTags = new Set(card.tags);
    for (const tag of filters.tags) {
      if (!cardTags.has(tag)) return false;
    }
  }
  if (filters.operators !== undefined && filters.operators.length > 0) {
    const cardOps = new Set(card.operators ?? []);
    for (const op of filters.operators) {
      if (!cardOps.has(op)) return false;
    }
  }
  return true;
}

function toSearchResult(
  card: ProjectEmbeddedCard,
  final: number,
  cosine: number,
  composite: number,
): ProjectSearchResult {
  const result: ProjectSearchResult = {
    id: card.id,
    score: final,
    cosineScore: cosine,
    title: card.title,
    type: card.type,
    license: card.license,
    licenseConfidence: "unknown", // licenseConfidence is on the card md, not in JSONL
    sourceUrl: card.sourceUrl,
    sourceName: card.sourceName,
    tags: card.tags,
  };
  if (card.rightsNotes !== undefined) result.rightsNotes = card.rightsNotes;
  if (card.operators !== undefined) result.operators = card.operators;
  if (card.score !== undefined) result.composite = composite;
  return result;
}
