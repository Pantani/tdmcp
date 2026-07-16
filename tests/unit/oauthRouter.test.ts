import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as requestHttp, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import type { OAuthConsentRequest } from "../../src/server/oauth/consent.js";
import { createOAuthPolicy, OAUTH_SCOPE } from "../../src/server/oauth/policy.js";
import { TdmcpOAuthProvider } from "../../src/server/oauth/provider.js";
import {
  createOAuthBearerMiddleware,
  createTdmcpOAuthRouter,
} from "../../src/server/oauth/router.js";
import { OAuthStateStore } from "../../src/server/oauth/store.js";

const temporary: string[] = [];
const servers: Server[] = [];
const providers: TdmcpOAuthProvider[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  for (const provider of providers.splice(0)) provider.close();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function startFixture(
  options: {
    registrationLimitPerHour?: number;
    clock?: () => number;
    publicBaseUrl?: string;
    trustedProxyHops?: readonly string[];
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "tdmcp-oauth-router-"));
  temporary.push(root);
  const policy = createOAuthPolicy({
    publicBaseUrl: options.publicBaseUrl ?? "http://127.0.0.1:3939",
    stateDirectory: join(root, "state"),
    allowInsecureLoopback: true,
    trustedProxyHops: options.trustedProxyHops,
  });
  const store = await OAuthStateStore.open(policy);
  let consentRequest: OAuthConsentRequest | undefined;
  let resolveConsent: (choice: "Allow" | "Deny") => void = () => undefined;
  const provider = new TdmcpOAuthProvider({
    policy,
    store,
    consentRequester: async (request) => {
      consentRequest = request;
      return new Promise((resolve) => {
        resolveConsent = resolve;
      });
    },
  });
  providers.push(provider);
  const app = express();
  app.disable("x-powered-by");
  app.use(createTdmcpOAuthRouter({ policy, provider, store, ...options }));
  app.get("/protected", createOAuthBearerMiddleware(policy, provider), (_req, res) => {
    res.status(200).json({ ok: true });
  });
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
  return {
    base: `http://127.0.0.1:${address.port}`,
    policy,
    store,
    provider,
    getConsentRequest: () => consentRequest,
    resolveConsent: (choice: "Allow" | "Deny") => resolveConsent(choice),
  };
}

async function register(base: string) {
  const response = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: ["http://127.0.0.1:3000/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "Router test client",
      scope: OAUTH_SCOPE,
    }),
  });
  expect(response.status).toBe(201);
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
  return (await response.json()) as { client_id: string };
}

async function startTlsTerminatingProxy(
  upstreamBase: string,
  sourceAddress = "198.51.100.20",
): Promise<string> {
  const upstream = new URL(upstreamBase);
  const proxy = createServer((req, res) => {
    const forwarded = requestHttp(
      {
        hostname: upstream.hostname,
        port: upstream.port,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          host: "mcp.example",
          // The fixture stands in for an HTTPS edge that observed this public
          // client address and overwrites any inbound forwarding metadata.
          "x-forwarded-for": sourceAddress,
          "x-forwarded-host": "mcp.example",
          "x-forwarded-port": "443",
          "x-forwarded-proto": "https",
        },
      },
      (upstreamResponse) => {
        res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(res);
      },
    );
    forwarded.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(forwarded);
  });
  servers.push(proxy);
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("test proxy did not bind TCP");
  return `http://127.0.0.1:${address.port}`;
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function waitUntilReady(base: string, statusPath: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`${base}${statusPath}`);
    const body = (await response.json()) as { status?: string };
    if (body.status === "ready") return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("consent did not become ready");
}

