import { z } from "zod";

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
   * Raw Python escape-hatch tools (`execute_python_script`, `exec_node_method`).
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
  /** Loopback port the `tdmcp chat` web UI binds to. */
  chatPort: z.coerce.number().int().positive().max(65535).default(4141),
  /**
   * Absolute path to an Obsidian vault (a folder of markdown notes) that backs
   * the vault integration tools. A leading `~/` is expanded to the home dir.
   * Leave unset (default) to disable those tools.
   */
  vaultPath: z.string().min(1).optional(),
});

export type TdmcpConfig = z.infer<typeof ConfigSchema>;

/**
 * Loads and validates configuration from environment variables. Missing values
 * fall back to sensible defaults; invalid values throw a descriptive ZodError.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): TdmcpConfig {
  return ConfigSchema.parse({
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
    chatPort: env.TDMCP_CHAT_PORT,
    vaultPath: env.TDMCP_VAULT_PATH || undefined,
  });
}

/** Base URL for the TouchDesigner REST bridge. */
export function tdBaseUrl(config: Pick<TdmcpConfig, "tdHost" | "tdPort">): string {
  return `http://${config.tdHost}:${config.tdPort}`;
}
