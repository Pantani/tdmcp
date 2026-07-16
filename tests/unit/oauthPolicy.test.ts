import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createOAuthPolicy,
  DEFAULT_REGISTERED_CLIENT_TTL_SECONDS,
  OAUTH_SCOPE,
  redirectUriMatchesPolicy,
  validateExactResource,
  validatePublicClientRegistration,
  validateRedirectUri,
  validateScopes,
} from "../../src/server/oauth/policy.js";

const temporary: string[] = [];

async function stateDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "tdmcp-oauth-policy-"));
  temporary.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("OAuth canonical and redirect policy", () => {
  it("requires HTTPS except explicit numeric loopback", async () => {
    const directory = await stateDirectory();
    expect(() =>
      createOAuthPolicy({ publicBaseUrl: "http://example.com", stateDirectory: directory }),
    ).toThrow(/public HTTP is forbidden/u);
    expect(() =>
      createOAuthPolicy({
        publicBaseUrl: "http://127.0.0.1:3939",
        stateDirectory: directory,
      }),
    ).toThrow(/public HTTP is forbidden/u);
    expect(() =>
      createOAuthPolicy({
        publicBaseUrl: "http://localhost:3939",
        stateDirectory: directory,
        allowInsecureLoopback: true,
      }),
    ).toThrow(/numeric loopback/u);

    const local = createOAuthPolicy({
      publicBaseUrl: "http://127.0.0.1:3939",
      stateDirectory: directory,
      allowInsecureLoopback: true,
    });
    expect(local.issuer.href).toBe("http://127.0.0.1:3939/");
    expect(local.resource.href).toBe("http://127.0.0.1:3939/mcp");
    expect(local.resourceMetadataUrl.pathname).toBe("/.well-known/oauth-protected-resource/mcp");
    expect(local.registeredClientTtlSeconds).toBe(DEFAULT_REGISTERED_CLIENT_TTL_SECONDS);
    expect(local.trustedProxyHops.size).toBe(0);
    expect(() =>
      createOAuthPolicy({
        publicBaseUrl: "http://127.0.0.1:3939",
        stateDirectory: directory,
        allowInsecureLoopback: true,
        registeredClientTtlSeconds: 3_599,
      }),
    ).toThrow(/registered client inactivity TTL/u);
    expect(() =>
      createOAuthPolicy({
        publicBaseUrl: "http://127.0.0.1:3939",
        stateDirectory: directory,
        allowInsecureLoopback: true,
        registeredClientTtlSeconds: 365 * 24 * 60 * 60 + 1,
      }),
    ).toThrow(/registered client inactivity TTL/u);
  });

  it("accepts only a bounded unique numeric trusted-proxy set", async () => {
    const directory = await stateDirectory();
    const policy = createOAuthPolicy({
      publicBaseUrl: "https://mcp.example",
      stateDirectory: directory,
      trustedProxyHops: ["127.0.0.1", "::1"],
    });
    expect([...policy.trustedProxyHops]).toEqual(["127.0.0.1", "::1"]);
    expect(() =>
      createOAuthPolicy({
        publicBaseUrl: "https://mcp.example",
        stateDirectory: directory,
        trustedProxyHops: ["localhost"],
      }),
    ).toThrow(/numeric IP/u);
    expect(() =>
      createOAuthPolicy({
        publicBaseUrl: "https://mcp.example",
        stateDirectory: directory,
        trustedProxyHops: ["127.0.0.1", "::ffff:127.0.0.1"],
      }),
    ).toThrow(/unique/u);
    expect(() =>
      createOAuthPolicy({
        publicBaseUrl: "https://mcp.example",
        stateDirectory: directory,
        trustedProxyHops: Array.from({ length: 9 }, (_, index) => `192.0.2.${index + 1}`),
      }),
    ).toThrow(/at most 8/u);
  });

  it("does not derive a canonical URL from paths, credentials, query, fragments, or wildcard", async () => {
    const directory = await stateDirectory();
    for (const url of [
      "https://example.com/tenant",
      "https://user@example.com",
      "https://example.com?issuer=evil",
      "https://example.com#fragment",
      "https://*.example.com",
    ]) {
      expect(() => createOAuthPolicy({ publicBaseUrl: url, stateDirectory: directory })).toThrow();
    }
  });

  it("permits numeric-loopback port variation only and exact allowlisted HTTPS redirects", async () => {
    const policy = createOAuthPolicy({
      publicBaseUrl: "https://mcp.example",
      stateDirectory: await stateDirectory(),
      redirectOrigins: ["https://client.example"],
    });
    expect(validateRedirectUri("http://127.0.0.1:3000/callback?q=1", policy).hostname).toBe(
      "127.0.0.1",
    );
    expect(
      redirectUriMatchesPolicy(
        "http://127.0.0.1:49152/callback?q=1",
        "http://127.0.0.1:3000/callback?q=1",
        policy,
      ),
    ).toBe(true);
    expect(
      redirectUriMatchesPolicy(
        "http://[::1]:49152/callback",
        "http://127.0.0.1:3000/callback",
        policy,
      ),
    ).toBe(false);
    expect(validateRedirectUri("https://client.example/callback", policy).href).toBe(
      "https://client.example/callback",
    );
    for (const redirect of [
      "http://localhost:3000/callback",
      "http://127.0.0.1/callback",
      "https://evil.example/callback",
      "https://client.example.evil/callback",
      "https://user@client.example/callback",
      "https://client.example/callback#fragment",
      "tdmcp://callback",
    ]) {
      expect(() => validateRedirectUri(redirect, policy)).toThrow();
    }
  });

  it("accepts only bounded public DCR metadata and the one exact scope/resource", async () => {
    const policy = createOAuthPolicy({
      publicBaseUrl: "https://mcp.example",
      stateDirectory: await stateDirectory(),
      redirectOrigins: ["https://client.example"],
    });
    const valid = {
      redirect_uris: ["https://client.example/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "Studio controller",
      scope: OAUTH_SCOPE,
    };
    expect(validatePublicClientRegistration(valid, policy)).toEqual(valid);
    expect(() =>
      validatePublicClientRegistration(
        { ...valid, token_endpoint_auth_method: "client_secret_post" },
        policy,
      ),
    ).toThrow();
    expect(() =>
      validatePublicClientRegistration({ ...valid, client_name: "bad\nname" }, policy),
    ).toThrow();
    expect(() =>
      validatePublicClientRegistration({ ...valid, logo_uri: "https://evil/logo" }, policy),
    ).toThrow();
    expect(validateScopes([OAUTH_SCOPE])).toEqual([OAUTH_SCOPE]);
    expect(() => validateScopes([])).toThrow();
    expect(validateExactResource(new URL("https://mcp.example/mcp"), policy).href).toBe(
      "https://mcp.example/mcp",
    );
    expect(() => validateExactResource(new URL("https://mcp.example/other"), policy)).toThrow();
  });
});
