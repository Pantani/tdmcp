/**
 * Creative RAG — service facade (sync / index / search / getCard).
 *
 * Wires the source adapters (Builder D), the embeddings client (Builder B) and
 * the JSONL index store (Builder C) behind one {@link CreativeRagService}. It is
 * the only place that touches the local data dir: card Markdown files live under
 * `dataDir/cards/<id>.md`, allowlisted binaries under `dataDir/binaries/<id>.jpg`,
 * and the embedding index in `dataDir/index.jsonl`.
 *
 * Creative RAG is repertoire context only — this module never imports the TD
 * client, the bridge, DMX, fixtures, or Python exec. All failures are typed; the
 * CLI catches and prints them. `index` surfaces Ollama failures as typed errors
 * rather than crashing the process.
 */

import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "../utils/atomicWrite.js";
import { type Logger, silentLogger } from "../utils/logger.js";
import { computeContentHash, computeId, parseCard, serializeCard } from "./cardParser.js";
import { JsonlIndexStore } from "./indexStore.js";
import { shouldStoreBinary } from "./licensePolicy.js";
import { OllamaEmbeddingsClient } from "./ollamaClient.js";
import { friendlyOllamaError } from "./ollamaErrors.js";
import { resolveSources } from "./sources/index.js";
import type {
  CreativeRagCard,
  CreativeRagConfig,
  CreativeRagService,
  EmbeddedCard,
  IndexReport,
  IndexStore,
  OllamaEmbeddingsClient as OllamaEmbeddingsClientContract,
  RawSourceItem,
  SearchFilters,
  SearchResult,
  Source,
  SyncReport,
} from "./types.js";

