import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTdmcpServer } from "../../src/server/tdmcpServer.js";
import {
  httpHostProtectionOptions,
  isCrossOriginRejected,
  isHttpBearerAuthorized,
  isUnsupportedPostMediaType,
  startTransport,
  type TransportHandle,
} from "../../src/server/transportFactory.js";
import { loadConfig } from "../../src/utils/config.js";
import { silentLogger } from "../../src/utils/logger.js";

const PORT = 39411;
let handle: TransportHandle;

beforeAll(async () => {
  const config = loadConfig({ TDMCP_TRANSPORT: "http", TDMCP_HTTP_PORT: String(PORT) });
  handle = await startTransport(
    () => createTdmcpServer(config, { logger: silentLogger }),
    config,
    silentLogger,
  );
});

afterAll(async () => {
  await handle.close();
});

describe("integration: Streamable HTTP transport", () => {
  it("keeps Host protection on loopback and disables it for explicit wildcard binds", () => {
    expect(httpHostProtectionOptions("127.0.0.1", PORT)).toEqual({
      enableDnsRebindingProtection: true,
      allowedHosts: [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`],
    });
    expect(httpHostProtectionOptions("0.0.0.0", PORT)).toEqual({
      enableDnsRebindingProtection: false,
      allowedHosts: [],
    });
    expect(httpHostProtectionOptions("::", PORT)).toEqual({
      enableDnsRebindingProtection: false,
      allowedHosts: [],
    });
    expect(httpHostProtectionOptions("127.0.0.1", 80)).toEqual({
      enableDnsRebindingProtection: true,
      allowedHosts: ["127.0.0.1:80", "localhost:80", "[::1]:80", "127.0.0.1", "localhost", "[::1]"],
    });
    expect(httpHostProtectionOptions("192.168.1.20", PORT)).toEqual({
      enableDnsRebindingProtection: true,
      allowedHosts: [
        `127.0.0.1:${PORT}`,
        `localhost:${PORT}`,
        `[::1]:${PORT}`,
        `192.168.1.20:${PORT}`,
      ],
    });
    expect(httpHostProtectionOptions("fd00::20", 80)).toEqual({
      enableDnsRebindingProtection: true,
      allowedHosts: [
        "127.0.0.1:80",
        "localhost:80",
        "[::1]:80",
        "[fd00::20]:80",
        "127.0.0.1",
        "localhost",
        "[::1]",
        "[fd00::20]",
      ],
    });
  });

  it("serves MCP over HTTP and lists tools", async () => {
    const client = new Client({ name: "tdmcp-http-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`));
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(31);
    expect(tools.map((t) => t.name)).toContain("get_td_info");

    await client.close();
  });

  it("rejects a non-initialize POST without a session", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for paths other than /mcp", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/not-mcp`);
    expect(res.status).toBe(404);
  });

  it("rejects a GET without a session id", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, { method: "GET" });
    expect(res.status).toBe(400);
  });

  it("rejects a request bearing a non-loopback Origin with 403", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://evil.example.com",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(403);
  });

  it("allows a loopback Origin", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: `http://127.0.0.1:${PORT}`,
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    // Not 403: passes the Origin gate (400 = no session, which is the expected next step).
    expect(res.status).not.toBe(403);
  });

  it("rejects a POST with a non-JSON Content-Type with 415", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "not json",
    });
    expect(res.status).toBe(415);
  });

  it("rejects an oversized JSON body before MCP session handling", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: "x".repeat(1_048_576) }),
    });
    expect(res.status).toBe(413);
  });

  it("returns a bounded 400 for malformed JSON", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    expect(res.status).toBe(400);
  });
});

describe("HTTP transport guards (unit)", () => {
  it("isCrossOriginRejected: only non-loopback origins are rejected", () => {
    expect(isCrossOriginRejected(undefined)).toBe(false);
    expect(isCrossOriginRejected("http://127.0.0.1:39411")).toBe(false);
    expect(isCrossOriginRejected("http://localhost")).toBe(false);
    expect(isCrossOriginRejected("http://evil.example.com")).toBe(true);
    expect(isCrossOriginRejected("garbage")).toBe(true);
  });

  it("isUnsupportedPostMediaType: only non-JSON POST bodies are rejected", () => {
    expect(isUnsupportedPostMediaType("POST", "application/json")).toBe(false);
    expect(isUnsupportedPostMediaType("POST", "application/json; charset=utf-8")).toBe(false);
    expect(isUnsupportedPostMediaType("POST", "text/plain")).toBe(true);
    expect(isUnsupportedPostMediaType("POST", undefined)).toBe(false);
    expect(isUnsupportedPostMediaType("GET", "text/plain")).toBe(false);
  });

  it("isHttpBearerAuthorized: only a correct Bearer token passes", () => {
    expect(isHttpBearerAuthorized("Bearer s3cret", "s3cret")).toBe(true);
    expect(isHttpBearerAuthorized("Bearer wrong", "s3cret")).toBe(false);
    expect(isHttpBearerAuthorized("s3cret", "s3cret")).toBe(false); // no Bearer prefix
    expect(isHttpBearerAuthorized(undefined, "s3cret")).toBe(false);
    // Scheme is case-insensitive and surrounding whitespace is tolerated (RFC 7235).
    expect(isHttpBearerAuthorized("bearer s3cret", "s3cret")).toBe(true);
    expect(isHttpBearerAuthorized("  Bearer   s3cret  ", "s3cret")).toBe(true);
  });
});

