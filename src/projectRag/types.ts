/**
 * Project RAG — shared cross-module contracts (single source of truth).
 *
 * Project RAG is the **technical/project repertoire** sibling to Creative RAG:
 * indexes TouchDesigner projects/components/snippets/tutorials with mandatory
 * `provenance` + `license`, opt-in and offline-first. Card kind is discriminated
 * by `kind: "project"` so the schema can later be unified with creative cards
 * under a single store (see design `_workspace/01_design_project_rag.md`).
 *
 * Hard rule: NO bridge, NO DMX, NO Python exec in the search path. The opt-in
 * `bridgeAnalyze` extractor (F3) uses a SEPARATE TD instance on a dedicated port.
 */

export const PROJECT_CARD_SCHEMA_VERSION = 2 as const;

/**
 * Licenses recognised by Project RAG. Aggregates open-data/art licenses (shared
 * with Creative RAG), SPDX permissive + copyleft, and proprietary-relevant flags.
 */
export type ProjectRagLicense =
  // open data / arte
  | "CC0"
  | "PublicDomain"
  | "CC-BY"
  | "CC-BY-SA"
  // SPDX permissivos
  | "MIT"
  | "Apache-2.0"
  | "BSD-2-Clause"
  | "BSD-3-Clause"
  | "ISC"
  | "MPL-2.0"
  // SPDX copyleft (flagged)
  | "GPL-2.0"
  | "GPL-3.0"
  | "LGPL-2.1"
  | "LGPL-3.0"
  | "AGPL-3.0"
  // proprietários relevantes
  | "Derivative-EULA"
  | "Proprietary-Free"
  | "Proprietary-Paid"
  | "Unknown"
  | "Restricted";

export type ProjectKind = "project";

export type ProjectRagType =
  | "project"
  | "component"
  | "snippet"
  | "tutorial"
  | "custom-op"
  | "framework";

export type LicenseConfidence = "declared" | "spdx-detected" | "heuristic" | "unknown";

export interface ProjectProvenance {
  /** Stable source identifier, e.g. `github:torinmb/mediapipe-touchdesigner`. */
  sourceName: string;
  /** Canonical URL of the resource (the human-clickable one). */
  sourceUrl: string;
  /** Hashing base for `id` — usually `sourceUrl` + `pathInRepo`. */
  canonical: string;
  commitOrVersion?: string;
  pathInRepo?: string;
  /** ISO-8601. */
  fetchedAt: string;
}

export interface ProjectScore {
  technical: number;
  license: number;
  freshness: number;
  reliability: number;
  composite: number;
}

export interface ExposedParam {
  name: string;
  type: string;
  default?: string;
}

export interface ScriptDat {
  name: string;
  path: string;
  lang: "python" | "glsl" | "text";
}

export interface ProjectDependencies {
  python?: string[];
  customOps?: string[];
  externalFiles?: string[];
}

export interface ProjectRagCard {
  // ── core ────────────────────────────────────────────────────────────
  schemaVersion: 2;
  /** sha256(provenance.canonical). */
  id: string;
  kind: "project";
  type: ProjectRagType;
  title: string;
  body?: string;
  tags: string[];
  contentHash: string;
  embeddingModel?: string;
  tombstone?: boolean;

  // ── provenance + license (BOTH MANDATORY) ───────────────────────────
  provenance: ProjectProvenance;
  license: ProjectRagLicense;
  licenseConfidence: LicenseConfidence;
  licenseFile?: string;
  rightsNotes?: string;

  // ── project-specific ────────────────────────────────────────────────
  authors?: string[];
  tdVersionMin?: string;
  tdVersionTested?: string[];
  platforms?: ("win" | "mac" | "linux")[];
  operatorMix?: Record<string, number>;
  operators?: string[];
  exposedParams?: ExposedParam[];
  scriptsDat?: ScriptDat[];
  dependencies?: ProjectDependencies;
  binaryHash?: string;
  binaryPath?: string;
  previewPath?: string;
  score?: ProjectScore;
  /** Names of EXISTING tdmcp tools the agent could use to reconstruct this card. */
  tdmcpAffordances?: string[];
  /**
   * F3 bridge-analyze outcome for the persisted binary, if it ran. `ok` =
   * loaded cleanly in the quarantine TD; `failed` = real error; `skipped` =
   * binary present but no quarantine bridge reachable (or feature disabled).
   * Unset = analyze never attempted on this card.
   */
  analysisStatus?: "ok" | "failed" | "skipped";
  /** Optional short reason string complementing `analysisStatus` (telemetry only). */
  analysisReason?: string;
}

/** One JSONL index line. */
export interface ProjectEmbeddedCard {
  id: string;
  contentHash: string;
  embeddingModel: string;
  embedding: number[];
  title: string;
  kind: "project";
  type: ProjectRagType;
  license: ProjectRagLicense;
  tags: string[];
  sourceUrl: string;
  sourceName: string;
  rightsNotes?: string;
  operators?: string[];
  score?: ProjectScore;
}

