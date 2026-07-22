import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { type Express } from "express";
import { type TdEvent, TdEventStream } from "../td-client/eventStream.js";
import { TouchDesignerClient } from "../td-client/touchDesignerClient.js";
import {
  type HttpAuthMode,
  resolveHttpAuthMode,
  type TdmcpConfig,
  tdBaseUrl,
} from "../utils/config.js";
import type { Logger } from "../utils/logger.js";
import {
  createOAuthPolicy,
  createTdmcpOAuthRouter,
  OAUTH_SCOPE,
  type OAuthPolicy,
  OAuthStateStore,
  TdmcpOAuthProvider,
} from "./oauth/index.js";

/** A running transport plus a way to shut it down cleanly. */
export interface TransportHandle {
  close: () => Promise<void>;
}

const MCP_PATH = "/mcp";
const MAX_HTTP_SESSIONS = 64;
const MCP_REQUESTS_PER_MINUTE = 600;
const AUTH_FAILURES_PER_MINUTE = 60;
const INITIALIZATIONS_PER_MINUTE = 64;
const HTTP_SESSION_IDLE_TTL_MS = 15 * 60 * 1_000;
const HTTP_SESSION_SWEEP_MS = 60 * 1_000;

interface FixedWindowCounter {
  blocked(): boolean;
  take(): boolean;
  add(): void;
}

function fixedWindowCounter(limit: number, windowMs: number): FixedWindowCounter {
  let windowStartedAt = Date.now();
  let count = 0;
  const reset = (): void => {
    const now = Date.now();
    if (now - windowStartedAt < windowMs) return;
    windowStartedAt = now;
    count = 0;
  };
  return {
    blocked: () => {
      reset();
      return count >= limit;
    },
    take: () => {
      reset();
      if (count >= limit) return false;
      count += 1;
      return true;
    },
    add: () => {
      reset();
      count += 1;
    },
  };
}

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

class HttpRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpRequestError";
  }
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const rawLength = req.headers["content-length"];
    if (typeof rawLength === "string") {
      const declared = Number(rawLength);
      if (!Number.isSafeInteger(declared) || declared < 0) {
        reject(new HttpRequestError(400, "Invalid Content-Length."));
        return;
      }
      if (declared > maxBytes) {
        reject(new HttpRequestError(413, "Request body exceeds the configured limit."));
        return;
      }
    }
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    const cleanup = (): void => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      // Drain the remainder without buffering it so the server can return the
      // bounded 4xx response instead of turning overflow into a socket reset.
      req.resume();
      reject(error);
    };
    const onData = (raw: Buffer | string): void => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      received += chunk.byteLength;
      if (received > maxBytes) {
        fail(new HttpRequestError(413, "Request body exceeds the configured limit."));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpRequestError(400, "Request body must be valid JSON."));
      }
    };
    const onError = (error: Error): void => fail(error);
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function sendRateLimited(res: ServerResponse): void {
  res.writeHead(429, {
    "cache-control": "no-store",
    "content-type": "application/json",
    "retry-after": "60",
  });
  res.end(JSON.stringify({ error: "HTTP request rate limit reached." }));
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

/** Host-header protection options for specific versus explicitly wildcard HTTP binds. */
export function httpHostProtectionOptions(
  httpHost: string,
  httpPort: number,
): {
  enableDnsRebindingProtection: boolean;
  allowedHosts: string[];
} {
  const isWildcard = httpHost === "0.0.0.0" || httpHost === "::";
  const configuredHost =
    httpHost.includes(":") && !httpHost.startsWith("[") ? `[${httpHost}]` : httpHost;
  const allowedHosts = new Set([
    `127.0.0.1:${httpPort}`,
    `localhost:${httpPort}`,
    `[::1]:${httpPort}`,
    `${configuredHost}:${httpPort}`,
  ]);
  if (httpPort === 80) {
    allowedHosts.add("127.0.0.1");
    allowedHosts.add("localhost");
    allowedHosts.add("[::1]");
    allowedHosts.add(configuredHost);
  }
  return {
    enableDnsRebindingProtection: !isWildcard,
    allowedHosts: isWildcard ? [] : [...allowedHosts],
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
 * constant time. This is legacy pre-shared bearer authentication, not OAuth.
 * Returns false on a missing/malformed header or a mismatch.
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

interface OAuthRuntime {
  app: Express;
  policy: OAuthPolicy;
  provider: TdmcpOAuthProvider;
  close: () => void;
}

interface RequestIdentity {
  key: string;
  authInfo?: AuthInfo;
}

function defaultOAuthStateDirectory(): string {
  const root = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(root, "tdmcp", "oauth");
}

function oauthModeEnabled(mode: HttpAuthMode): mode is "oauth" | "hybrid" {
  return mode === "oauth" || mode === "hybrid";
}

function validateOAuthModeConfig(config: TdmcpConfig, mode: "oauth" | "hybrid"): string {
  if (!config.publicBaseUrl) {
    throw new Error("TDMCP_PUBLIC_BASE_URL is required for OAuth HTTP auth.");
  }
  if (mode === "oauth" && config.httpAuthToken) {
    throw new Error(
      "OAuth mode refuses TDMCP_HTTP_AUTH_TOKEN; use explicit hybrid migration mode.",
    );
  }
  if (mode === "hybrid" && !config.httpAuthToken) {
    throw new Error("Hybrid HTTP auth requires TDMCP_HTTP_AUTH_TOKEN.");
  }
  if (config.oauthStateDir && !isAbsolute(config.oauthStateDir)) {
    throw new Error("TDMCP_OAUTH_STATE_DIR must be an absolute owner-private path.");
  }
  return config.publicBaseUrl;
}

function assertOAuthBindPolicy(config: TdmcpConfig): void {
  const bindHost = config.httpHost ?? "127.0.0.1";
  if (bindHost !== "127.0.0.1" && bindHost !== "::1") {
    throw new Error(
      "OAuth HTTP must bind numeric loopback; terminate public HTTPS at a trusted local reverse proxy.",
    );
  }
}

function oauthHostProtectionOptions(oauth: OAuthRuntime | undefined, host: string, port: number) {
  if (!oauth) return httpHostProtectionOptions(host, port);
  return {
    enableDnsRebindingProtection: true,
    allowedHosts: [oauth.policy.issuer.host],
  };
}

async function createOAuthRuntime(config: TdmcpConfig): Promise<OAuthRuntime | undefined> {
  const mode = resolveHttpAuthMode(config);
  if (!oauthModeEnabled(mode)) return undefined;
  const publicBaseUrl = validateOAuthModeConfig(config, mode);
  const policy = createOAuthPolicy({
    publicBaseUrl,
    stateDirectory: config.oauthStateDir ?? defaultOAuthStateDirectory(),
    allowInsecureLoopback: config.oauthAllowInsecureLoopback,
    redirectOrigins: config.oauthRedirectOrigins,
    trustedProxyHops: config.oauthTrustedProxyHops,
    accessTtlSeconds: config.oauthAccessTtlSeconds,
    refreshTtlSeconds: config.oauthRefreshTtlSeconds,
    consentTtlSeconds: config.oauthConsentTtlSeconds,
  });
  assertOAuthBindPolicy(config);
  const store = await OAuthStateStore.open(policy);
  const tdClient = new TouchDesignerClient({
    baseUrl: tdBaseUrl(config),
    timeoutMs: config.requestTimeoutMs,
    token: config.bridgeToken,
    retries: 0,
  });
  const provider = new TdmcpOAuthProvider({
    policy,
    store,
    consentRequester: (request) =>
      tdClient.requestOAuthConsent({
        transactionId: request.transactionId,
        clientId: request.clientId,
        clientName: request.clientName,
        redirectUri: request.redirectUri,
        registeredRedirectUris: request.registeredRedirectUris,
        allowedRedirectOrigins: request.allowedRedirectOrigins,
        resource: request.resource,
        scopes: request.scopes,
        ttlSeconds: request.ttlSeconds,
        signal: request.signal,
      }),
  });
  const app = express();
  app.disable("x-powered-by");
  app.use(createTdmcpOAuthRouter({ policy, provider, store }));
  return { app, policy, provider, close: () => provider.close() };
}

function explicitAuthModeIsValid(config: TdmcpConfig, mode: HttpAuthMode): void {
  if (mode === "static" && !config.httpAuthToken) {
    throw new Error("Static HTTP auth requires TDMCP_HTTP_AUTH_TOKEN.");
  }
  if (config.httpAuthMode === "none" && config.httpAuthToken) {
    throw new Error("HTTP auth mode none refuses an ignored TDMCP_HTTP_AUTH_TOKEN.");
  }
}

function bearerToken(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  return /^\s*Bearer\s+(.+?)\s*$/i.exec(authHeader)?.[1];
}

function staticRequestIdentity(
  config: TdmcpConfig,
  mode: HttpAuthMode,
  authHeader: string | undefined,
): RequestIdentity | undefined {
  if (mode !== "static" && mode !== "hybrid") return undefined;
  if (!config.httpAuthToken) return undefined;
  return isHttpBearerAuthorized(authHeader, config.httpAuthToken) ? { key: "static" } : undefined;
}

function sendOAuthAuthError(
  res: ServerResponse,
  policy: OAuthPolicy,
  status: 401 | 403,
  error: "invalid_token" | "insufficient_scope",
): void {
  const description =
    status === 401 ? "A valid OAuth bearer is required." : "OAuth scope is insufficient.";
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
    "www-authenticate":
      `Bearer error="${error}", scope="${OAUTH_SCOPE}", ` +
      `resource_metadata="${policy.resourceMetadataUrl.href}"`,
  });
  res.end(JSON.stringify({ error, error_description: description }));
}

async function authenticateMcpRequest(
  config: TdmcpConfig,
  mode: HttpAuthMode,
  oauth: OAuthRuntime | undefined,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<RequestIdentity | undefined> {
  if (mode === "none") return { key: "none" };
  const staticIdentity = staticRequestIdentity(config, mode, req.headers.authorization);
  if (staticIdentity) return staticIdentity;
  if (mode === "static") {
    sendUnauthorized(res, req.headers.authorization ? "invalid_token" : "missing_token");
    return undefined;
  }
  return authenticateOAuthBearer(oauth, req.headers.authorization, res);
}

async function authenticateOAuthBearer(
  oauth: OAuthRuntime | undefined,
  authHeader: string | undefined,
  res: ServerResponse,
): Promise<RequestIdentity | undefined> {
  if (!oauth) throw new Error("OAuth runtime was not initialized.");
  const token = bearerToken(authHeader);
  if (!token) {
    sendOAuthAuthError(res, oauth.policy, 401, "invalid_token");
    return undefined;
  }
  try {
    const authInfo = await oauth.provider.verifyAccessToken(token);
    if (authInfo.resource?.href !== oauth.policy.resource.href) {
      sendOAuthAuthError(res, oauth.policy, 401, "invalid_token");
      return undefined;
    }
    if (!authInfo.scopes.includes(OAUTH_SCOPE)) {
      sendOAuthAuthError(res, oauth.policy, 403, "insufficient_scope");
      return undefined;
    }
    return {
      key: `oauth:${authInfo.clientId}:${oauth.policy.resource.href}`,
      authInfo,
    };
  } catch {
    sendOAuthAuthError(res, oauth.policy, 401, "invalid_token");
    return undefined;
  }
}

function isOAuthRequestHostRejected(req: IncomingMessage, policy: OAuthPolicy): boolean {
  const hostCount = req.rawHeaders.reduce(
    (count, value, index) => count + (index % 2 === 0 && value.toLowerCase() === "host" ? 1 : 0),
    0,
  );
  return (
    hostCount !== 1 ||
    typeof req.headers.host !== "string" ||
    req.headers.host.toLowerCase() !== policy.issuer.host.toLowerCase()
  );
}

function isOAuthRequestOriginRejected(req: IncomingMessage, policy: OAuthPolicy): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).origin !== policy.issuer.origin;
  } catch {
    return true;
  }
}

