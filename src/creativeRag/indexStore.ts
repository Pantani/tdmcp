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
import { parseIndexLine, serializeIndexLine } from "./indexLine.js";
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
      .map((card) => serializeIndexLine(card))
      .join("\n")}\n`;
    atomicWriteFileSync(this.filePath, body, "utf8");
  }

  async remove(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const drop = new Set(ids);
    const kept = (await this.loadAll()).filter((card) => !drop.has(card.id));
    const body =
      kept.length === 0 ? "" : `${kept.map((card) => serializeIndexLine(card)).join("\n")}\n`;
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
      const card = parseIndexLine(trimmed);
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
    } catch (err) {
      // Only a missing file is an empty index. Permission/I/O errors must propagate —
      // swallowing them here would let a later upsert overwrite a real index with a
      // partial set and silently lose persisted cards.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw err;
    }
  }
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