export interface ProjectSearchFilters {
  license?: ProjectRagLicense[];
  type?: ProjectRagType[];
  /** AND-match: card must have ALL listed tags. */
  tags?: string[];
  /** AND-match: card's `operators` must include EVERY listed op name. */
  operators?: string[];
  tdVersionMin?: string;
}

export interface ProjectSearchResult {
  id: string;
  /** Final ranking score: cosineSim * score.composite. */
  score: number;
  cosineScore: number;
  title: string;
  type: ProjectRagType;
  license: ProjectRagLicense;
  licenseConfidence: LicenseConfidence;
  sourceUrl: string;
  sourceName: string;
  tags: string[];
  rightsNotes?: string;
  operators?: string[];
  composite?: number;
}

export interface ProjectIndexStore {
  upsert(cards: ProjectEmbeddedCard[]): Promise<void>;
  loadAll(): Promise<ProjectEmbeddedCard[]>;
  search(
    queryEmbedding: number[],
    k: number,
    filters?: ProjectSearchFilters,
  ): Promise<ProjectSearchResult[]>;
  remove(ids: string[]): Promise<void>;
  existingFingerprints(): Promise<Set<string>>;
}

export interface ProjectRagConfig {
  enabled: boolean;
  dataDir: string;
  ollamaUrl: string;
  embedModel: string;
  licenseAllowlist: ProjectRagLicense[];
  embedBatch: number;
  backend: "jsonl" | "lancedb";
  /** OFF by default — F3 opt-in flag. */
  bridgeAnalysis: boolean;
  /** Dedicated TD bridge port (default 9981 — distinct from default 9980). */
  bridgePort: number;
  /** GitHub API token (optional, never logged). */
  ghToken?: string;
  /**
   * Optional CSV of `owner/repo[@ref]` for the `github-repo` source. When
   * unset, the source defaults to the F1 seed (torinmb/mediapipe-touchdesigner).
   */
  githubReposCsv?: string;
  /**
   * Optional CSV of GitHub topics for the `github-topic` scanner. Pass the
   * literal `off` to disable the scanner entirely. When unset the scanner runs
   * with the default TouchDesigner topic list.
   */
  githubTopicsCsv?: string;
  /** Per-sync hard cap for the topic scanner (default 25). */
  topicCap?: number;
  /** Static-analyzer subprocess timeout. */
  analyzeTimeoutMs: number;
  scoreWeights: { technical: number; license: number; freshness: number; reliability: number };
}

export interface ProjectSourceStatus {
  name: string;
  displayName: string;
  status: "ready" | "skipped" | "planned" | "failed";
  reason?: string;
}

export interface ProjectSyncReport {
  added: number;
  updated: number;
  tombstoned: number;
  skippedNoLicense: number;
  binariesStored: number;
  perSource: Record<string, number>;
  /** Set only when `sync({bridge:true})` runs. */
  bridgeAnalysis?: ProjectBridgeAnalysisReport;
}

/** Aggregate of running the F3 bridge analyzer across every downloadable card. */
export interface ProjectBridgeAnalysisReport {
  attempted: number;
  ok: number;
  failed: number;
  skipped: number;
}

/** Result of `service.analyze(path)` — runs the F3 bridge extractor on one artifact. */
export interface ProjectAnalyzeReport {
  status: "ok" | "failed" | "skipped";
  reason?: string;
  error?: string;
  errorCount?: number;
  hasPreview?: boolean;
  bridgeUrl: string;
}

export interface ProjectIndexReport {
  embedded: number;
  cachedSkipped: number;
  total: number;
}

export interface ProjectRescoreReport {
  rescored: number;
  total: number;
}

/** Facade the CLI + resource call. */
export interface ProjectRagService {
  sync(opts: {
    sources?: string[];
    limit?: number;
    /** Per-call topic override (CSV). Falls back to config.githubTopicsCsv. */
    topicsCsv?: string;
    /** Per-call topic cap override. */
    topicCap?: number;
    /**
     * F3 opt-in. When true, after the normal sync runs the bridge-analyze
     * extractor on every card with a persisted binary and a permissive
     * license, persisting `analysisStatus` on each card.
     */
    bridge?: boolean;
  }): Promise<ProjectSyncReport>;
  index(): Promise<ProjectIndexReport>;
  /**
   * Recompute card.score and rewrite the JSONL index without calling Ollama.
   * Useful after weight tuning. Returns how many cards were updated.
   */
  rescore(): Promise<ProjectRescoreReport>;
  search(query: string, k: number, filters?: ProjectSearchFilters): Promise<ProjectSearchResult[]>;
  getCard(id: string): Promise<ProjectRagCard | undefined>;
  listSources(): Promise<ProjectSourceStatus[]>;
  /**
   * F3 ad-hoc analyze of one artifact path through the quarantine bridge.
   * Never touches the user's main TD. Skipped when bridge is offline.
   */
  analyze(artifactPath: string): Promise<ProjectAnalyzeReport>;
}
