/**
 * Creative RAG — LanceDB-backed index store.
 *
 * A scale-path alternative to {@link JsonlIndexStore}: instead of loading the
 * whole JSONL into memory, embeddings live in a LanceDB table and the ANN index
 * narrows the candidate set before scoring. The public contract ({@link IndexStore})
 * is identical, so the integrator's backend factory can swap stores transparently.
 *
 * The `@lancedb/lancedb` package is an *optional peer* dependency — it is NOT in
 * `dependencies` and is not auto-installed, so a default install never pulls it.
 * {@link loadLanceModule} dynamically imports it and turns a missing-module
 * failure into a friendly, typed error pointing at the jsonl fallback.
 *
 * SCORE CONTRACT: {@link IndexStore.search} must return `score` as cosine 0..1.
 * LanceDB's `vectorSearch` ranks by L2 `_distance`, not cosine — so we use the
 * ANN only to fetch a generous candidate window, then recompute cosine with
 * {@link cosineSimilarity} and sort/slice ourselves. This makes both the score
 * values and the ordering byte-for-byte comparable with {@link JsonlIndexStore}.
 *
 * TESTING SEAM: the lance module is injectable. `LanceIndexStoreOptions.moduleLoader`
 * defaults to {@link loadLanceModule}; tests pass an in-memory fake so CI never
 * touches (or requires) the real optional dependency. The integrator's factory
 * MUST leave this seam intact (default = real loader, override = inject).
 */

import { cosineSimilarity } from "./cosine.js";
import type {
  CreativeRagLicense,
  CreativeRagType,
  EmbeddedCard,
  IndexStore,
  SearchFilters,
  SearchResult,
} from "./types.js";

/** Over-fetch factor: pull this many × k candidates from the ANN before re-scoring. */
const CANDIDATE_OVERFETCH = 4;
/** Floor on candidates fetched, so small k still surfaces enough to re-rank. */
const MIN_CANDIDATES = 64;

export interface LanceIndexStoreOptions {
  dir: string;
  tableName?: string;
  /**
   * Lance module provider — defaults to {@link loadLanceModule}. Tests inject an
   * in-memory fake here so the real optional dep is never required. The
   * integrator's factory must preserve this default-vs-override seam.
   */
  moduleLoader?: () => Promise<unknown>;
}

/** One LanceDB table row. `tags` is a JSON-encoded string (Lance has no list-of-string column here). */
interface LanceRow {
  id: string;
  vector: number[];
  contentHash: string;
  embeddingModel: string;
  title: string;
  type: string;
  license: string;
  tags: string;
  sourceUrl: string;
  sourceName: string;
  rightsNotes: string;
}

/** Minimal structural views of the `@lancedb/lancedb` surface we depend on. */
interface LanceQuery {
  toArray(): Promise<Record<string, unknown>[]>;
}
interface LanceVectorQuery {
  limit(k: number): LanceVectorQuery;
  toArray(): Promise<Record<string, unknown>[]>;
}
interface LanceTable {
  add(rows: LanceRow[]): Promise<void>;
  delete(predicate: string): Promise<void>;
  query(): LanceQuery;
  vectorSearch(vector: number[]): LanceVectorQuery;
}
interface LanceConnection {
  tableNames(): Promise<string[]>;
  createTable(name: string, rows: LanceRow[]): Promise<LanceTable>;
  openTable(name: string): Promise<LanceTable>;
}
interface LanceModule {
  connect(dir: string): Promise<LanceConnection>;
}

/**
 * Lazy-load `@lancedb/lancedb`. The dep is an optional peer that the default
 * install never pulls, so the import normally fails when the backend is selected
 * without it installed. Any module-resolution failure — Node's
 * `ERR_MODULE_NOT_FOUND`/`MODULE_NOT_FOUND` or a bundler's "Could not resolve …
 * Is it installed?" — is turned into one clear, actionable error so the factory
 * can fall back to JSONL. Exported so tests can stub it.
 */
