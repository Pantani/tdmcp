import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { type TdEvent, TdEventStream } from "../td-client/eventStream.js";
import { type TdmcpConfig, tdBaseUrl } from "../utils/config.js";
import type { Logger } from "../utils/logger.js";

/** A running transport plus a way to shut it down cleanly. */
export interface TransportHandle {
  close: () => Promise<void>;
}

const MCP_PATH = "/mcp";

/** Forwards one TD event to a connected MCP client as a logging notification. */
function forwardEvent(server: McpServer, event: TdEvent): void {
  const level = event.event === "node.error" ? "error" : "info";
  void server.sendLoggingMessage({ level, logger: "touchdesigner", data: event }).catch(() => {
    // client may not support logging or not be connected yet — ignore
  });
}

/** Opens the TD event stream (if enabled) and routes each event to `onEvent`. */
function createEventStream(
  config: TdmcpConfig,
  logger: Logger,
  onEvent: (event: TdEvent) => void,
): TdEventStream | undefined {
  if (config.events !== "on") return undefined;
  // The platform WebSocket constructor cannot set an Authorization header and
  // the TouchDesigner callback has no authenticated handshake hook. Do not
  // open an unauthenticated event channel while REST auth is enabled.
  if (config.bridgeToken) {
    logger.warn(
      "TDMCP_EVENTS disabled because the bridge token cannot be sent securely over WebSocket",
    );
    return undefined;
  }
  const url = `${tdBaseUrl(config).replace(/^http/, "ws")}/`;
  const stream = new TdEventStream({ url, logger, onEvent });
  stream.start();
  return stream;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * True when a browser-set `Origin` is present and is NOT loopback — a cross-site
 * page trying to drive the local MCP server (DNS-rebinding / CSRF). A missing
 * Origin (the SDK client, curl, same-origin) is allowed; an unparseable Origin is
 * rejected. Complements the SDK's Host-based `enableDnsRebindingProtection`.
 */
export function isCrossOriginRejected(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    return !LOOPBACK_HOSTS.has(new URL(origin).hostname);
  } catch {
    return true;
  }
}

/** Host-header protection options for loopback versus explicitly wildcard HTTP binds. */
export function httpHostProtectionOptions(
  httpHost: string,
  httpPort: number,
): {
  enableDnsRebindingProtection: boolean;
  allowedHosts: string[];
} {
  const isWildcard = httpHost === "0.0.0.0" || httpHost === "::";
  return {
    enableDnsRebindingProtection: !isWildcard,
    allowedHosts: isWildcard
      ? []
      : [`127.0.0.1:${httpPort}`, `localhost:${httpPort}`, `[::1]:${httpPort}`],
  };
}

/**
 * True when a POST carries a Content-Type that is present and not `application/json`
 * — reject with 415. A missing Content-Type is left for the normal flow (the SDK
 * client always sends JSON); non-POST methods are never rejected here.
 */
export function isUnsupportedPostMediaType(
  method: string | undefined,
  contentType: string | undefined,
): boolean {
  if (method !== "POST" || !contentType) return false;
  return !/^application\/json\b/i.test(contentType.trim());
}

/**
 * Validates an `Authorization: Bearer <token>` header against the expected token in
 * constant time. The enforcement half of an MCP OAuth2 Resource Server (static
 * pre-shared token — no AS/discovery). Returns false on a missing/malformed header
 * or a mismatch.
 */