/**
 * Runs the cheap request gates before session handling: wrong path (404), a
 * non-loopback Origin (403), or a non-JSON POST body (415). Authentication is
 * asynchronous in OAuth mode and runs immediately after these cheap gates.
 */
function rejectPreflight(
  pathname: string,
  req: IncomingMessage,
  res: ServerResponse,
  enforceLoopbackOrigin = true,
): boolean {
  if (pathname !== MCP_PATH) {
    sendJson(res, 404, { error: "Not found. MCP endpoint is at /mcp." });
    return true;
  }
  if (enforceLoopbackOrigin && isCrossOriginRejected(req.headers.origin)) {
    sendJson(res, 403, { error: "Cross-origin request rejected (non-loopback Origin)." });
    return true;
  }
  if (isUnsupportedPostMediaType(req.method, req.headers["content-type"])) {
    sendJson(res, 415, { error: "Unsupported Media Type: POST body must be application/json." });
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
  const authMode = resolveHttpAuthMode(config);
  explicitAuthModeIsValid(config, authMode);
  const oauth = await createOAuthRuntime(config);
  const hostProtection = oauthHostProtectionOptions(oauth, httpHost, config.httpPort);
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const servers = new Map<string, McpServer>();
  const sessionOwners = new Map<string, string>();
  const sessionLastSeen = new Map<string, number>();
  const closingSessions = new Set<string>();
  const requestRate = fixedWindowCounter(MCP_REQUESTS_PER_MINUTE, 60_000);
  const authFailures = fixedWindowCounter(AUTH_FAILURES_PER_MINUTE, 60_000);
  const initializationRate = fixedWindowCounter(INITIALIZATIONS_PER_MINUTE, 60_000);
  let pendingSessionInitializations = 0;
  const events = createEventStream(config, logger, (event) => {
    for (const sessionServer of servers.values()) forwardEvent(sessionServer, event);
  });

  const httpServer: Server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (err instanceof HttpRequestError) {
        if (!res.headersSent) sendJson(res, err.status, { error: err.message });
        return;
      }
      logger.error("HTTP request failed", {
        error_code: err instanceof Error ? err.name : "unknown_error",
      });
      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    });
  });

  function routeOAuthSurface(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
    if (!oauth) return false;
    const rejected =
      isOAuthRequestHostRejected(req, oauth.policy) ||
      isOAuthRequestOriginRejected(req, oauth.policy);
    if (rejected) {
      sendJson(res, 403, { error: "OAuth Host or Origin rejected." });
      return true;
    }
    if (pathname === MCP_PATH) return false;
    oauth.app(req, res);
    return true;
  }

  function sessionPrincipalMismatch(
    sessionId: string | undefined,
    identity: RequestIdentity,
  ): boolean {
    if (!sessionId || !transports.has(sessionId)) return false;
    return sessionOwners.get(sessionId) !== identity.key;
  }

  async function createInitializedSession(
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
    ownerKey: string,
  ): Promise<void> {
    const sessionServer = createMcpServer();
    const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, created);
        servers.set(id, sessionServer);
        sessionOwners.set(id, ownerKey);
        sessionLastSeen.set(id, Date.now());
      },
      // OAuth accepts only its configured canonical issuer Host. Legacy modes
      // retain the existing bind-derived Host protection contract.
      ...hostProtection,
    });
    created.onclose = () => {
      if (!created.sessionId) return;
      transports.delete(created.sessionId);
      servers.delete(created.sessionId);
      sessionOwners.delete(created.sessionId);
      sessionLastSeen.delete(created.sessionId);
      closingSessions.delete(created.sessionId);
    };
    try {
      await sessionServer.connect(created);
      await created.handleRequest(req, res, body);
    } catch (error) {
      const untracked = !created.sessionId || !servers.has(created.sessionId);
      if (untracked) await sessionServer.close().catch(() => undefined);
      throw error;
    }
  }

  async function handlePostRequest(
    req: IncomingMessage,
    res: ServerResponse,
    existing: StreamableHTTPServerTransport | undefined,
    identity: RequestIdentity,
  ): Promise<void> {
    const body = await readBody(req, config.httpBodyMaxBytes);
    if (existing) {
      await existing.handleRequest(req, res, body);
      return;
    }
    if (!isInitializeRequest(body)) {
      sendJson(res, 400, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "No valid session; send an initialize request first." },
        id: null,
      });
      return;
    }
    if (transports.size + pendingSessionInitializations >= MAX_HTTP_SESSIONS) {
      sendJson(res, 429, { error: "MCP session capacity reached." });
      return;
    }
    if (!initializationRate.take()) {
      sendRateLimited(res);
      return;
    }
    pendingSessionInitializations += 1;
    try {
      await createInitializedSession(req, res, body, identity.key);
    } finally {
      pendingSessionInitializations -= 1;
    }
  }

  async function handleSessionMethod(
    req: IncomingMessage,
    res: ServerResponse,
    existing: StreamableHTTPServerTransport | undefined,
  ): Promise<void> {
    if (req.method !== "GET" && req.method !== "DELETE") {
      sendJson(res, 405, { error: "Method not allowed." });
      return;
    }
    if (!existing) {
      sendJson(res, 400, { error: "Unknown or missing mcp-session-id." });
      return;
    }
    await existing.handleRequest(req, res);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Routing never derives OAuth issuer/resource identity from Host or forwarded
    // headers. The configured public base remains canonical.
    const url = new URL(req.url ?? "/", "http://localhost");
    if (routeOAuthSurface(req, res, url.pathname)) return;
    if (rejectPreflight(url.pathname, req, res, !oauth)) return;
    if (!requestRate.take() || authFailures.blocked()) {
      sendRateLimited(res);
      return;
    }
    const identity = await authenticateMcpRequest(config, authMode, oauth, req, res);
    if (!identity) {
      authFailures.add();
      return;
    }
    if (identity.authInfo) {
      (req as IncomingMessage & { auth?: AuthInfo }).auth = identity.authInfo;
    }
    const sessionHeader = req.headers["mcp-session-id"];
    const sessionId = typeof sessionHeader === "string" ? sessionHeader : undefined;
    const existing = sessionId ? transports.get(sessionId) : undefined;
    if (sessionPrincipalMismatch(sessionId, identity)) {
      sendJson(res, 403, { error: "MCP session principal mismatch." });
      return;
    }
    if (existing && sessionId) sessionLastSeen.set(sessionId, Date.now());
    if (req.method === "POST") {
      await handlePostRequest(req, res, existing, identity);
      return;
    }
    await handleSessionMethod(req, res, existing);
  }

  const sessionSweep = setInterval(() => {
    const expiredBefore = Date.now() - HTTP_SESSION_IDLE_TTL_MS;
    for (const [sessionId, lastSeen] of sessionLastSeen) {
      const transport = transports.get(sessionId);
      if (!transport || lastSeen > expiredBefore || closingSessions.has(sessionId)) continue;
      closingSessions.add(sessionId);
      void transport.close().catch(() => {
        closingSessions.delete(sessionId);
      });
    }
  }, HTTP_SESSION_SWEEP_MS);
  sessionSweep.unref();

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
    clearInterval(sessionSweep);
    oauth?.close();
    throw err;
  }

  // Post-listen errors (a transient socket-level error) must not kill the process.
  httpServer.headersTimeout = 10_000;
  httpServer.requestTimeout = 15_000;
  httpServer.on("error", (err) => {
    logger.error("HTTP transport server error", {
      error_code: err instanceof Error ? err.name : "unknown_error",
    });
  });

  return {
    close: async () => {
      events?.close();
      clearInterval(sessionSweep);
      for (const transport of transports.values()) await transport.close();
      transports.clear();
      servers.clear();
      sessionOwners.clear();
      oauth?.close();
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