describe("integration: Streamable HTTP transport OAuth bearer", () => {
  const AUTH_PORT = 39412;
  let authHandle: TransportHandle;

  beforeAll(async () => {
    const config = loadConfig({
      TDMCP_TRANSPORT: "http",
      TDMCP_HTTP_PORT: String(AUTH_PORT),
      TDMCP_HTTP_AUTH_TOKEN: "s3cret",
    });
    authHandle = await startTransport(
      () => createTdmcpServer(config, { logger: silentLogger }),
      config,
      silentLogger,
    );
  });

  afterAll(async () => {
    await authHandle.close();
  });

  const post = (headers: Record<string, string>) =>
    fetch(`http://127.0.0.1:${AUTH_PORT}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

  it("returns 401 with a WWW-Authenticate challenge when the token is missing", async () => {
    const res = await post({});
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
  });

  it("returns 401 for a wrong token", async () => {
    const res = await post({ authorization: "Bearer nope" });
    expect(res.status).toBe(401);
  });

  it("passes auth with the correct token (no 401)", async () => {
    const res = await post({
      authorization: "Bearer s3cret",
      accept: "application/json, text/event-stream",
    });
    expect(res.status).not.toBe(401);
  });
});

describe("integration: explicit HTTP auth policy", () => {
  const HYBRID_PORT = 39415;
  let hybridHandle: TransportHandle;
  let stateRoot: string;

  beforeAll(async () => {
    stateRoot = mkdtempSync(join(tmpdir(), "tdmcp-oauth-policy-"));
    const config = loadConfig({
      TDMCP_TRANSPORT: "http",
      TDMCP_HTTP_PORT: String(HYBRID_PORT),
      TDMCP_HTTP_AUTH_MODE: "hybrid",
      TDMCP_HTTP_AUTH_TOKEN: "migration-secret",
      TDMCP_PUBLIC_BASE_URL: `http://127.0.0.1:${HYBRID_PORT}`,
      TDMCP_OAUTH_ALLOW_INSECURE_LOOPBACK: "1",
      TDMCP_OAUTH_STATE_DIR: join(stateRoot, "hybrid"),
    });
    hybridHandle = await startTransport(
      () => createTdmcpServer(config, { logger: silentLogger }),
      config,
      silentLogger,
    );
  });

  afterAll(async () => {
    await hybridHandle.close();
    rmSync(stateRoot, { force: true, recursive: true });
  });

  it("keeps legacy static bearer access only in explicit hybrid migration mode", async () => {
    const response = await fetch(`http://127.0.0.1:${HYBRID_PORT}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer migration-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(response.status).not.toBe(401);
  });

  it.each([
    [{ TDMCP_HTTP_AUTH_MODE: "oauth" }, "TDMCP_PUBLIC_BASE_URL is required for OAuth HTTP auth"],
    [
      {
        TDMCP_HTTP_AUTH_MODE: "oauth",
        TDMCP_HTTP_AUTH_TOKEN: "must-not-be-ignored",
        TDMCP_PUBLIC_BASE_URL: "http://127.0.0.1:39416",
        TDMCP_OAUTH_ALLOW_INSECURE_LOOPBACK: "1",
      },
      "OAuth mode refuses TDMCP_HTTP_AUTH_TOKEN",
    ],
    [
      {
        TDMCP_HTTP_AUTH_MODE: "hybrid",
        TDMCP_PUBLIC_BASE_URL: "http://127.0.0.1:39417",
        TDMCP_OAUTH_ALLOW_INSECURE_LOOPBACK: "1",
      },
      "Hybrid HTTP auth requires TDMCP_HTTP_AUTH_TOKEN",
    ],
    [
      { TDMCP_HTTP_AUTH_MODE: "none", TDMCP_HTTP_AUTH_TOKEN: "must-not-be-ignored" },
      "HTTP auth mode none refuses an ignored TDMCP_HTTP_AUTH_TOKEN",
    ],
  ])("fails startup instead of silently downgrading: %s", async (overrides, message) => {
    const config = loadConfig({
      TDMCP_TRANSPORT: "http",
      TDMCP_HTTP_PORT: "39416",
      ...overrides,
    });
    await expect(
      startTransport(
        () => createTdmcpServer(config, { logger: silentLogger }),
        config,
        silentLogger,
      ),
    ).rejects.toThrow(message);
  });

  it("rejects insecure OAuth on localhost or wildcard binds", async () => {
    const config = loadConfig({
      TDMCP_TRANSPORT: "http",
      TDMCP_HTTP_PORT: "39417",
      TDMCP_HTTP_HOST: "0.0.0.0",
      TDMCP_HTTP_AUTH_MODE: "oauth",
      TDMCP_PUBLIC_BASE_URL: "http://127.0.0.1:39417",
      TDMCP_OAUTH_ALLOW_INSECURE_LOOPBACK: "1",
      TDMCP_OAUTH_STATE_DIR: join(stateRoot, "unsafe-bind"),
    });
    await expect(
      startTransport(
        () => createTdmcpServer(config, { logger: silentLogger }),
        config,
        silentLogger,
      ),
    ).rejects.toThrow("must bind numeric loopback");
  });

  it("rejects a wildcard cleartext server even when the canonical issuer is HTTPS", async () => {
    const config = loadConfig({
      TDMCP_TRANSPORT: "http",
      TDMCP_HTTP_PORT: "39418",
      TDMCP_HTTP_HOST: "0.0.0.0",
      TDMCP_HTTP_AUTH_MODE: "oauth",
      TDMCP_PUBLIC_BASE_URL: "https://tdmcp.example",
      TDMCP_OAUTH_STATE_DIR: join(stateRoot, "unsafe-https-bind"),
    });
    await expect(
      startTransport(
        () => createTdmcpServer(config, { logger: silentLogger }),
        config,
        silentLogger,
      ),
    ).rejects.toThrow("must bind numeric loopback");
  });

  it("wires bounded trusted proxy hops into the OAuth source gate", async () => {
    const port = 39421;
    const base = `http://127.0.0.1:${port}`;
    const config = loadConfig({
      TDMCP_TRANSPORT: "http",
      TDMCP_HTTP_PORT: String(port),
      TDMCP_HTTP_AUTH_MODE: "oauth",
      TDMCP_PUBLIC_BASE_URL: base,
      TDMCP_OAUTH_ALLOW_INSECURE_LOOPBACK: "1",
      TDMCP_OAUTH_STATE_DIR: join(stateRoot, "trusted-proxy"),
      TDMCP_OAUTH_TRUSTED_PROXY_HOPS: "127.0.0.1",
      TDMCP_EVENTS: "off",
    });
    const handle = await startTransport(
      () => createTdmcpServer(config, { logger: silentLogger }),
      config,
      silentLogger,
    );
    try {
      expect(
        (
          await fetch(`${base}/.well-known/oauth-protected-resource/mcp`, {
            headers: {
              "x-forwarded-for": "198.51.100.30",
              "x-forwarded-host": `127.0.0.1:${port}`,
              "x-forwarded-port": String(port),
              "x-forwarded-proto": "http",
            },
          })
        ).status,
      ).toBe(200);
      expect((await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).status).toBe(403);
    } finally {
      await handle.close();
    }
  });
});