export function isHttpBearerAuthorized(authHeader: string | undefined, token: string): boolean {
  if (!authHeader) return false;
  // The auth scheme is case-insensitive (RFC 7235) and may carry extra whitespace.
  const match = /^\s*Bearer\s+(.+?)\s*$/i.exec(authHeader);
  if (!match) return false;
  const provided = Buffer.from(match[1] as string);
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** Sends a 401 with an OAuth2 `WWW-Authenticate: Bearer` challenge. */
function sendUnauthorized(res: ServerResponse, error: string): void {
  res.writeHead(401, {
    "content-type": "application/json",
    "www-authenticate": `Bearer error="${error}"`,
  });
  res.end(JSON.stringify({ error: "Unauthorized: a valid Bearer token is required." }));
}

/**
 * Runs the cheap request gates before session handling: wrong path (404), a
 * non-loopback Origin (403), a non-JSON POST body (415), or (when a token is
 * configured) a missing/invalid Bearer (401). Returns true and sends the rejection
 * when the request is refused, else false.
 */
function rejectPreflight(
  config: TdmcpConfig,
  pathname: string,
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if (pathname !== MCP_PATH) {
    sendJson(res, 404, { error: "Not found. MCP endpoint is at /mcp." });
    return true;
  }
  if (isCrossOriginRejected(req.headers.origin)) {
    sendJson(res, 403, { error: "Cross-origin request rejected (non-loopback Origin)." });
    return true;
  }
  if (isUnsupportedPostMediaType(req.method, req.headers["content-type"])) {
    sendJson(res, 415, { error: "Unsupported Media Type: POST body must be application/json." });
    return true;
  }
  if (
    config.httpAuthToken &&
    !isHttpBearerAuthorized(req.headers.authorization, config.httpAuthToken)
  ) {
    sendUnauthorized(res, req.headers.authorization ? "invalid_token" : "missing_token");
    return true;
  }
  return false;
}

function startStdio(
  createMcpServer: () => McpServer,
  config: TdmcpConfig,
  logger: Logger,
): TransportHandle {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  void server.connect(transport);
  logger.info("tdmcp connected over stdio");

  const events = createEventStream(config, logger, (event) => forwardEvent(server, event));

  return {
    close: async () => {
      events?.close();
      await server.close();
    },
  };
}

/**
 * Stateful Streamable HTTP transport: one MCP server + transport per session,
 * keyed by the `mcp-session-id` header. Sessions are created on an `initialize`
 * POST and torn down on transport close or DELETE.
 */
async function startHttp(
  createMcpServer: () => McpServer,
  config: TdmcpConfig,
  logger: Logger,
): Promise<TransportHandle> {
  const httpHost = config.httpHost ?? "127.0.0.1";
  const hostProtection = httpHostProtectionOptions(httpHost, config.httpPort);
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const servers = new Map<string, McpServer>();
  const events = createEventStream(config, logger, (event) => {
    for (const sessionServer of servers.values()) forwardEvent(sessionServer, event);
  });

  const httpServer: Server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      logger.error("HTTP request failed", { error: String(err) });
      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (rejectPreflight(config, url.pathname, req, res)) return;
    const sessionId = req.headers["mcp-session-id"];
    const existing = typeof sessionId === "string" ? transports.get(sessionId) : undefined;

    if (req.method === "POST") {
      const body = await readBody(req);
      if (!existing) {
        if (!isInitializeRequest(body)) {
          sendJson(res, 400, {
            jsonrpc: "2.0",
            error: { code: -32000, message: "No valid session; send an initialize request first." },
            id: null,
          });
          return;
        }
        const sessionServer = createMcpServer();
        const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, created);
            servers.set(id, sessionServer);
          },
          // Loopback binds reject non-loopback Host headers. Explicit wildcard
          // container binds accept the address used by the remote client; the
          // Origin check above still rejects cross-site browser requests.
          ...hostProtection,
        });
        created.onclose = () => {
          if (created.sessionId) {
            transports.delete(created.sessionId);
            servers.delete(created.sessionId);
          }
        };
        try {
          await sessionServer.connect(created);
          await created.handleRequest(req, res, body);
        } catch (err) {
          // If the session never reached `onsessioninitialized` it is not tracked
          // in `transports`/`servers`, so the McpServer would leak. Close it.
          if (!created.sessionId || !servers.has(created.sessionId)) {
            await sessionServer.close().catch(() => {
              // already-closed / partial state — surface only as debug
            });
          }
          throw err;
        }
        return;
      }
      await existing.handleRequest(req, res, body);
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      if (!existing) {
        sendJson(res, 400, { error: "Unknown or missing mcp-session-id." });
        return;
      }
      await existing.handleRequest(req, res);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed." });
  }

  // Bind to loopback by default so HTTP isn't unexpectedly exposed. Containers
  // opt into 0.0.0.0 explicitly through TDMCP_HTTP_HOST; Host/Origin checks and
  // optional bearer auth remain enforced by the request path above.
  // Wrap listen() in a Promise so EADDRINUSE (port already bound) surfaces as a
  // clean rejection at startup instead of an unhandled 'error' event that would
  // crash the whole server process the moment listen reports back.
  try {
    await new Promise<void>((resolve, reject) => {
      const onListenError = (err: Error): void => {
        httpServer.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = (): void => {
        httpServer.removeListener("error", onListenError);
        logger.info("tdmcp listening over Streamable HTTP", {
          host: httpHost,
          port: config.httpPort,
          path: MCP_PATH,
        });
        resolve();
      };
      httpServer.once("error", onListenError);
      httpServer.once("listening", onListening);
      httpServer.listen(config.httpPort, httpHost);
    });
  } catch (err) {
    // The event stream was started above (before we knew whether the HTTP port
    // would be free); on a listen failure no TransportHandle is returned to
    // the caller, so without an explicit close here a reconnecting WebSocket
    // would keep the process alive after the CLI sets process.exitCode.
    events?.close();
    throw err;
  }

  // Post-listen errors (a transient socket-level error) must not kill the process.
  httpServer.on("error", (err) => {
    logger.error("HTTP transport server error", { error: String(err) });
  });

  return {
    close: async () => {
      events?.close();
      for (const transport of transports.values()) await transport.close();
      transports.clear();
      servers.clear();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

/**
 * Connects the MCP server to a transport based on config. `stdio` is the default;
 * `http` serves Streamable HTTP. Returns a handle for clean shutdown.
 */
export async function startTransport(
  createMcpServer: () => McpServer,
  config: TdmcpConfig,
  logger: Logger,
): Promise<TransportHandle> {
  if (config.transport === "http") {
    return startHttp(createMcpServer, config, logger);
  }
  return startStdio(createMcpServer, config, logger);
}