describe("OAuth SDK-composed router", () => {
  it("serves path-specific PRM and public-only metadata without permissive CORS", async () => {
    const { base, policy } = await startFixture();
    const prm = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    expect(prm.status).toBe(200);
    expect(prm.headers.get("access-control-allow-origin")).toBeNull();
    expect(await prm.json()).toMatchObject({
      resource: policy.resource.href,
      authorization_servers: [policy.issuer.href],
      scopes_supported: [OAUTH_SCOPE],
    });
    expect((await fetch(`${base}/.well-known/oauth-protected-resource`)).status).toBe(404);

    const metadataResponse = await fetch(`${base}/.well-known/oauth-authorization-server`);
    const metadata = (await metadataResponse.json()) as Record<string, unknown>;
    expect(metadataResponse.headers.get("access-control-allow-origin")).toBeNull();
    expect(metadata).toMatchObject({
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [OAUTH_SCOPE],
    });
    expect(metadata.token_endpoint_auth_methods_supported).not.toContain("client_secret_post");
  });

  it("runs authorization code plus S256, one-use code, refresh replay revocation and RFC 7009", async () => {
    const fixture = await startFixture();
    const client = await register(fixture.base);
    const verifier = "v".repeat(64);
    const authorize = new URL(`${fixture.base}/authorize`);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", client.client_id);
    authorize.searchParams.set("redirect_uri", "http://127.0.0.1:49152/callback");
    authorize.searchParams.set("code_challenge", s256(verifier));
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("scope", OAUTH_SCOPE);
    authorize.searchParams.set("state", "opaque-client-state");
    authorize.searchParams.set("resource", fixture.policy.resource.href);

    const pending = await fetch(authorize, { redirect: "manual" });
    expect(pending.status).toBe(202);
    expect(pending.headers.get("cache-control")).toBe("no-store");
    expect(pending.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await pending.text();
    expect(html).not.toContain("opaque-client-state");
    expect(html).not.toContain(s256(verifier));
    const statusPath = html.match(/\/oauth\/consent\/([^/]+)\/status/u)?.[0];
    expect(statusPath).toBeTruthy();
    expect(fixture.getConsentRequest()).not.toHaveProperty("state");
    expect(fixture.getConsentRequest()).not.toHaveProperty("codeChallenge");

    fixture.resolveConsent("Allow");
    await waitUntilReady(fixture.base, statusPath as string);
    const completePath = (statusPath as string).replace(/\/status$/u, "/complete");
    const completed = await fetch(`${fixture.base}${completePath}`, { redirect: "manual" });
    expect(completed.status).toBe(302);
    const redirect = new URL(completed.headers.get("location") ?? "");
    const code = redirect.searchParams.get("code");
    expect(code).toBeTruthy();
    expect(redirect.searchParams.get("state")).toBe("opaque-client-state");

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code: code as string,
      code_verifier: verifier,
      redirect_uri: "http://127.0.0.1:49152/callback",
      resource: fixture.policy.resource.href,
    });
    const tokenResponse = await fetch(`${fixture.base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody,
    });
    expect(tokenResponse.status).toBe(200);
    expect(tokenResponse.headers.get("access-control-allow-origin")).toBeNull();
    const tokens = (await tokenResponse.json()) as { access_token: string; refresh_token: string };
    expect(
      (
        await fetch(`${fixture.base}/protected`, {
          headers: { authorization: `Bearer ${tokens.access_token}` },
        })
      ).status,
    ).toBe(200);

    const replayCode = await fetch(`${fixture.base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody,
    });
    expect(replayCode.status).toBe(400);
    expect(await replayCode.json()).toMatchObject({ error: "invalid_grant" });

    const refreshBody = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: tokens.refresh_token,
      resource: fixture.policy.resource.href,
    });
    const refreshedResponse = await fetch(`${fixture.base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: refreshBody,
    });
    expect(refreshedResponse.status).toBe(200);
    const refreshed = (await refreshedResponse.json()) as {
      access_token: string;
      refresh_token: string;
    };
    const replayRefresh = await fetch(`${fixture.base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: refreshBody,
    });
    expect(replayRefresh.status).toBe(400);
    expect(
      (
        await fetch(`${fixture.base}/protected`, {
          headers: { authorization: `Bearer ${refreshed.access_token}` },
        })
      ).status,
    ).toBe(401);

    const revocable = await fixture.store.issueTokenPair(
      client.client_id,
      [OAUTH_SCOPE],
      fixture.policy.resource.href,
    );
    const revoked = await fetch(`${fixture.base}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: client.client_id, token: revocable.accessToken }),
    });
    expect(revoked.status).toBe(200);
    expect(revoked.headers.get("access-control-allow-origin")).toBeNull();
    expect(
      (
        await fetch(`${fixture.base}/protected`, {
          headers: { authorization: `Bearer ${revocable.accessToken}` },
        })
      ).status,
    ).toBe(401);
  });

  it("rejects public-client and PKCE policy violations before issuing credentials", async () => {
    const fixture = await startFixture();
    const confidential = await fetch(`${fixture.base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://127.0.0.1:3000/callback"],
        token_endpoint_auth_method: "client_secret_post",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    expect(confidential.status).toBe(400);

    const client = await register(fixture.base);
    const authorize = new URL(`${fixture.base}/authorize`);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", client.client_id);
    authorize.searchParams.set("redirect_uri", "http://127.0.0.1:3000/callback");
    authorize.searchParams.set("code_challenge", "plain-is-forbidden");
    authorize.searchParams.set("code_challenge_method", "plain");
    authorize.searchParams.set("scope", OAUTH_SCOPE);
    authorize.searchParams.set("resource", fixture.policy.resource.href);
    const refused = await fetch(authorize, { redirect: "manual" });
    expect(refused.status).toBe(302);
    expect(new URL(refused.headers.get("location") ?? "").searchParams.get("error")).toBe(
      "invalid_request",
    );
    expect(fixture.getConsentRequest()).toBeUndefined();
  });

  it("refills bounded source/global buckets, rejects spoofed sources, and latches rollback", async () => {
    let now = 1_000;
    const fixture = await startFixture({
      registrationLimitPerHour: 2,
      clock: () => now,
    });
    const registrationBody = JSON.stringify({
      redirect_uris: ["http://127.0.0.1:3000/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: OAUTH_SCOPE,
    });
    const request = () =>
      fetch(`${fixture.base}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: registrationBody,
      });

    expect((await request()).status).toBe(201);
    expect((await request()).status).toBe(201);
    expect((await request()).status).toBe(429);
    expect(
      (
        await fetch(`${fixture.base}/register`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.1" },
          body: registrationBody,
        })
      ).status,
    ).toBe(403);
    now = 999;
    expect((await request()).status).toBe(503);
    now = 2_800;
    expect((await request()).status).toBe(503);
  });

  it("isolates trusted-proxy registration capacity by opaque source identity", async () => {
    const fixture = await startFixture({
      publicBaseUrl: "https://mcp.example",
      trustedProxyHops: ["127.0.0.1"],
      registrationLimitPerHour: 1,
    });
    const firstSource = await startTlsTerminatingProxy(fixture.base, "198.51.100.31");
    const secondSource = await startTlsTerminatingProxy(fixture.base, "198.51.100.32");
    const body = JSON.stringify({
      redirect_uris: ["http://127.0.0.1:3000/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: OAUTH_SCOPE,
    });
    const request = (base: string) =>
      fetch(`${base}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });

    expect((await request(firstSource)).status).toBe(201);
    expect((await request(firstSource)).status).toBe(429);
    expect((await request(secondSource)).status).toBe(201);
  });

  it("accepts production-shaped HTTPS forwarding only from the configured proxy hop", async () => {
    const fixture = await startFixture({
      publicBaseUrl: "https://mcp.example",
      trustedProxyHops: ["127.0.0.1"],
    });
    const registrationBody = JSON.stringify({
      redirect_uris: ["http://127.0.0.1:3000/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: OAUTH_SCOPE,
    });
    const proxyBase = await startTlsTerminatingProxy(fixture.base);
    const request = (headers: Record<string, string>) =>
      fetch(`${fixture.base}/register`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: registrationBody,
      });

    expect(
      (
        await fetch(`${proxyBase}/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: registrationBody,
        })
      ).status,
    ).toBe(201);
    expect((await request({})).status).toBe(403);
    expect(
      (
        await request({
          "x-forwarded-for": "198.51.100.21",
          "x-forwarded-host": "attacker.example",
          "x-forwarded-proto": "https",
        })
      ).status,
    ).toBe(403);
  });

  it("fails startup on invalid registration limiter bounds", async () => {
    await expect(startFixture({ registrationLimitPerHour: 0 })).rejects.toThrow(
      /registration rate/u,
    );
    await expect(startFixture({ registrationLimitPerHour: 3_601 })).rejects.toThrow(
      /registration rate/u,
    );
  });
});
