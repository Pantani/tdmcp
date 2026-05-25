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
   * Optional shared bearer token for the TD bridge. When set, the server sends it
   * as `Authorization: Bearer <token>` and the bridge requires a match. Leave unset
   * (default) for the zero-config local flow. Set the SAME value in TouchDesigner's
   * environment (`TDMCP_BRIDGE_TOKEN`) to turn enforcement on.
   */
  bridgeToken: z.string().min(1).optional(),
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
    bridgeToken: env.TDMCP_BRIDGE_TOKEN || undefined,
  });
}

/** Base URL for the TouchDesigner REST bridge. */
export function tdBaseUrl(config: Pick<TdmcpConfig, "tdHost" | "tdPort">): string {
  return `http://${config.tdHost}:${config.tdPort}`;
}
