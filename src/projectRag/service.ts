/**
 * Project RAG — service facade skeleton (F0).
 *
 * Implements the {@link ProjectRagService} surface (sync/index/search/getCard/
 * listSources) so the CLI, resource, and context wiring compile and behave
 * correctly with **no sources configured yet**. F1 adds the real source
 * adapters + extractors + embedding wiring.
 *
 * Hard rule: NO bridge, NO DMX, NO Python exec in this module. The opt-in
 * F3 bridge-analyze path uses a SEPARATE TouchDesignerClient on a dedicated
 * port — never the one wired by `buildToolContext`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Logger, silentLogger } from "../utils/logger.js";
import { parseProjectCard } from "./cardParser.js";
import { createProjectIndexStore } from "./storeFactory.js";
import type {
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

export interface ProjectRagServiceDeps {
  config: ProjectRagConfig;
  store?: ProjectIndexStore;
  logger?: Logger;
}

const EMPTY_SYNC: ProjectSyncReport = {
  added: 0,
  updated: 0,
  tombstoned: 0,
  skippedNoLicense: 0,
  binariesStored: 0,
  perSource: {},
};

/**
 * Builds a Project RAG service. F0 returns empty reports / empty results from
 * every operation: there are no source adapters wired yet. `getCard` already
 * works against any cards manually placed under `<dataDir>/cards/<id>.md`, which
 * keeps the resource & test harness exercisable.
 */
export function createProjectRagService(deps: ProjectRagServiceDeps): ProjectRagService {
  const { config } = deps;
  const logger = deps.logger ?? silentLogger;

  let storePromise: Promise<ProjectIndexStore> | undefined;
  function getStore(): Promise<ProjectIndexStore> {
    if (deps.store !== undefined) return Promise.resolve(deps.store);
    if (storePromise === undefined) storePromise = createProjectIndexStore(config, logger);
    return storePromise;
  }

  const cardsDir = join(config.dataDir, "cards");

  async function sync(_opts: { sources?: string[]; limit?: number }): Promise<ProjectSyncReport> {
    // F0: no sources resolved yet — return an empty report (no error).
    return { ...EMPTY_SYNC, perSource: {} };
  }

  async function index(): Promise<ProjectIndexReport> {
    // F0: store exists but ingestion path is not wired; report the loaded card
    // count so the CLI prints something honest even before F1.
    const cards = readAllCards(cardsDir);
    return { embedded: 0, cachedSkipped: 0, total: cards.length };
  }

  async function search(
    _query: string,
    _k: number,
    _filters?: ProjectSearchFilters,
  ): Promise<ProjectSearchResult[]> {
    // F0: no embedder wired — return empty. Resource/CLI surface stays consistent.
    return [];
  }

  async function getCard(id: string): Promise<ProjectRagCard | undefined> {
    // ids are sha256(provenance.canonical) — strict regex guards against path traversal.
    if (!/^[0-9a-f]{64}$/.test(id)) return undefined;
    let raw: string;
    try {
      raw = readFileSync(join(cardsDir, `${id}.md`), "utf8");
    } catch {
      return undefined;
    }
    let card: ProjectRagCard;
    try {
      card = parseProjectCard(raw);
    } catch {
      return undefined;
    }
    return card.tombstone === true ? undefined : card;
  }

  async function listSources(): Promise<ProjectSourceStatus[]> {
    // F0: no adapters yet. Surface the planned slots so `tdmcp project-rag sources`
    // is self-explanatory and the agent (via tdmcp://project/sources, F4) knows
    // what is NOT indexed.
    return [
      {
        name: "derivative-local",
        displayName: "TouchDesigner OP Snippets + Palette (local install)",
        status: "planned",
        reason: "F1",
      },
      {
        name: "github-repo",
        displayName: "GitHub repo allowlist (TDMCP_PROJECT_RAG_GITHUB_REPOS)",
        status: "planned",
        reason: "F1",
      },
      {
        name: "github-topic",
        displayName: "GitHub topic:touchdesigner-components",
        status: "planned",
        reason: "F2",
      },
      {
        name: "awesome-touchdesigner",
        displayName: "monkeymonk/awesome-touchdesigner (discovery)",
        status: "planned",
        reason: "F2",
      },
    ];
  }

  // Touch logger so `noUnusedLocals` stays quiet until F1 fills in real warnings.
  void logger;

  return { sync, index, search, getCard, listSources };
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