export interface CreativeRagServiceDeps {
  config: CreativeRagConfig;
  sources?: Source[];
  embeddings?: OllamaEmbeddingsClientContract;
  store?: IndexStore;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

const DEFAULT_SYNC_LIMIT = 10;
const DEFAULT_SEARCH_K = 10;
const BINARY_DOWNLOAD_TIMEOUT_MS = 15000;

/**
 * Builds a {@link CreativeRagService} from a config plus optional injected
 * collaborators (sources, embeddings client, store). Defaults wire the real
 * source registry, an {@link OllamaEmbeddingsClient} at `config.ollamaUrl`, and a
 * {@link JsonlIndexStore} at `dataDir/index.jsonl`.
 */
export function createCreativeRagService(deps: CreativeRagServiceDeps): CreativeRagService {
  const { config } = deps;
  const logger = deps.logger ?? silentLogger;
  const sources = deps.sources ?? resolveSources();
  const embeddings =
    deps.embeddings ??
    new OllamaEmbeddingsClient({
      baseUrl: config.ollamaUrl,
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    });
  const store =
    deps.store ?? new JsonlIndexStore({ filePath: join(config.dataDir, "index.jsonl") });
  const fetchImpl = deps.fetchImpl ?? fetch;

  const cardsDir = join(config.dataDir, "cards");
  const binariesDir = join(config.dataDir, "binaries");

  async function sync(opts: { sources?: string[]; limit?: number }): Promise<SyncReport> {
    const limit = opts.limit ?? DEFAULT_SYNC_LIMIT;
    const selected = filterSources(sources, opts.sources);
    const report: SyncReport = {
      added: 0,
      updated: 0,
      tombstoned: 0,
      skippedNoLicense: 0,
      binariesStored: 0,
      perSource: {},
    };

    const existing = readAllCards(cardsDir);
    const existingById = new Map(existing.map((card) => [card.id, card] as const));
    const seenIds = new Set<string>();
    // Only sources that were selected AND fetched without throwing are eligible for
    // tombstoning — a partial `--source` run or a failed source must never tombstone
    // cards it did not compare against. Keyed by `sourceName` (the card's source label).
    const syncedSourceNames = new Set<string>();

    for (const source of selected) {
      let items: RawSourceItem[];
      try {
        items = await source.fetchItems(limit, fetchImpl);
      } catch (err) {
        logger.warn(`Creative RAG: source "${source.name}" failed to fetch`, {
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      report.perSource[source.name] = items.length;
      syncedSourceNames.add(source.displayName);

      for (const item of items) {
        const card = buildCardFromItem(item);
        seenIds.add(card.id);

        const prior = existingById.get(card.id);
        if (prior === undefined) {
          report.added += 1;
        } else if (prior.contentHash !== card.contentHash) {
          report.updated += 1;
        }

        writeCard(cardsDir, card);

        if (item.imageUrl !== undefined) {
          if (shouldStoreBinary(card.license, config.licenseAllowlist)) {
            const stored = await downloadBinary(item.imageUrl, card.id);
            if (stored) {
              report.binariesStored += 1;
            }
          } else {
            report.skippedNoLicense += 1;
          }
        }
      }
    }

    // Diff: a previously-known card is tombstoned only when its OWN source was synced
    // successfully this run yet did not return it (kept on disk so its id stays
    // resolvable, just flagged out of search/get). Cards from sources not synced this
    // run — a partial `--source` selection or a source that failed — are left intact.
    for (const card of existing) {
      if (
        syncedSourceNames.has(card.sourceName) &&
        !seenIds.has(card.id) &&
        card.tombstone !== true
      ) {
        writeCard(cardsDir, { ...card, tombstone: true });
        report.tombstoned += 1;
      }
    }

    return report;
  }

  async function index(): Promise<IndexReport> {
    const all = readAllCards(cardsDir);
    // Purge tombstoned cards from the index: marking the Markdown card as tombstoned
    // does not remove a row already written by a prior `index`, so search would keep
    // returning it. Drop those ids from the store before (re-)indexing the rest.
    await store.remove(all.filter((card) => card.tombstone === true).map((card) => card.id));
    // Recompute the content hash from the parsed card so a user edit to a card's
    // Markdown (without manually bumping the frontmatter `contentHash`) is not treated
    // as a cache hit — the edited card gets re-embedded and stays searchable.
    const cards = all
      .filter((card) => card.tombstone !== true)
      .map((card) => ({ ...card, contentHash: computeContentHash(card) }));
    const report: IndexReport = { embedded: 0, cachedSkipped: 0, total: cards.length };
    if (cards.length === 0) {
      return report;
    }

    const fingerprints = await store.existingFingerprints();
    const toEmbed: CreativeRagCard[] = [];
    for (const card of cards) {
      const key = `${card.id}:${card.contentHash}:${config.embedModel}`;
      if (fingerprints.has(key)) {
        report.cachedSkipped += 1;
      } else {
        toEmbed.push(card);
      }
    }
    if (toEmbed.length === 0) {
      return report;
    }

    let vectors: number[][];
    try {
      vectors = await embeddings.embed(
        toEmbed.map((card) => embedText(card)),
        config.embedModel,
      );
    } catch (err) {
      // Surface as typed: log a friendly line and rethrow the typed Ollama error so
      // the CLI catches it and prints friendlyOllamaError — never crash the process.
      logger.error(`Creative RAG: embedding failed — ${friendlyOllamaError(err)}`);
      throw err;
    }

    const embedded: EmbeddedCard[] = [];
    for (let i = 0; i < toEmbed.length; i += 1) {
      const card = toEmbed[i];
      const vector = vectors[i];
      if (card === undefined || vector === undefined) {
        continue;
      }
      embedded.push(toEmbeddedCard(card, vector, config.embedModel));
    }
    await store.upsert(embedded);
    report.embedded = embedded.length;
    return report;
  }

  async function search(
    query: string,
    k: number,
    filters?: SearchFilters,
  ): Promise<SearchResult[]> {
    const topK = k > 0 ? k : DEFAULT_SEARCH_K;
    const vectors = await embeddings.embed([query], config.embedModel);
    const vector = vectors[0];
    if (vector === undefined) {
      return [];
    }
    return store.search(vector, topK, filters);
  }

  async function getCard(id: string): Promise<CreativeRagCard | undefined> {
    // Card ids are sha256(sourceUrl) hex. Reject anything else before touching the
    // filesystem so an untrusted resource/CLI segment (e.g. "../secret") can never
    // escape the cards dir or probe arbitrary `.md` files.
    if (!/^[0-9a-f]{64}$/.test(id)) {
      return undefined;
    }
    let raw: string;
    try {
      raw = readFileSync(join(cardsDir, `${id}.md`), "utf8");
    } catch {
      return undefined;
    }
    let card: CreativeRagCard;
    try {
      card = parseCard(raw);
    } catch {
      return undefined;
    }
    return card.tombstone === true ? undefined : card;
  }

  async function downloadBinary(imageUrl: string, id: string): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BINARY_DOWNLOAD_TIMEOUT_MS);
    try {
      const response = await fetchImpl(imageUrl, { signal: controller.signal });
      if (!response.ok) {
        logger.warn(`Creative RAG: binary download returned HTTP ${response.status}`, { id });
        return false;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      mkdirSync(binariesDir, { recursive: true });
      atomicWriteFileSync(join(binariesDir, `${id}.jpg`), bytes);
      return true;
    } catch (err) {
      const reason = controller.signal.aborted
        ? `timed out after ${BINARY_DOWNLOAD_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : String(err);
      logger.warn("Creative RAG: binary download failed", { id, error: reason });
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  return { sync, index, search, getCard };
}

/** Restricts `sources` to the requested `names` (by `source.name`); all when unset. */
function filterSources(sources: Source[], names?: string[]): Source[] {
  if (names === undefined || names.length === 0) {
    return sources;
  }
  const wanted = new Set(names);
  return sources.filter((source) => wanted.has(source.name));
}

/** Maps a raw source item into a fully-formed, hashed {@link CreativeRagCard}. */
function buildCardFromItem(item: RawSourceItem): CreativeRagCard {
  const id = computeId(item.sourceUrl);
  const base: CreativeRagCard = {
    schemaVersion: 1,
    id,
    type: item.type,
    title: item.title,
    sourceUrl: item.sourceUrl,
    sourceName: item.sourceName,
    license: item.license,
    tools: [],
    tags: item.tags,
    tdmcpAffordances: [],
    contentHash: "",
    ...(item.artist !== undefined ? { artist: item.artist } : {}),
    ...(item.year !== undefined ? { year: item.year } : {}),
    ...(item.medium !== undefined ? { medium: item.medium } : {}),
    ...(item.rightsNotes !== undefined ? { rightsNotes: item.rightsNotes } : {}),
    ...(item.palette !== undefined ? { palette: item.palette } : {}),
    ...(item.visualLanguage !== undefined ? { visualLanguage: item.visualLanguage } : {}),
  };
  return { ...base, contentHash: computeContentHash(base) };
}

/** Reads + parses every `*.md` card in `dir`; skips unreadable/invalid files. */
function readAllCards(dir: string): CreativeRagCard[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const cards: CreativeRagCard[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) {
      continue;
    }
    try {
      cards.push(parseCard(readFileSync(join(dir, entry), "utf8")));
    } catch {
      // Skip a corrupt or partial card file rather than aborting the whole run.
    }
  }
  return cards;
}

/** Atomically writes one card to `dir/<id>.md`. */
function writeCard(dir: string, card: CreativeRagCard): void {
  mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(join(dir, `${card.id}.md`), serializeCard(card), "utf8");
}

/** The text fed to the embedder — title, descriptive fields, tags and body. */
function embedText(card: CreativeRagCard): string {
  const parts = [
    card.title,
    card.artist,
    card.medium,
    card.visualLanguage,
    card.motionLanguage,
    card.interaction,
    card.materials,
    card.lighting,
    card.tags.join(" "),
    card.body,
  ];
  return parts
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n");
}

/** Projects a card + its vector into a JSONL index line. */
function toEmbeddedCard(card: CreativeRagCard, embedding: number[], model: string): EmbeddedCard {
  const embedded: EmbeddedCard = {
    id: card.id,
    contentHash: card.contentHash,
    embeddingModel: model,
    embedding,
    title: card.title,
    type: card.type,
    license: card.license,
    tags: card.tags,
    sourceUrl: card.sourceUrl,
    sourceName: card.sourceName,
  };
  if (card.rightsNotes !== undefined) {
    embedded.rightsNotes = card.rightsNotes;
  }
  return embedded;
}
