/**
 * Project RAG — service facade (F1: first real source wired).
 *
 * F1 wires the `github-repo` adapter through the full
 * `sync → write card → license-gated binary download → index → search` pipeline.
 * The embedder reuses the Creative RAG `OllamaEmbeddingsClient` directly so
 * Project RAG inherits the same batching, timeout, and typed-error story.
 *
 * Hard rule: NO bridge, NO DMX, NO Python exec in this module. The opt-in
 * F3 bridge-analyze path will use a SEPARATE TouchDesignerClient on a dedicated
 * port — never the one wired by `buildToolContext`.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { OllamaEmbeddingsClient } from "../creativeRag/ollamaClient.js";
import { friendlyOllamaError } from "../creativeRag/ollamaErrors.js";
import { atomicWriteFileSync } from "../utils/atomicWrite.js";
import { type Logger, silentLogger } from "../utils/logger.js";
import {
  computeProjectContentHash,
  computeProjectId,
  parseProjectCard,
  serializeProjectCard,
} from "./cardParser.js";
import { isCopyleftLicense, shouldStoreProjectBinary } from "./licensePolicy.js";
import { computeProjectScore } from "./scoring.js";
import type { RawProjectItem, SourceAdapter } from "./sources/index.js";
import { resolveProjectSources, SourceSkippedError } from "./sources/index.js";
import { createProjectIndexStore } from "./storeFactory.js";
import type {
  ProjectEmbeddedCard,
  ProjectIndexReport,
  ProjectIndexStore,
  ProjectRagCard,
  ProjectRagConfig,
  ProjectRagService,
  ProjectSearchFilters,
  ProjectSearchResult,
  ProjectSourceStatus,
  ProjectSyncReport,
} from "./types.js";

export interface ProjectRagEmbeddings {
  embed(inputs: string[], model: string): Promise<number[][]>;
}

export interface ProjectRagServiceDeps {
  config: ProjectRagConfig;
  store?: ProjectIndexStore;
  /** Optional source-adapter override (tests). When omitted, resolves from env. */
  sources?: SourceAdapter[];
  /** Optional embeddings override (tests). When omitted, builds an OllamaEmbeddingsClient. */
  embeddings?: ProjectRagEmbeddings;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  /**
   * Reads `TDMCP_PROJECT_RAG_GITHUB_REPOS` for the default source list. Tests
   * inject `() => undefined` (or a literal CSV) to keep determinism.
   */
  githubReposCsv?: string | undefined;
  /**
   * Reads `TDMCP_PROJECT_RAG_GITHUB_TOPICS`. Pass the literal `off` to disable
   * the topic scanner; pass a CSV of topics to override the defaults.
   */
  githubTopicsCsv?: string | undefined;
  /** Topic scanner per-sync cap (default 25); used when topics are enabled. */
  topicCap?: number | undefined;
}

const DEFAULT_SYNC_LIMIT = 10;
const DEFAULT_SEARCH_K = 10;
const BINARY_DOWNLOAD_TIMEOUT_MS = 30_000;

const EMPTY_SYNC: ProjectSyncReport = {
  added: 0,
  updated: 0,
  tombstoned: 0,
  skippedNoLicense: 0,
  binariesStored: 0,
  perSource: {},
};

