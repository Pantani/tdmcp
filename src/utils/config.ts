import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const LLM_TIER_VALUES = ["standard", "safe", "creative"] as const;

export type LlmTier = (typeof LLM_TIER_VALUES)[number];

export const DEFAULT_LLM_TIER: LlmTier = "standard";
export const DEFAULT_TELEGRAM_LLM_TIER: LlmTier = "safe";
export const DEFAULT_LLM_MAX_STEPS = 8;
export const DEFAULT_LLM_TEMPERATURE = 0.4;
export const MAX_LLM_MAX_STEPS = 32;
const MAX_LLM_TEMPERATURE = 2;

function sanitizeLlmTier(value: unknown): LlmTier | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return DEFAULT_LLM_TIER;
  const normalized = value.trim().toLowerCase();
  return LLM_TIER_VALUES.includes(normalized as LlmTier)
    ? (normalized as LlmTier)
    : DEFAULT_LLM_TIER;
}

function sanitizeBoundedNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  integer: boolean,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed)) return fallback;
  const bounded = Math.min(max, Math.max(min, parsed));
  return integer ? Math.trunc(bounded) : bounded;
}

const LlmTierSchema = z.preprocess(
  sanitizeLlmTier,
  z.enum(LLM_TIER_VALUES).default(DEFAULT_LLM_TIER),
);

const LlmMaxStepsSchema = z.preprocess(
  (value) => sanitizeBoundedNumber(value, DEFAULT_LLM_MAX_STEPS, 1, MAX_LLM_MAX_STEPS, true),
  z.number().int().min(1).max(MAX_LLM_MAX_STEPS).default(DEFAULT_LLM_MAX_STEPS),
);

const LlmTemperatureSchema = z.preprocess(
  (value) => sanitizeBoundedNumber(value, DEFAULT_LLM_TEMPERATURE, 0, MAX_LLM_TEMPERATURE, false),
  z.number().min(0).max(MAX_LLM_TEMPERATURE).default(DEFAULT_LLM_TEMPERATURE),
);

function csvList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value))
    return value
      .map(String)
      .map((v) => v.trim())
      .filter(Boolean);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

const CsvListSchema = z.preprocess(csvList, z.array(z.string()).default([]));

/** Coerces an env/file boolean-ish value: "1"/"true" (any case) → true, else → false. */
function ragEnabledFlag(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return false;
  return normalized === "1" || normalized === "true";
}

const RagEnabledSchema = z.preprocess(ragEnabledFlag, z.boolean().default(false));

/**
 * Centralized "boolean-ish env" parser for Creative RAG feature flags. Both
 * config.ts (parsed config) and call sites that read env BEFORE config is built
 * (tool registration, Layer 2 index) must agree on what counts as enabled —
 * accept "1" or "true" (case-insensitive), trim whitespace. Anything else →
 * disabled. Keep this in sync with `ragEnabledFlag` above.
 */
