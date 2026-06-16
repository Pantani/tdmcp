/**
 * Creative RAG — local JSONL index store.
 *
 * Persists one {@link EmbeddedCard} per line in a single JSONL file and serves
 * cosine top-k search entirely in memory. No network, no bridge, no Ollama — the
 * embeddings are computed elsewhere (Builder B) and only stored/searched here.
 *
 * Writes are atomic (tmp file + rename, via {@link atomicWriteFileSync}) so a
 * crashed `upsert` never leaves a half-written index. Reads are defensive: a
 * missing file is an empty index, and blank/malformed lines are skipped rather
 * than throwing.
 */

import { readFileSync } from "node:fs";
import { atomicWriteFileSync } from "../utils/atomicWrite.js";
import { cosineSimilarity } from "./cosine.js";
import type { EmbeddedCard, IndexStore, SearchFilters, SearchResult } from "./types.js";

export interface JsonlIndexStoreOptions {
  filePath: string;
}

export class JsonlIndexStore implements IndexStore {
  private readonly filePath: string;

  constructor(options: JsonlIndexStoreOptions) {
    this.filePath = options.filePath;
  }

  async upsert(cards: EmbeddedCard[]): Promise<void> {
    const byId = new Map<string, EmbeddedCard>();
    for (const existing of await this.loadAll()) {
      byId.set(existing.id, existing);
    }
    // Newest wins: later entries in `cards` override earlier ones and any prior line.
    for (const card of cards) {
      byId.set(card.id, card);
    }
    const body = `${Array.from(byId.values())
      .map((card) => JSON.stringify(card))
      .join("\n")}\n`;
    atomicWriteFileSync(this.filePath, body, "utf8");
  }

  async loadAll(): Promise<EmbeddedCard[]> {
    const raw = this.readRaw();
    if (raw === undefined) {
      return [];
    }
    const cards: EmbeddedCard[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      const card = parseLine(trimmed);
      if (card !== undefined) {
        cards.push(card);
      }
    }
    return cards;
  }

  async search(
    queryEmbedding: number[],
    k: number,
    filters?: SearchFilters,
  ): Promise<SearchResult[]> {
    const cards = await this.loadAll();
    if (cards.length === 0) {
      return [];
    }
    const scored = cards
      .filter((card) => matchesFilters(card, filters))
      .map((card) => ({ card, score: cosineSimilarity(queryEmbedding, card.embedding) }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(0, k)).map(({ card, score }) => toSearchResult(card, score));
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
    } catch {
      // Missing file (or unreadable) ⇒ empty index.
      return undefined;
    }
  }
}

function parseLine(line: string): EmbeddedCard | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isEmbeddedCard(parsed)) {
      return undefined;
    }
    return parsed;
  } catch {
    // Malformed JSON line — skip defensively.
    return undefined;
  }
}

function isEmbeddedCard(value: unknown): value is EmbeddedCard {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const card = value as Record<string, unknown>;
  return (
    typeof card.id === "string" &&
    typeof card.contentHash === "string" &&
    typeof card.embeddingModel === "string" &&
    Array.isArray(card.embedding) &&
    typeof card.title === "string"
  );
}

function matchesFilters(card: EmbeddedCard, filters?: SearchFilters): boolean {
  if (filters === undefined) {
    return true;
  }
  if (filters.license !== undefined && !filters.license.includes(card.license)) {
    return false;
  }
  if (filters.type !== undefined && !filters.type.includes(card.type)) {
    return false;
  }
  if (filters.tags !== undefined && filters.tags.length > 0) {
    const cardTags = new Set(card.tags);
    for (const tag of filters.tags) {
      if (!cardTags.has(tag)) {
        return false;
      }
    }
  }
  return true;
}

function toSearchResult(card: EmbeddedCard, score: number): SearchResult {
  const result: SearchResult = {
    id: card.id,
    score,
    title: card.title,
    type: card.type,
    license: card.license,
    sourceUrl: card.sourceUrl,
    sourceName: card.sourceName,
    tags: card.tags,
  };
  if (card.rightsNotes !== undefined) {
    result.rightsNotes = card.rightsNotes;
  }
  return result;
}