describe("integration: bounded HTTP abuse and session initialization", () => {
  const CAPACITY_PORT = 39419;
  const FAILURE_PORT = 39420;
  let capacityHandle: TransportHandle;
  let failureHandle: TransportHandle;

  beforeAll(async () => {
    const capacityConfig = loadConfig({
      TDMCP_TRANSPORT: "http",
      TDMCP_HTTP_PORT: String(CAPACITY_PORT),
      TDMCP_EVENTS: "off",
    });
    capacityHandle = await startTransport(
      () => new McpServer({ name: "capacity-test", version: "0.0.0" }),
      capacityConfig,
      silentLogger,
    );
    const failureConfig = loadConfig({
      TDMCP_TRANSPORT: "http",
      TDMCP_HTTP_PORT: String(FAILURE_PORT),
      TDMCP_HTTP_AUTH_MODE: "static",
      TDMCP_HTTP_AUTH_TOKEN: "expected-secret",
      TDMCP_EVENTS: "off",
    });
    failureHandle = await startTransport(
      () => new McpServer({ name: "auth-rate-test", version: "0.0.0" }),
      failureConfig,
      silentLogger,
    );
  });

  afterAll(async () => {
    await capacityHandle.close();
    await failureHandle.close();
  });

  it("reserves initialization capacity before awaiting concurrent handshakes", async () => {
    const statuses = await Promise.all(
      Array.from({ length: 65 }, async (_value, index) => {
        const response = await fetch(`http://127.0.0.1:${CAPACITY_PORT}/mcp`, {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: index + 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              clientInfo: { name: `capacity-${index}`, version: "0.0.0" },
            },
          }),
        });
        await response.text();
        return response.status;
      }),
    );
    expect(statuses.filter((status) => status === 200)).toHaveLength(64);
    expect(statuses.filter((status) => status === 429)).toHaveLength(1);
  });

  it("rate-limits repeated authentication failures without reading MCP bodies", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 61; attempt += 1) {
      const response = await fetch(`http://127.0.0.1:${FAILURE_PORT}/mcp`, {
        method: "POST",
        headers: {
          authorization: "Bearer wrong-secret",
          "content-type": "application/json",
        },
        body: "{body-is-never-read",
      });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 60).every((status) => status === 401)).toBe(true);
    expect(statuses[60]).toBe(429);
  });
});