export function isRagFeatureFlagEnabled(value: string | undefined): boolean {
  if (value === undefined || value === null) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

/**
 * Centralized "boolean-ish env" parser for the ACE-Step feature flag. Mirrors
 * {@link isRagFeatureFlagEnabled}: config.ts (parsed config) and call sites that
 * read env BEFORE config is built (tool registration, layer index, CLI) must
 * agree on what counts as enabled — accept "1"/"true" (case-insensitive),
 * trim whitespace; anything else → disabled.
 */
export function isAceFeatureFlagEnabled(value: string | undefined): boolean {
  if (value === undefined || value === null) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

const RAG_INJECT_K_DEFAULT = 3;
const RAG_INJECT_K_MAX = 5;
const RAG_INJECT_TIMEOUT_MS_DEFAULT = 3000;
const RAG_PROBE_TIMEOUT_MS_DEFAULT = 3000;
const RAG_FUSION_K_DEFAULT = 60;
const RAG_FUSION_K_MAX = 1000;

const RagApplyCardSchema = z.preprocess(ragEnabledFlag, z.boolean().default(false));
const RagInjectAskSchema = z.preprocess(ragEnabledFlag, z.boolean().default(false));
const RagInjectKSchema = z.preprocess(
  (value) => sanitizeBoundedNumber(value, RAG_INJECT_K_DEFAULT, 1, RAG_INJECT_K_MAX, true),
  z.number().int().min(1).max(RAG_INJECT_K_MAX).default(RAG_INJECT_K_DEFAULT),
);
const RagInjectTimeoutMsSchema = z.preprocess(
  (value) =>
    sanitizeBoundedNumber(value, RAG_INJECT_TIMEOUT_MS_DEFAULT, 1, Number.MAX_SAFE_INTEGER, true),
  z.number().int().min(1).default(RAG_INJECT_TIMEOUT_MS_DEFAULT),
);
const RagProbeTimeoutMsSchema = z.preprocess(
  (value) =>
    sanitizeBoundedNumber(value, RAG_PROBE_TIMEOUT_MS_DEFAULT, 1, Number.MAX_SAFE_INTEGER, true),
  z.number().int().min(1).default(RAG_PROBE_TIMEOUT_MS_DEFAULT),
);
const RagFusionSchema = z.preprocess(ragEnabledFlag, z.boolean().default(false));
const RagFusionKSchema = z.preprocess(
  (value) => sanitizeBoundedNumber(value, RAG_FUSION_K_DEFAULT, 1, RAG_FUSION_K_MAX, true),
  z.number().int().min(1).max(RAG_FUSION_K_MAX).default(RAG_FUSION_K_DEFAULT),
);

/**
 * Project RAG composite-score weights schema (technical:license:freshness:reliability).
 * Accepts either a 4-number object or a "0.45:0.25:0.15:0.15" colon CSV from env.
 */
const ScoreWeightsSchema = z.object({
  technical: z.number().min(0).max(1),
  license: z.number().min(0).max(1),
  freshness: z.number().min(0).max(1),
  reliability: z.number().min(0).max(1),
});

function parseScoreWeights(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return undefined;
  const parts = value
    .split(":")
    .map((p) => p.trim())
    .filter(Boolean)
    .map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return undefined;
  const [technical, license, freshness, reliability] = parts as [number, number, number, number];
  return { technical, license, freshness, reliability };
}

function sanitizeTelegramTier(value: unknown): LlmTier | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return LLM_TIER_VALUES.includes(normalized as LlmTier) ? (normalized as LlmTier) : undefined;
}

const TelegramTierSchema = z.preprocess(
  sanitizeTelegramTier,
  z.enum(LLM_TIER_VALUES).default(DEFAULT_TELEGRAM_LLM_TIER),
);

export const ConfigSchema = z.object({
  /** TouchDesigner bridge host. */
  tdHost: z.string().min(1).default("127.0.0.1"),
  /** TouchDesigner bridge port (WebServer DAT). */
  tdPort: z.coerce.number().int().positive().max(65535).default(9980),
  /** MCP transport: `stdio` (default, for local clients) or `http` (Streamable HTTP, loopback-only). */
  transport: z.enum(["stdio", "http"]).default("stdio"),
  /** Log verbosity (written to stderr). */
  logLevel: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
  /** Per-request timeout against the TD bridge, in milliseconds. */
  requestTimeoutMs: z.coerce.number().int().positive().default(10000),
  /** HTTP transport port (only used when transport=http). */
  httpPort: z.coerce.number().int().positive().max(65535).default(3939),
  /** HTTP bind host. Unset binds loopback; containers opt into 0.0.0.0 explicitly. */
  httpHost: z.string().min(1).optional(),
  /** Subscribe to TD WebSocket events and forward them as MCP logging notifications. */
  events: z.enum(["on", "off"]).default("on"),
  /**
   * Raw Python escape-hatch tools (`execute_python_script`, `exec_node_method`,
   * `create_python_script`, `author_script_operator`).
   * Set to "off" to lock them out for restricted setups; on by default.
   */
  rawPython: z.enum(["on", "off"]).default("on"),
  /**
   * "YOLO" mode (`TDMCP_YOLO=1`): skip any interactive confirmation the bridge may
   * add for destructive actions. No native dialogs exist yet, so today this only
   * flows into result reporting; off by default so nothing is silently skipped.
   */
  yolo: z.preprocess(ragEnabledFlag, z.boolean().default(false)),
  /**
   * Tool exposure profile. `full` (default) registers every tool; `safe`
   * additionally hides the destructive/raw-code tools (a superset of
   * TDMCP_RAW_PYTHON=off) so an autonomous in-TD agent (e.g. via LOPs) gets a
   * curated, non-destructive surface; `directory` exposes only a compact
   * registry-facing build/inspect set. Default `full` keeps existing clients
   * unaffected.
   */
  toolProfile: z.enum(["full", "safe", "directory"]).default("full"),
  /**
   * Optional shared bearer token for the TD bridge. When set, the server sends it
   * as `Authorization: Bearer <token>` and the bridge requires a match. Leave unset
   * (default) for the zero-config local flow. Set the SAME value in TouchDesigner's
   * environment (`TDMCP_BRIDGE_TOKEN`) to turn enforcement on.
   */
  bridgeToken: z.string().min(1).optional(),
  /**
   * Optional bearer token that the Streamable HTTP transport requires on every
   * request (`Authorization: Bearer <token>`). Acts as the enforcement half of an
   * MCP OAuth2 Resource Server: when set, missing/invalid credentials get a 401 with
   * a `WWW-Authenticate: Bearer` challenge. Unset (default) keeps the zero-config
   * local flow open. The HTTP transport binds loopback only, so this matters when
   * the server is fronted by a proxy or bound to a LAN interface.
   */
  httpAuthToken: z.string().min(1).optional(),
  /**
   * Base URL of an OpenAI-compatible chat endpoint used by `tdmcp chat` (the local
   * LLM copilot). Defaults to Ollama's local server. Point it at LM Studio, a cloud
   * GPU, or any OpenAI-compatible API to swap the model without code changes.
   */
  llmBaseUrl: z.string().min(1).default("http://127.0.0.1:11434/v1"),
  /**
   * Model id the local copilot asks for (must be pulled in the backend, e.g.
   * `ollama pull qwen2.5:3b`). Default is `qwen2.5:3b`: in benchmarking it matched
   * the 7B/14B at 100% tool-calling on the copilot's simple-task workload while being
   * ~2x faster and <half the size — the sweet spot for the artist audience. Bump to
   * `qwen2.5:7b` for more answer-quality headroom; avoid sub-3B (flaky at tool use).
   */
  llmModel: z.string().min(1).default("qwen2.5:3b"),
  /** Optional bearer token for the LLM endpoint (ignored by local Ollama; needed for paid/cloud APIs). */
  llmApiKey: z.string().min(1).optional(),
  /**
   * Default tool tier for `tdmcp chat`: `standard` (inspection + simple CRUD),
   * `safe` (read-only), or `creative` (standard + curated generators).
   */
  llmTier: LlmTierSchema,
  /** Maximum model/tool loop iterations for one local copilot turn. */
  llmMaxSteps: LlmMaxStepsSchema,
  /** Sampling temperature for the local copilot's streaming chat calls. */
  llmTemperature: LlmTemperatureSchema,
  /** Loopback port the `tdmcp chat` web UI binds to. */
  chatPort: z.coerce.number().int().positive().max(65535).default(4141),
  /** Telegram Bot API token for `tdmcp telegram`. Keep in env/config, never CLI args. */
  telegramBotToken: z.string().min(1).optional(),
  /** Comma-separated Telegram chat ids allowed to reach the local copilot. */
  telegramAllowedChats: CsvListSchema,
  /** Optional comma-separated Telegram user ids allowed to reach the local copilot. */
  telegramAllowedUsers: CsvListSchema,
  /**
   * Default Telegram copilot tier. Unlike browser chat, Telegram defaults to `safe`
   * because messages arrive through an external network service.
   */
  telegramDefaultTier: TelegramTierSchema,
  /** Long-poll timeout for Telegram getUpdates, in seconds. */
  telegramPollTimeoutSec: z.coerce.number().int().min(1).max(60).default(30),
  /** Expiry for a pending non-safe Telegram prompt awaiting /approve. */
  telegramConfirmTimeoutMs: z.coerce.number().int().min(1000).default(60000),
  /**
   * Absolute path to an Obsidian vault (a folder of markdown notes) that backs
   * the vault integration tools. A leading `~/` is expanded to the home dir.
   * Leave unset (default) to disable those tools.
   */
  vaultPath: z.string().min(1).optional(),
  /**
   * Opt-in switch for the local Creative RAG repertoire feature
   * (`tdmcp creative-rag` + `tdmcp://creative/*` resources). Off by default;
   * accepts "1"/"true" (case-insensitive) as true, "0"/"false"/"" as false.
   */
  ragEnabled: RagEnabledSchema,
  /** Local data dir for Creative RAG cards, binaries and the JSONL index. */
  ragDataDir: z.string().min(1).default(".tdmcp/creative-rag"),
  /** Ollama base URL used for Creative RAG embeddings. */
  ragOllamaUrl: z.string().min(1).default("http://127.0.0.1:11434"),
  /** Embedding model id pulled in Ollama (e.g. `ollama pull nomic-embed-text`). */
  ragEmbedModel: z.string().min(1).default("nomic-embed-text"),
  /** Licenses whose binaries Creative RAG may download/store locally. */
  ragLicenseAllowlist: CsvListSchema.default(["CC0", "PublicDomain"]),
  /** Inputs per Ollama embed POST (batched). */
  ragEmbedBatch: z.coerce.number().int().min(1).max(512).default(64),
  /** Index backend: in-memory JSONL (default) or LanceDB (optional dep). */
  ragBackend: z.enum(["jsonl", "lancedb"]).default("jsonl"),
  /** Smithsonian Open Access API key (read in-source by the adapter; never threaded through CreativeRagConfig). */
  ragSmithsonianKey: z.string().optional(),
  /** Europeana Search API key (read in-source by the adapter; never threaded through CreativeRagConfig). */
  ragEuropeanaKey: z.string().optional(),
  /**
   * Gate the `apply_creative_card` MCP tool / CLI verb. Off by default so the
   * inspiration→execution loop only registers when explicitly enabled. Note:
   * tool registration runs BEFORE the parsed config is available, so the tool
   * index and CLI registry still read `process.env.TDMCP_RAG_APPLY_CARD` via the
   * shared `isRagFeatureFlagEnabled` helper. This field is the source of truth
   * everywhere else.
   */
  ragApplyCard: RagApplyCardSchema,
  /** Auto-inject creative cards into `tdmcp ask` prompts (mirrors --with-creative). */
  ragInjectAsk: RagInjectAskSchema,
  /** How many cards to inject into `tdmcp ask` context (1–5). */
  ragInjectK: RagInjectKSchema,
  /** Wall-clock timeout (ms) for the creative-context search during `tdmcp ask`. */
  ragInjectTimeoutMs: RagInjectTimeoutMsSchema,
  /** Wall-clock timeout (ms) for the doctor's Ollama probe. */
  ragProbeTimeoutMs: RagProbeTimeoutMsSchema,
  /**
   * Cross-RAG ranking: fuse Creative RAG + Project RAG results into one ranked
   * list via Reciprocal Rank Fusion. Off by default; active only when
   * `ragEnabled && projectRagEnabled && ragFusion` and both services exist.
   */
  ragFusion: RagFusionSchema,
  /** RRF k constant for cross-RAG fusion (positive int 1..1000, default 60). */
  ragFusionK: RagFusionKSchema,
  /**
   * Opt-in switch for the Project RAG repertoire feature
   * (`tdmcp project-rag` + `tdmcp://project/*` resources). Default ON when
   * `ragEnabled` is on; the AND of both gates controls activation. Accepts
   * "1"/"true" (case-insensitive) as true, "0"/"false"/"" as false.
   */
  projectRagEnabled: z.preprocess(ragEnabledFlag, z.boolean().default(true)),
  /**
   * Opt-in bridge-quarantine analysis (F3) for `.toe`/`.tox` cards. OFF by
   * default; when ON, Project RAG uses a SEPARATE TouchDesignerClient on
   * {@link ConfigSchema.shape.projectRagBridgePort} — never the default 9980.
   */
  projectRagBridgeAnalysis: z.preprocess(ragEnabledFlag, z.boolean().default(false)),
  /** Dedicated TD bridge port for the F3 quarantine analyzer (must differ from `tdPort`). */
  projectRagBridgePort: z.coerce.number().int().positive().max(65535).default(9981),
  /** Optional GitHub API token for higher rate limits on `github-repo`/`github-topic` sources. */
  projectRagGhToken: z.string().min(1).optional(),
  /**
   * Comma-separated list of GitHub repos for the `github-repo` source, each as
   * `owner/repo[@ref]`. When unset, defaults to the F1 seed
   * `torinmb/mediapipe-touchdesigner` (MIT). Free-form string — parsed by
   * `parseRepoListEnv` in `src/projectRag/sources/githubRepo.ts`.
   */
  projectRagGithubRepos: z.string().optional(),
  /**
   * CSV of GitHub topics for the `github-topic` scanner. Pass the literal `off`
   * to disable the scanner entirely. When unset the scanner runs with the
   * default TouchDesigner topic list.
   */
  projectRagGithubTopics: z.string().optional(),
  /** Per-sync hard cap for the topic scanner (default 25). */
  projectRagTopicCap: z.coerce.number().int().positive().max(500).default(25),
  /**
   * Explicit override for the `derivative-local` source's TouchDesigner install
   * root (the directory containing the Palette / OP Snippets samples). When
   * unset, the source probes OS-default install locations; when nothing is found
   * the source is skipped (never errors the sync). Local-only enumeration —
   * Derivative-EULA bytes are never downloaded or redistributed.
   */
  projectRagDerivativeRoot: z.string().min(1).optional(),
  /**
   * Opt-in switch for the Interactive & Immersive HQ markdown source (`iihq`).
   * OFF by default: the IIHQ "Introduction to TouchDesigner" manual is
   * CC-BY-NC-SA (non-commercial), so it is enabled explicitly via
   * `TDMCP_PROJECT_RAG_IIHQ=1`. When ON it ingests markdown TEXT only — never
   * binaries — tagged `tutorial`, and every result carries a license banner.
   */
  projectRagIihq: z.preprocess(ragEnabledFlag, z.boolean().default(false)),
  /** Branch/tag/SHA override for the `iihq` source (default `master`). */
  projectRagIihqRef: z.string().min(1).optional(),
  /** Static `.toe`/`.tox` analyzer subprocess timeout (ms). */
  projectRagAnalyzeTimeoutMs: z.coerce.number().int().positive().default(30000),
  /**
   * Licenses whose `.tox`/`.toe` binaries Project RAG may store locally. Default
   * is the SPDX-permissive set; users opt into GPL/CC-BY/EULA explicitly.
   */
  projectRagLicenseAllowlist: CsvListSchema.default([
    "CC0",
    "PublicDomain",
    "MIT",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "ISC",
    "MPL-2.0",
  ]),
  /**
   * Composite scoring weights (technical:license:freshness:reliability).
   * Sum is not required to be 1.0; the composite formula uses them as-is.
   * Pre-parsed from a CSV env so it stays one-line in profiles.
   */
  projectRagScoreWeights: z
    .preprocess(parseScoreWeights, ScoreWeightsSchema)
    .default({ technical: 0.45, license: 0.25, freshness: 0.15, reliability: 0.15 }),
  /**
   * Opt-in switch for the ACE-Step music-generation feature (`generate_music`
   * tool + `music generate` CLI verb). Off by default; accepts "1"/"true"
   * (case-insensitive) as true, "0"/"false"/"" as false. Note: tool
   * registration runs BEFORE the parsed config is available, so the layer index
   * and CLI read `process.env.TDMCP_ACE_ENABLED` via the shared
   * `isAceFeatureFlagEnabled` helper. This field is the source of truth
   * everywhere else.
   */
  aceEnabled: z.preprocess(ragEnabledFlag, z.boolean().default(false)),
  /**
   * ACE-Step serving mode. `wrapper` (default) talks to the local `ace/` FastAPI
   * wrapper; `native` targets ACE-Step's own FastAPI layer. Only `wrapper` is
   * wired in P0.
   */
  aceMode: z.enum(["wrapper", "native"]).default("wrapper"),
  /** Host of the local ACE-Step server. */
  aceHost: z.string().min(1).default("127.0.0.1"),
  /** Port of the local ACE-Step server. */
  acePort: z.coerce.number().int().positive().max(65535).default(8000),
  /** Directory the wrapper writes generated WAVs into (passed as `save_path`). */
  aceOutputDir: z.string().min(1).default(".tdmcp/ace-output"),
  /** Optional bearer token for the ACE-Step server (sent as `Authorization: Bearer <token>`). */
  aceToken: z.string().min(1).optional(),
  /** Wall-clock timeout (ms) for a generation request; generation is slow, so default 10 min. */
  aceTimeoutMs: z.coerce.number().int().positive().default(600000),
  /** Diffusion steps injected when the caller omits `infer_step` (ACE-Step's own default is 60). */
  aceDefaultSteps: z.coerce.number().int().positive().default(27),
  /**
   * F6 threshold: in `mode:"auto"`, an estimated generation longer than this
   * hands off to a background job instead of blocking the tool call.
   */
  aceSyncMaxSeconds: z.coerce.number().int().positive().default(120),
  /**
   * Real-time factor: wall-clock seconds of compute per second of audio, at
   * `aceDefaultSteps`. **Operator-calibrated, no default** — run one
   * `generate_music` and read `observed_rtf` off the result, then set this.
   * Unset ⇒ no estimate ⇒ `mode:"auto"` stays sync (today's behavior).
   */
  aceRtf: z.coerce.number().positive().optional(),
  /** Job-poll and progress-notification cadence (ms). */
  acePollMs: z.coerce.number().int().positive().default(2000),
});

type ParsedConfig = z.infer<typeof ConfigSchema>;

export type LlmRuntimeConfig = Pick<ParsedConfig, "llmTier" | "llmMaxSteps" | "llmTemperature">;

export type TdmcpConfig = ParsedConfig;
export type LoadedTdmcpConfig = ParsedConfig;

/** Options for {@link loadConfig}. File loading is opt-in (entry points pass `useFiles`). */
export interface LoadConfigOptions {
  /** Read a `tdmcp.json` / `.tdmcprc` / global config file (off by default so unit tests stay env-pure). */
  useFiles?: boolean;
  /** Select a named profile from the config file's `profiles` map (errors if missing). */
  profile?: string;
  /** Explicit config file path; overrides the search order when set. */
  configPath?: string;
  /** Per-invocation overrides (CLI flags) — highest precedence. Undefined keys are ignored. */
  overrides?: Partial<Record<keyof LoadedTdmcpConfig, unknown>>;
  /** Directory to search for cwd config files (defaults to process.cwd()). */
  cwd?: string;
}

export interface ConfigProfileSummary {
  name: string;
  keys: string[];
}

export interface ConfigProfileList {
  source?: string;
  profiles: ConfigProfileSummary[];
}

/** A loaded config file: the base settings, any named profiles, and where it came from. */
interface ConfigFile {
  base: Record<string, unknown>;
  profiles: Record<string, Record<string, unknown>>;
  source?: string;
}

/** Maps env vars to config keys (values may be undefined; pruned before merge). */
function envValues(env: NodeJS.ProcessEnv): Record<string, unknown> {
  return {
    tdHost: env.TDMCP_TD_HOST,
    tdPort: env.TDMCP_TD_PORT,
    transport: env.TDMCP_TRANSPORT,
    logLevel: env.TDMCP_LOG_LEVEL,
    requestTimeoutMs: env.TDMCP_REQUEST_TIMEOUT_MS,
    httpPort: env.TDMCP_HTTP_PORT,
    httpHost: env.TDMCP_HTTP_HOST,
    events: env.TDMCP_EVENTS,
    rawPython: env.TDMCP_RAW_PYTHON,
    yolo: env.TDMCP_YOLO,
    toolProfile: env.TDMCP_TOOL_PROFILE,
    bridgeToken: env.TDMCP_BRIDGE_TOKEN || undefined,
    httpAuthToken: env.TDMCP_HTTP_AUTH_TOKEN || undefined,
    llmBaseUrl: env.TDMCP_LLM_BASE_URL,
    llmModel: env.TDMCP_LLM_MODEL,
    llmApiKey: env.TDMCP_LLM_API_KEY || undefined,
    llmTier: env.TDMCP_LLM_TIER || undefined,
    llmMaxSteps: env.TDMCP_LLM_MAX_STEPS || undefined,
    llmTemperature: env.TDMCP_LLM_TEMPERATURE || undefined,
    chatPort: env.TDMCP_CHAT_PORT,
    telegramBotToken: env.TDMCP_TELEGRAM_BOT_TOKEN || undefined,
    telegramAllowedChats: env.TDMCP_TELEGRAM_ALLOWED_CHATS || undefined,
    telegramAllowedUsers: env.TDMCP_TELEGRAM_ALLOWED_USERS || undefined,
    telegramDefaultTier: env.TDMCP_TELEGRAM_DEFAULT_TIER || undefined,
    telegramPollTimeoutSec: env.TDMCP_TELEGRAM_POLL_TIMEOUT_SEC || undefined,
    telegramConfirmTimeoutMs: env.TDMCP_TELEGRAM_CONFIRM_TIMEOUT_MS || undefined,
    vaultPath: env.TDMCP_VAULT_PATH || undefined,
    ragEnabled: env.TDMCP_RAG_ENABLED,
    ragDataDir: env.TDMCP_RAG_DATA_DIR || undefined,
    ragOllamaUrl: env.TDMCP_RAG_OLLAMA_URL || undefined,
    ragEmbedModel: env.TDMCP_RAG_EMBED_MODEL || undefined,
    ragLicenseAllowlist: env.TDMCP_RAG_LICENSE_ALLOWLIST || undefined,
    ragEmbedBatch: env.TDMCP_RAG_EMBED_BATCH || undefined,
    ragBackend: env.TDMCP_RAG_BACKEND || undefined,
    ragSmithsonianKey: env.TDMCP_RAG_SMITHSONIAN_KEY || undefined,
    ragEuropeanaKey: env.TDMCP_RAG_EUROPEANA_KEY || undefined,
    ragApplyCard: env.TDMCP_RAG_APPLY_CARD,
    ragInjectAsk: env.TDMCP_RAG_INJECT_ASK,
    ragInjectK: env.TDMCP_RAG_INJECT_K || undefined,
    ragInjectTimeoutMs: env.TDMCP_RAG_INJECT_TIMEOUT_MS || undefined,
    ragProbeTimeoutMs: env.TDMCP_RAG_PROBE_TIMEOUT_MS || undefined,
    ragFusion: env.TDMCP_RAG_FUSION,
    ragFusionK: env.TDMCP_RAG_FUSION_K || undefined,
    projectRagEnabled: env.TDMCP_PROJECT_RAG_ENABLED,
    projectRagBridgeAnalysis: env.TDMCP_PROJECT_RAG_BRIDGE_ANALYSIS,
    projectRagBridgePort: env.TDMCP_PROJECT_RAG_BRIDGE_PORT || undefined,
    projectRagGhToken: env.TDMCP_PROJECT_RAG_GH_TOKEN || undefined,
    projectRagGithubRepos: env.TDMCP_PROJECT_RAG_GITHUB_REPOS || undefined,
    projectRagGithubTopics: env.TDMCP_PROJECT_RAG_GITHUB_TOPICS || undefined,
    projectRagTopicCap: env.TDMCP_PROJECT_RAG_TOPIC_CAP || undefined,
    projectRagDerivativeRoot: env.TDMCP_PROJECT_RAG_DERIVATIVE_ROOT || undefined,
    projectRagIihq: env.TDMCP_PROJECT_RAG_IIHQ,
    projectRagIihqRef: env.TDMCP_PROJECT_RAG_IIHQ_REF || undefined,
    projectRagAnalyzeTimeoutMs: env.TDMCP_PROJECT_RAG_ANALYZE_TIMEOUT_MS || undefined,
    projectRagLicenseAllowlist: env.TDMCP_PROJECT_RAG_LICENSE_ALLOWLIST || undefined,
    projectRagScoreWeights: env.TDMCP_PROJECT_RAG_SCORE_WEIGHTS || undefined,
    aceEnabled: env.TDMCP_ACE_ENABLED,
    aceMode: env.TDMCP_ACE_MODE || undefined,
    aceHost: env.TDMCP_ACE_HOST || undefined,
    acePort: env.TDMCP_ACE_PORT || undefined,
    aceOutputDir: env.TDMCP_ACE_OUTPUT_DIR || undefined,
    aceToken: env.TDMCP_ACE_TOKEN || undefined,
    aceTimeoutMs: env.TDMCP_ACE_TIMEOUT_MS || undefined,
    aceDefaultSteps: env.TDMCP_ACE_DEFAULT_STEPS || undefined,
    aceSyncMaxSeconds: env.TDMCP_ACE_SYNC_MAX_SECONDS || undefined,
    aceRtf: env.TDMCP_ACE_RTF || undefined,
    acePollMs: env.TDMCP_ACE_POLL_MS || undefined,
  };
}

/** Drop keys whose value is `undefined` so they don't clobber a lower-precedence layer. */
function pruneUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/** Candidate config-file paths in precedence order (first existing wins). */
function configSearchPaths(env: NodeJS.ProcessEnv, cwd: string): string[] {
  const explicit = env.TDMCP_CONFIG_FILE?.trim();
  if (explicit) return [explicit];
  const globalDir = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return [join(cwd, "tdmcp.json"), join(cwd, ".tdmcprc"), join(globalDir, "tdmcp", "config.json")];
}

/**
 * Reads the first existing config file (or `configPath` when given). Fail-safe: a
 * missing file yields empty config; a malformed file warns to stderr and is ignored,
 * never throwing — a broken config must not take the server/CLI down.
 */
function readConfigFile(env: NodeJS.ProcessEnv, opts: LoadConfigOptions): ConfigFile {
  const cwd = opts.cwd ?? process.cwd();
  const candidates = opts.configPath ? [opts.configPath] : configSearchPaths(env, cwd);
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const { profiles, ...base } = raw;
      const profileMap =
        profiles && typeof profiles === "object"
          ? (profiles as Record<string, Record<string, unknown>>)
          : {};
      return { base, profiles: profileMap, source: path };
    } catch (err) {
      process.stderr.write(
        `tdmcp: ignoring malformed config file ${path}: ${(err as Error).message}\n`,
      );
      return { base: {}, profiles: {} };
    }
  }
  return { base: {}, profiles: {} };
}

