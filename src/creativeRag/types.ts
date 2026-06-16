/**
 * Creative RAG — shared cross-module contracts (single source of truth).
 *
 * This module is the only place these interfaces are defined. Every other
 * `src/creativeRag/**` file imports from `./types.js`; none of them redefine
 * these shapes. Creative RAG is repertoire context only — it never touches the
 * TouchDesigner bridge, DMX, fixtures, or Python exec.
 */

export const CARD_SCHEMA_VERSION = 1 as const;

export type CreativeRagLicense =
  | "CC0"
  | "PublicDomain"
  | "CC-BY"
  | "CC-BY-SA"
  | "Unknown"
  | "Restricted";

export type CreativeRagType = "project" | "artist" | "artwork" | "technique" | "cue_reference";

export interface CreativeRagCard {
  schemaVersion: 1;
  /** sha256(sourceUrl), hex. */
  id: string;
  type: CreativeRagType;
  title: string;
  artist?: string;
  sourceUrl: string;
  sourceName: string;
  license: CreativeRagLicense;
  rightsNotes?: string;
  year?: number;
  medium?: string;
  tools: string[];
  tags: string[];
  visualLanguage?: string;
  motionLanguage?: string;
  interaction?: string;
  materials?: string;
  lighting?: string;
  palette?: string[];
  /** Names of EXISTING layer-1 tools only. */
  tdmcpAffordances: string[];
  /** sha256 of canonical card text (excludes embedding fields). */
  contentHash: string;
  embeddingModel?: string;
  /** Usually stored in the JSONL index, not the card file. */
  embedding?: number[];
  tombstone?: boolean;
  /** Free-text markdown body. */
  body?: string;
}

/** A card that has been embedded — what one JSONL index line deserializes to. */
export interface EmbeddedCard {
  id: string;
  contentHash: string;
  embeddingModel: string;
  embedding: number[];
  title: string;
  type: CreativeRagType;
  license: CreativeRagLicense;
  tags: string[];
  sourceUrl: string;
  sourceName: string;
  rightsNotes?: string;
}

export interface SearchFilters {
  license?: CreativeRagLicense[];
  type?: CreativeRagType[];
  /** Match if the card has ALL of these tags. */
  tags?: string[];
}

export interface SearchResult {
  id: string;
  /** Cosine similarity, 0..1. */
  score: number;
  title: string;
  type: CreativeRagType;
  license: CreativeRagLicense;
  sourceUrl: string;
  sourceName: string;
  tags: string[];
  /** The resource/CLI always surfaces rights. */
  rightsNotes?: string;
}

/** Builder C — index store (JSONL persistence + search). */
export interface IndexStore {
  /** Append/overwrite lines for these cards (dedup by id, newest wins). */
  upsert(cards: EmbeddedCard[]): Promise<void>;
  /** Load all lines into memory. */
  loadAll(): Promise<EmbeddedCard[]>;
  /** Cosine top-k over the in-memory set with filters applied. */
  search(queryEmbedding: number[], k: number, filters?: SearchFilters): Promise<SearchResult[]>;
  /** Which (id, contentHash, embeddingModel) tuples already exist — powers the embed cache. Key = `${id}:${contentHash}:${embeddingModel}`. */
  existingFingerprints(): Promise<Set<string>>;
}

/** Builder B — embeddings client. */
export interface OllamaEmbeddingsClient {
  /** POST /api/embed. Returns one vector per input, in order. Throws typed Ollama errors. */
  embed(inputs: string[], model: string): Promise<number[][]>;
}

/** Builder D — a raw item produced by a source adapter. */
export interface RawSourceItem {
  sourceUrl: string;
  sourceName: string;
  title: string;
  artist?: string;
  year?: number;
  medium?: string;
  type: CreativeRagType;
  tags: string[];
  /** Classified by the source via licensePolicy. */
  license: CreativeRagLicense;
  rightsNotes?: string;
  /** Present only when the license allows storing it; the downloader decides. */
  imageUrl?: string;
  palette?: string[];
  visualLanguage?: string;
}

export interface Source {
  /** CLI --source key, e.g. "artic". */
  readonly name: string;
  /** e.g. "Art Institute of Chicago". */
  readonly displayName: string;
  /** Fetch up to `limit` items using the injected fetch. Never throws on a single bad item — skips it. */
  fetchItems(limit: number, fetchImpl?: typeof fetch): Promise<RawSourceItem[]>;
}

export interface PlannedSourceStub {
  name: string;
  displayName: string;
  status: "planned";
  reason: string;
}

/** Builder E — the facade the CLI + (future) resource call. */
export interface CreativeRagService {
  sync(opts: { sources?: string[]; limit?: number }): Promise<SyncReport>;
  index(): Promise<IndexReport>;
  search(query: string, k: number, filters?: SearchFilters): Promise<SearchResult[]>;
  /** Read one card by id (for the resource). undefined if missing/tombstoned. */
  getCard(id: string): Promise<CreativeRagCard | undefined>;
}

export interface SyncReport {
  added: number;
  updated: number;
  tombstoned: number;
  skippedNoLicense: number;
  binariesStored: number;
  perSource: Record<string, number>;
}

export interface IndexReport {
  embedded: number;
  cachedSkipped: number;
  total: number;
}

export interface CreativeRagConfig {
  enabled: boolean;
  dataDir: string;
  ollamaUrl: string;
  embedModel: string;
  licenseAllowlist: CreativeRagLicense[];
}