export async function loadLanceModule(): Promise<unknown> {
  try {
    // @ts-expect-error optional peer dependency — intentionally absent from the
    // default install tree (declared only as an optional peerDependency), so there
    // are no type declarations to resolve. Resolved at runtime when installed.
    return await import("@lancedb/lancedb");
  } catch (err) {
    if (isModuleNotFound(err)) {
      throw new Error(
        "LanceDB backend requires the optional dependency '@lancedb/lancedb'. " +
          "Install it or use TDMCP_RAG_BACKEND=jsonl.",
      );
    }
    throw err;
  }
}

/** True when an import error means the optional dep is simply not installed. */
function isModuleNotFound(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
    return true;
  }
  // Bundlers (Vite/esbuild, used under Vitest) throw a plain Error with no `code`.
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("@lancedb/lancedb") &&
    (/cannot find|could not resolve|is it installed/i.test(message) ||
      message.includes("Failed to load"))
  );
}

const DEFAULT_TABLE_NAME = "creative_rag";

export class LanceIndexStore implements IndexStore {
  private readonly dir: string;
  private readonly tableName: string;
  private readonly moduleLoader: () => Promise<unknown>;
  private connectionPromise: Promise<LanceConnection> | undefined;

  constructor(options: LanceIndexStoreOptions) {
    this.dir = options.dir;
    this.tableName = options.tableName ?? DEFAULT_TABLE_NAME;
    this.moduleLoader = options.moduleLoader ?? loadLanceModule;
  }

  async upsert(cards: EmbeddedCard[]): Promise<void> {
    if (cards.length === 0) {
      return;
    }
    // Dedup within this call (newest wins), then delete-then-add per id so a
    // re-embed of an existing card replaces its row (Lance has no native upsert).
    const byId = new Map<string, EmbeddedCard>();
    for (const card of cards) {
      byId.set(card.id, card);
    }
    const rows = Array.from(byId.values()).map(cardToRow);
    const db = await this.connection();
    const names = await db.tableNames();
    if (!names.includes(this.tableName)) {
      // First write creates the table FROM real rows so Lance can infer the schema
      // (incl. the vector dimension). Creating with `[]` cannot infer columns and
      // makes a fresh lancedb data dir unusable — so the table is born here, on the
      // first upsert, never on a read.
      await db.createTable(this.tableName, rows);
      return;
    }
    const table = await db.openTable(this.tableName);
    for (const id of byId.keys()) {
      await table.delete(idPredicate(id));
    }
    await table.add(rows);
  }

  async remove(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const table = await this.openExisting();
    if (table === undefined) {
      return;
    }
    for (const id of ids) {
      await table.delete(idPredicate(id));
    }
  }

  async loadAll(): Promise<EmbeddedCard[]> {
    const table = await this.openExisting();
    if (table === undefined) {
      return [];
    }
    const rows = await table.query().toArray();
    return rows.map(rowToCard).filter((card): card is EmbeddedCard => card !== undefined);
  }