describe("integration: opt-in OAuth PKCE with TD-native consent", () => {
  const OAUTH_PORT = 39413;
  const BRIDGE_PORT = 39414;
  const OAUTH_BASE = `http://127.0.0.1:${OAUTH_PORT}`;
  const REDIRECT = "http://127.0.0.1:49152/callback";
  let oauthHandle: TransportHandle;
  let bridgeServer: HttpServer;
  let stateRoot: string;
  const bridgeAuth: string[] = [];
  const bridgeBodies: string[] = [];

  beforeAll(async () => {
    stateRoot = mkdtempSync(join(tmpdir(), "tdmcp-oauth-integration-"));
    bridgeServer = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        bridgeAuth.push(req.headers.authorization ?? "");
        bridgeBodies.push(raw);
        res.setHeader("content-type", "application/json");
        if (req.method === "POST" && req.url === "/api/interactions") {
          res.end(
            JSON.stringify({
              ok: true,
              data: {
                request_id: "oauth_interaction_1234567890",
                kind: "oauth_client_consent",
                state: "resolved",
                choices: ["Allow", "Deny"],
                created_at: 1,
                expires_at: 61,
                consumed: false,
                result: { choice: "Allow", reason: "user_choice", at: 2 },
              },
            }),
          );
          return;
        }
        if (
          req.method === "POST" &&
          req.url === "/api/oauth/consents/oauth_interaction_1234567890/consume"
        ) {
          res.end(
            JSON.stringify({
              ok: true,
              data: {
                request_id: "oauth_interaction_1234567890",
                state: "resolved",
                accepted: true,
                decision: "Allow",
                error: null,
              },
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, error: { code: "not_found", message: "not found" } }));
      });
    });
    await new Promise<void>((resolve) => bridgeServer.listen(BRIDGE_PORT, "127.0.0.1", resolve));

    const config = loadConfig({
      TDMCP_TRANSPORT: "http",
      TDMCP_HTTP_PORT: String(OAUTH_PORT),
      TDMCP_HTTP_AUTH_MODE: "oauth",
      TDMCP_PUBLIC_BASE_URL: OAUTH_BASE,
      TDMCP_OAUTH_ALLOW_INSECURE_LOOPBACK: "1",
      TDMCP_OAUTH_STATE_DIR: join(stateRoot, "oauth-state"),
      TDMCP_TD_PORT: String(BRIDGE_PORT),
      TDMCP_BRIDGE_TOKEN: "bridge-secret",
    });
    oauthHandle = await startTransport(
      () => createTdmcpServer(config, { logger: silentLogger }),
      config,
      silentLogger,
    );
  });

  afterAll(async () => {
    await oauthHandle.close();
    await new Promise<void>((resolve) => bridgeServer.close(() => resolve()));
    rmSync(stateRoot, { force: true, recursive: true });
  });

  async function issueToken(clientName: string): Promise<{
    accessToken: string;
    refreshToken: string;
    clientId: string;
  }> {
    const registered = await fetch(`${OAUTH_BASE}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://127.0.0.1:3000/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: clientName,
        scope: "tdmcp:access",
      }),
    });
    expect(registered.status).toBe(201);
    const { client_id } = (await registered.json()) as { client_id: string };
    const verifier = "v".repeat(64);
    const authorize = new URL(`${OAUTH_BASE}/authorize`);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", client_id);
    authorize.searchParams.set("redirect_uri", REDIRECT);
    authorize.searchParams.set(
      "code_challenge",
      createHash("sha256").update(verifier).digest("base64url"),
    );
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("scope", "tdmcp:access");
    authorize.searchParams.set("state", `state-${clientName}`);
    authorize.searchParams.set("resource", `${OAUTH_BASE}/mcp`);
    const pending = await fetch(authorize, { redirect: "manual" });
    expect(pending.status).toBe(202);
    const html = await pending.text();
    expect(html).not.toContain(verifier);
    const statusPath = html.match(/\/oauth\/consent\/[^/]+\/status/u)?.[0];
    expect(statusPath).toBeTruthy();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await fetch(`${OAUTH_BASE}${statusPath}`);
      const status = (await response.json()) as { status?: string };
      if (status.status === "ready") break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    const completed = await fetch(
      `${OAUTH_BASE}${statusPath?.replace(/\/status$/u, "/complete")}`,
      { redirect: "manual" },
    );
    expect(completed.status).toBe(302);
    const code = new URL(completed.headers.get("location") ?? "").searchParams.get("code");
    expect(code).toBeTruthy();
    const token = await fetch(`${OAUTH_BASE}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id,
        code: code as string,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        resource: `${OAUTH_BASE}/mcp`,
      }),
    });
    expect(token.status).toBe(200);
    const issued = (await token.json()) as { access_token: string; refresh_token: string };
    return {
      accessToken: issued.access_token,
      refreshToken: issued.refresh_token,
      clientId: client_id,
    };
  }

  it("rejects hostile OAuth Host and Origin headers before discovery routing", async () => {
    const wrongOrigin = await fetch(`${OAUTH_BASE}/.well-known/oauth-protected-resource/mcp`, {
      headers: { origin: "https://evil.example" },
    });
    expect(wrongOrigin.status).toBe(403);

    const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest({
        host: "127.0.0.1",
        port: OAUTH_PORT,
        path: "/.well-known/oauth-protected-resource/mcp",
        headers: { host: "evil.example" },
      });
      request.on("response", (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      request.on("error", reject);
      request.end();
    });
    expect(wrongHost).toBe(403);
  });

  it("uses path-specific metadata, TD consent and a client-bound MCP session", async () => {
    const missing = await fetch(`${OAUTH_BASE}/mcp`, { method: "GET" });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain(
      `resource_metadata="${OAUTH_BASE}/.well-known/oauth-protected-resource/mcp"`,
    );
    expect((await fetch(`${OAUTH_BASE}/.well-known/oauth-protected-resource`)).status).toBe(404);

    const firstToken = await issueToken("First client");
    const transport = new StreamableHTTPClientTransport(new URL(`${OAUTH_BASE}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${firstToken.accessToken}` } },
    });
    const client = new Client({ name: "oauth-integration", version: "0.0.0" });
    await client.connect(transport);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    expect(transport.sessionId).toBeTruthy();

    const refreshed = await fetch(`${OAUTH_BASE}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: firstToken.clientId,
        refresh_token: firstToken.refreshToken,
        resource: `${OAUTH_BASE}/mcp`,
      }),
    });
    expect(refreshed.status).toBe(200);
    const refreshedAccess = ((await refreshed.json()) as { access_token: string }).access_token;
    const samePrincipal = await fetch(`${OAUTH_BASE}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${refreshedAccess}`,
        "content-type": "application/json",
        "mcp-session-id": transport.sessionId as string,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 23, method: "tools/list", params: {} }),
    });
    expect(samePrincipal.status).toBe(200);

    const secondToken = await issueToken("Second client");
    const mismatch = await fetch(`${OAUTH_BASE}/mcp`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${secondToken.accessToken}`,
        "mcp-session-id": transport.sessionId as string,
      },
    });
    expect(mismatch.status).toBe(403);
    await client.close();

    expect(bridgeAuth.length).toBeGreaterThanOrEqual(4);
    expect(new Set(bridgeAuth)).toEqual(new Set(["Bearer bridge-secret"]));
    const bridgeText = bridgeBodies.join("\n");
    expect(bridgeText).not.toContain(firstToken.accessToken);
    expect(bridgeText).not.toContain(firstToken.refreshToken);
    expect(bridgeText).not.toContain(refreshedAccess);
    expect(bridgeText).not.toContain(secondToken.accessToken);
    expect(bridgeText).not.toContain("code_verifier");
  });
});

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
  request as httpRequest,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
