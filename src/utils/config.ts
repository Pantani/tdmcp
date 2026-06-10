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

const TelegramTierSchema = z.preprocess((value) => {
  const tier = sanitizeLlmTier(value);
  return tier ?? DEFAULT_TELEGRAM_LLM_TIER;
}, z.enum(LLM_TIER_VALUES).default(DEFAULT_TELEGRAM_LLM_TIER));

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
  /** Subscribe to TD WebSocket events and forward them as MCP logging notifications. */
  events: z.enum(["on", "off"]).default("on"),
  /**
   * Raw Python escape-hatch tools (`execute_python_script`, `exec_node_method`,
   * `create_python_script`).
   * Set to "off" to lock them out for restricted setups; on by default.
   */
  rawPython: z.enum(["on", "off"]).default("on"),
  /**
   * Tool exposure profile. `full` (default) registers every tool; `safe`
   * additionally hides the destructive/raw-code tools (a superset of
   * TDMCP_RAW_PYTHON=off) so an autonomous in-TD agent (e.g. via LOPs) gets a
   * curated, non-destructive surface. Default `full` keeps existing clients
   * unaffected.
   */
  toolProfile: z.enum(["full", "safe"]).default("full"),
  /**
   * Optional shared bearer token for the TD bridge. When set, the server sends it
   * as `Authorization: Bearer <token>` and the bridge requires a match. Leave unset
   * (default) for the zero-config local flow. Set the SAME value in TouchDesigner's
   * environment (`TDMCP_BRIDGE_TOKEN`) to turn enforcement on.
   */
  bridgeToken: z.string().min(1).optional(),
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
    events: env.TDMCP_EVENTS,
    rawPython: env.TDMCP_RAW_PYTHON,
    toolProfile: env.TDMCP_TOOL_PROFILE,
    bridgeToken: env.TDMCP_BRIDGE_TOKEN || undefined,
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
  "llmApiKey",
  "telegramBotToken",
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