/** Lists named profiles from the selected config file without exposing their values. */
export function listConfigProfiles(
  env: NodeJS.ProcessEnv = process.env,
  opts: LoadConfigOptions = {},
): ConfigProfileList {
  const file = readConfigFile(env, { ...opts, useFiles: true });
  const profiles = Object.entries(file.profiles)
    .map(([name, values]) => ({
      name,
      keys: Object.keys(values).sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { source: file.source, profiles };
}

/**
 * Loads and validates configuration. By default reads **environment variables only**
 * (missing values fall back to defaults; invalid values throw a descriptive ZodError),
 * which keeps the bare `loadConfig()` deterministic for tests and existing callers.
 *
 * Entry points opt into config files with `{ useFiles: true }`. Precedence, lowest →
 * highest: schema defaults < file base < file profile (`{ profile }`) < environment <
 * CLI `{ overrides }`. So an artist can save per-venue setups in `tdmcp.json`
 * (`{ profiles: { club: { tdHost, tdPort } } }`) and switch with `--profile club`,
 * while env vars and one-off flags still win.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  opts: LoadConfigOptions = {},
): LoadedTdmcpConfig {
  const file = opts.useFiles ? readConfigFile(env, opts) : { base: {}, profiles: {} };
  const profileName = opts.profile ?? (opts.useFiles ? env.TDMCP_PROFILE : undefined);
  let profilePart: Record<string, unknown> = {};
  if (profileName) {
    const found = (file as ConfigFile).profiles?.[profileName];
    if (!found) {
      const where = (file as ConfigFile).source ? ` (${(file as ConfigFile).source})` : "";
      throw new Error(
        `Config profile "${profileName}" not found${where}. Define it under "profiles" in your config file.`,
      );
    }
    profilePart = found;
  }
  const merged = {
    ...file.base,
    ...profilePart,
    ...pruneUndefined(envValues(env)),
    ...pruneUndefined(opts.overrides ?? {}),
  };
  return ConfigSchema.parse(merged);
}

/** Sensitive keys redacted by {@link describeConfig} for safe printing/sharing. */
const SECRET_KEYS: ReadonlyArray<keyof LoadedTdmcpConfig> = [
  "bridgeToken",
  "httpAuthToken",
  "llmApiKey",
  "telegramBotToken",
  "telegramAllowedChats",
  "telegramAllowedUsers",
  "ragSmithsonianKey",
  "ragEuropeanaKey",
  "projectRagGhToken",
  "aceToken",
];

/** A copy of the config safe to print/share — secrets are masked. */
export function describeConfig(config: TdmcpConfig | LoadedTdmcpConfig): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  for (const key of SECRET_KEYS) {
    if (out[key] !== undefined) out[key] = "***redacted***";
  }
  return out;
}

/** Base URL for the TouchDesigner REST bridge. */
export function tdBaseUrl(config: Pick<TdmcpConfig, "tdHost" | "tdPort">): string {
  return `http://${config.tdHost}:${config.tdPort}`;
}

/** Base URL for the local ACE-Step server. */
export function aceBaseUrl(config: Pick<TdmcpConfig, "aceHost" | "acePort">): string {
  return `http://${config.aceHost}:${config.acePort}`;
}