  async search(
    queryEmbedding: number[],
    k: number,
    filters?: SearchFilters,
  ): Promise<SearchResult[]> {
    const limit = Math.max(0, k);
    if (limit === 0) {
      return [];
    }
    const table = await this.openExisting();
    if (table === undefined) {
      return [];
    }
    // Grow the ANN window until we hold >= k rows that PASS the filters, or the
    // table is exhausted. With filters that few candidates match, the nearest
    // `candidateCount` rows can be all non-matching while matches sit deeper —
    // expanding (instead of a single fixed window) keeps parity with JsonlIndexStore,
    // which scans every card. No filters ⇒ the first window already satisfies it.
    let windowSize = Math.max(MIN_CANDIDATES, limit * CANDIDATE_OVERFETCH);
    let cards: EmbeddedCard[] = [];
    for (;;) {
      const rows = await table.vectorSearch(queryEmbedding).limit(windowSize).toArray();
      cards = rows
        .map(rowToCard)
        .filter((card): card is EmbeddedCard => card !== undefined)
        .filter((card) => matchesFilters(card, filters));
      // Enough matches, or the ANN returned fewer rows than asked ⇒ table exhausted.
      if (cards.length >= limit || rows.length < windowSize) {
        break;
      }
      windowSize *= CANDIDATE_OVERFETCH;
    }
    // Re-score with cosine (ANN ranks by L2 distance) for parity with JsonlIndexStore.
    const scored = cards.map((card) => ({
      card,
      score: cosineSimilarity(queryEmbedding, card.embedding),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(({ card, score }) => toSearchResult(card, score));
  }

  async existingFingerprints(): Promise<Set<string>> {
    const cards = await this.loadAll();
    const set = new Set<string>();
    for (const card of cards) {
      set.add(`${card.id}:${card.contentHash}:${card.embeddingModel}`);
    }
    return set;
  }

  /** Cached LanceDB connection (lazily loads the optional module on first use). */
  private connection(): Promise<LanceConnection> {
    if (this.connectionPromise === undefined) {
      this.connectionPromise = this.connect();
    }
    return this.connectionPromise;
  }

  private async connect(): Promise<LanceConnection> {
    const mod = (await this.moduleLoader()) as LanceModule;
    return mod.connect(this.dir);
  }

  /**
   * Open the table, or `undefined` if it does not exist yet. Reads NEVER create a
   * table (an empty `createTable` cannot infer the schema) — the table is created
   * lazily by the first {@link upsert}. Still loads the module, so a missing
   * optional dep surfaces here for the factory to catch and fall back to JSONL.
   */
  private async openExisting(): Promise<LanceTable | undefined> {
    const db = await this.connection();
    const names = await db.tableNames();
    return names.includes(this.tableName) ? db.openTable(this.tableName) : undefined;
  }
}

/** Single-quote-escaped equality predicate for a row id. */
function idPredicate(id: string): string {
  return `id = '${id.replace(/'/g, "''")}'`;
}

function cardToRow(card: EmbeddedCard): LanceRow {
  return {
    id: card.id,
    vector: card.embedding,
    contentHash: card.contentHash,
    embeddingModel: card.embeddingModel,
    title: card.title,
    type: card.type,
    license: card.license,
    tags: JSON.stringify(card.tags),
    sourceUrl: card.sourceUrl,
    sourceName: card.sourceName,
    rightsNotes: card.rightsNotes ?? "",
  };
}

/** Map a Lance row back to an EmbeddedCard; returns undefined for a malformed row. */
function rowToCard(row: Record<string, unknown>): EmbeddedCard | undefined {
  const embedding = toNumberArray(row.vector);
  if (
    typeof row.id !== "string" ||
    typeof row.contentHash !== "string" ||
    typeof row.embeddingModel !== "string" ||
    typeof row.title !== "string" ||
    typeof row.type !== "string" ||
    typeof row.license !== "string" ||
    typeof row.sourceUrl !== "string" ||
    typeof row.sourceName !== "string" ||
    embedding === undefined
  ) {
    return undefined;
  }
  const card: EmbeddedCard = {
    id: row.id,
    contentHash: row.contentHash,
    embeddingModel: row.embeddingModel,
    embedding,
    title: row.title,
    type: row.type as CreativeRagType,
    license: row.license as CreativeRagLicense,
    tags: parseTags(row.tags),
    sourceUrl: row.sourceUrl,
    sourceName: row.sourceName,
  };
  const rightsNotes = row.rightsNotes;
  if (typeof rightsNotes === "string" && rightsNotes.length > 0) {
    card.rightsNotes = rightsNotes;
  }
  return card;
}

/** Coerce a Lance vector cell (array or TypedArray-like) to number[]; undefined if empty/invalid. */
function toNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) {
    // Lance may return a Float32Array-like; accept any iterable of finite numbers.
    if (value !== null && typeof value === "object" && Symbol.iterator in (value as object)) {
      const arr = Array.from(value as Iterable<unknown>);
      return toNumberArray(arr);
    }
    return undefined;
  }
  if (value.length === 0 || !value.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return undefined;
  }
  return value as number[];
}

/** Parse the JSON-encoded `tags` cell back to string[]; tolerant of bad data. */
function parseTags(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every((t) => typeof t === "string")) {
      return parsed;
    }
  } catch {
    // Fall through to empty.
  }
  return [];
}

/** Ported from JsonlIndexStore: license / type / tags-ALL filtering. */
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