export function createProjectRagService(deps: ProjectRagServiceDeps): ProjectRagService {
  const { config } = deps;
  const logger = deps.logger ?? silentLogger;
  const fetchImpl = deps.fetchImpl ?? fetch;

  const csv = deps.githubReposCsv ?? config.githubReposCsv;
  const topicsCsv = deps.githubTopicsCsv ?? config.githubTopicsCsv;
  const topicCap = deps.topicCap ?? config.topicCap;
  const sources =
    deps.sources ??
    resolveProjectSources({
      ...(csv !== undefined ? { githubReposCsv: csv } : {}),
      ...(topicsCsv !== undefined ? { githubTopicsCsv: topicsCsv } : {}),
      ...(topicCap !== undefined ? { topicCap } : {}),
    });

  const embeddings =
    deps.embeddings ??
    new OllamaEmbeddingsClient({
      baseUrl: config.ollamaUrl,
      batchSize: config.embedBatch,
      fetchImpl,
    });

  let storePromise: Promise<ProjectIndexStore> | undefined;
  function getStore(): Promise<ProjectIndexStore> {
    if (deps.store !== undefined) return Promise.resolve(deps.store);
    if (storePromise === undefined) storePromise = createProjectIndexStore(config, logger);
    return storePromise;
  }

  const cardsDir = join(config.dataDir, "cards");
  const binariesDir = join(config.dataDir, "binaries");

  async function sync(opts: { sources?: string[]; limit?: number }): Promise<ProjectSyncReport> {
    if (sources.length === 0) return { ...EMPTY_SYNC, perSource: {} };
    const limit = opts.limit ?? DEFAULT_SYNC_LIMIT;
    const selected = filterSources(sources, opts.sources);
    if (selected.length === 0) return { ...EMPTY_SYNC, perSource: {} };

    const report: ProjectSyncReport = {
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
    /** Sources that fetched without throwing — eligible to tombstone their stale cards. */
    const syncedSourceNames = new Set<string>();

    for (const source of selected) {
      let items: RawProjectItem[];
      try {
        items = await source.fetchItems(limit, {
          fetchImpl,
          ...(config.ghToken !== undefined ? { ghToken: config.ghToken } : {}),
        });
      } catch (err) {
        if (err instanceof SourceSkippedError) {
          logger.warn(`Project RAG: source "${source.name}" skipped — ${err.message}`);
        } else {
          logger.warn(`Project RAG: source "${source.name}" failed to fetch`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        continue;
      }
      report.perSource[source.name] = items.length;

      for (const item of items) {
        const card = buildCardFromItem(item, config);
        seenIds.add(card.id);
        syncedSourceNames.add(card.provenance.sourceName);

        const prior = existingById.get(card.id);
        if (prior === undefined) report.added += 1;
        else if (prior.contentHash !== card.contentHash) report.updated += 1;

        writeCard(cardsDir, card);

        if (item.binaryUrl !== undefined) {
          if (shouldStoreProjectBinary(card.license, config.licenseAllowlist)) {
            const stored = await downloadBinary(
              item.binaryUrl,
              card.id,
              item.pathInRepo,
              fetchImpl,
              logger,
            );
            if (stored !== undefined) {
              // Preserve the base `contentHash` so a re-sync stays a cache hit —
              // binary path/hash are persistence metadata, not embeddable content.
              writeCard(cardsDir, {
                ...card,
                binaryPath: stored.relPath,
                binaryHash: stored.hash,
              });
              report.binariesStored += 1;
            }
          } else {
            report.skippedNoLicense += 1;
          }
        }
      }
    }

    // Tombstone only previously-known cards from sources that synced cleanly this run.
    for (const card of existing) {
      if (
        syncedSourceNames.has(card.provenance.sourceName) &&
        !seenIds.has(card.id) &&
        card.tombstone !== true
      ) {
        writeCard(cardsDir, { ...card, tombstone: true });
        report.tombstoned += 1;
      }
    }
    return report;
  }

  async function index(): Promise<ProjectIndexReport> {
    const store = await getStore();
    const all = readAllCards(cardsDir);
    // Purge tombstoned ids from the JSONL index so search never returns them.
    await store.remove(all.filter((c) => c.tombstone === true).map((c) => c.id));
    // Recompute contentHash from the parsed body so a manual edit re-embeds.
    const cards = all
      .filter((c) => c.tombstone !== true)
      .map((c) => ({ ...c, contentHash: computeProjectContentHash(c) }));
    const report: ProjectIndexReport = { embedded: 0, cachedSkipped: 0, total: cards.length };
    if (cards.length === 0) return report;

    const fingerprints = await store.existingFingerprints();
    const toEmbed: ProjectRagCard[] = [];
    for (const card of cards) {
      const key = `${card.id}:${card.contentHash}:${config.embedModel}`;
      if (fingerprints.has(key)) report.cachedSkipped += 1;
      else toEmbed.push(card);
    }
    if (toEmbed.length === 0) return report;

    let vectors: number[][];
    try {
      vectors = await embeddings.embed(
        toEmbed.map((c) => embedTextFor(c)),
        config.embedModel,
      );
    } catch (err) {
      logger.error(`Project RAG: embedding failed — ${friendlyOllamaError(err)}`);
      throw err;
    }

    const embedded: ProjectEmbeddedCard[] = [];
    for (let i = 0; i < toEmbed.length; i += 1) {
      const card = toEmbed[i];
      const vector = vectors[i];
      if (card === undefined || vector === undefined) continue;
      embedded.push(toEmbeddedCard(card, vector, config.embedModel, config));
    }
    await store.upsert(embedded);
    report.embedded = embedded.length;
    return report;
  }

  async function search(
    query: string,
    k: number,
    filters?: ProjectSearchFilters,
  ): Promise<ProjectSearchResult[]> {
    const topK = k > 0 ? k : DEFAULT_SEARCH_K;
    const vectors = await embeddings.embed([query], config.embedModel);
    const vector = vectors[0];
    if (vector === undefined) return [];
    const store = await getStore();
    return store.search(vector, topK, filters);
  }

  async function getCard(id: string): Promise<ProjectRagCard | undefined> {
    if (!/^[0-9a-f]{64}$/.test(id)) return undefined;
    let raw: string;
    try {
      raw = readFileSync(join(cardsDir, `${id}.md`), "utf8");
    } catch {
      return undefined;
    }
    try {
      const card = parseProjectCard(raw);
      return card.tombstone === true ? undefined : card;
    } catch {
      return undefined;
    }
  }

  async function listSources(): Promise<ProjectSourceStatus[]> {
    const liveNames = new Set(sources.map((s) => s.name));
    const statuses: ProjectSourceStatus[] = [];
    if (liveNames.has("github-repo")) {
      statuses.push({
        name: "github-repo",
        displayName: "GitHub repo allowlist (TDMCP_PROJECT_RAG_GITHUB_REPOS)",
        status: "ready",
        reason: config.ghToken === undefined ? "unauthenticated (limit 60 req/h)" : "authenticated",
      });
    }
    statuses.push({
      name: "derivative-local",
      displayName: "TouchDesigner OP Snippets + Palette (local install)",
      status: "planned",
      reason: "F2",
    });
    if (liveNames.has("github-topic")) {
      statuses.push({
        name: "github-topic",
        displayName: "GitHub topic scanner (touchdesigner-components et al.)",
        status: "ready",
        reason:
          config.ghToken === undefined
            ? "unauthenticated (limit 60 req/h — set TDMCP_PROJECT_RAG_GH_TOKEN)"
            : "authenticated",
      });
    } else {
      statuses.push({
        name: "github-topic",
        displayName: "GitHub topic scanner (touchdesigner-components et al.)",
        status: "skipped",
        reason: "disabled (TDMCP_PROJECT_RAG_GITHUB_TOPICS=off)",
      });
    }
    statuses.push({
      name: "awesome-touchdesigner",
      displayName: "monkeymonk/awesome-touchdesigner (discovery)",
      status: "planned",
      reason: "F2",
    });
    return statuses;
  }

  return { sync, index, search, getCard, listSources };

  async function downloadBinary(
    binaryUrl: string,
    id: string,
    pathInRepo: string | undefined,
    fetchFn: typeof fetch,
    log: Logger,
  ): Promise<{ relPath: string; hash: string } | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BINARY_DOWNLOAD_TIMEOUT_MS);
    try {
      const response = await fetchFn(binaryUrl, { signal: controller.signal });
      if (!response.ok) {
        log.warn(`Project RAG: binary download HTTP ${response.status}`, { id });
        return undefined;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const ext = pathInRepo !== undefined ? (extname(pathInRepo) || ".bin").toLowerCase() : ".bin";
      mkdirSync(binariesDir, { recursive: true });
      const filename = `${id}${ext}`;
      atomicWriteFileSync(join(binariesDir, filename), bytes);
      const hash = createHash("sha256").update(bytes).digest("hex");
      return { relPath: `binaries/${filename}`, hash };
    } catch (err) {
      const reason = controller.signal.aborted
        ? `timed out after ${BINARY_DOWNLOAD_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : String(err);
      log.warn("Project RAG: binary download failed", { id, error: reason });
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}

function buildCardFromItem(item: RawProjectItem, config: ProjectRagConfig): ProjectRagCard {
  const id = computeProjectId(item.canonical);
  const fetchedAt = new Date().toISOString();
  const operators = item.files !== undefined ? [...item.files] : undefined;
  const base: ProjectRagCard = {
    schemaVersion: 2,
    id,
    kind: "project",
    type: item.type,
    title: item.title,
    tags: item.tags,
    contentHash: "",
    provenance: {
      sourceName: item.sourceName,
      sourceUrl: item.sourceUrl,
      canonical: item.canonical,
      fetchedAt,
      ...(item.commitOrVersion !== undefined ? { commitOrVersion: item.commitOrVersion } : {}),
      ...(item.pathInRepo !== undefined ? { pathInRepo: item.pathInRepo } : {}),
    },
    license: item.license,
    licenseConfidence: item.licenseConfidence,
    ...(item.licenseFile !== undefined ? { licenseFile: item.licenseFile } : {}),
    ...(item.body !== undefined ? { body: item.body } : {}),
    ...(item.authors !== undefined ? { authors: item.authors } : {}),
    ...(operators !== undefined ? { operators } : {}),
    ...(item.rightsNotes !== undefined ? { rightsNotes: item.rightsNotes } : {}),
  };
  const rightsNotes = isCopyleftLicense(base.license)
    ? `${base.rightsNotes ?? ""}${base.rightsNotes ? " " : ""}Copyleft (${base.license}): derived work must preserve license.`.trim()
    : base.rightsNotes;
  const enriched: ProjectRagCard = {
    ...base,
    ...(rightsNotes !== undefined ? { rightsNotes } : {}),
  };
  const score = computeProjectScore(enriched, config.scoreWeights);
  const withScore: ProjectRagCard = { ...enriched, score };
  return { ...withScore, contentHash: computeProjectContentHash(withScore) };
}

function filterSources(sources: SourceAdapter[], names?: string[]): SourceAdapter[] {
  if (names === undefined || names.length === 0) return [...sources];
  const wanted = new Set(names);
  const out: SourceAdapter[] = [];
  const seen = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) continue;
    seen.add(n);
    const found = sources.find((s) => s.name === n);
    if (found !== undefined && wanted.has(found.name)) out.push(found);
  }
  return out;
}

function readAllCards(dir: string): ProjectRagCard[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const cards: ProjectRagCard[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    try {
      cards.push(parseProjectCard(readFileSync(join(dir, entry), "utf8")));
    } catch {
      // Skip corrupt/partial card files.
    }
  }
  return cards;
}

function writeCard(dir: string, card: ProjectRagCard): void {
  mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(join(dir, `${card.id}.md`), serializeProjectCard(card), "utf8");
}

function embedTextFor(card: ProjectRagCard): string {
  const parts = [
    card.title,
    card.tags.join(" "),
    card.operators?.join(" "),
    card.license,
    card.body,
    card.authors?.join(" "),
  ];
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join("\n");
}

function toEmbeddedCard(
  card: ProjectRagCard,
  embedding: number[],
  model: string,
  _config: ProjectRagConfig,
): ProjectEmbeddedCard {
  const embedded: ProjectEmbeddedCard = {
    id: card.id,
    contentHash: card.contentHash,
    embeddingModel: model,
    embedding,
    title: card.title,
    kind: "project",
    type: card.type,
    license: card.license,
    tags: card.tags,
    sourceUrl: card.provenance.sourceUrl,
    sourceName: card.provenance.sourceName,
  };
  if (card.rightsNotes !== undefined) embedded.rightsNotes = card.rightsNotes;
  if (card.operators !== undefined) embedded.operators = card.operators;
  if (card.score !== undefined) embedded.score = card.score;
  return embedded;
}
