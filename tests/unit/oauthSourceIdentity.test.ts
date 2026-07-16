import { describe, expect, it } from "vitest";
import { createOAuthPolicy } from "../../src/server/oauth/policy.js";
import {
  OAuthSourceIdentityError,
  resolveOAuthSourceIdentity,
} from "../../src/server/oauth/sourceIdentity.js";

const policy = createOAuthPolicy({
  publicBaseUrl: "https://mcp.example",
  stateDirectory: "/tmp/tdmcp-oauth-source-identity-test",
  trustedProxyHops: ["127.0.0.1", "10.0.0.2"],
});

function request(
  remoteAddress: string | undefined,
  headers: Record<string, string | readonly string[] | undefined> = {},
) {
  return {
    headers,
    rawHeaders: Object.entries(headers).flatMap(([name, value]) => [name, String(value)]),
    socket: { remoteAddress },
  };
}

describe("OAuth trusted-proxy source identity", () => {
  it("uses direct numeric peers and never exposes the address in its opaque key", () => {
    const identity = resolveOAuthSourceIdentity(request("198.51.100.8"), policy);
    expect(identity.forwarded).toBe(false);
    expect(identity.key).toMatch(/^[a-f0-9]{64}$/u);
    expect(identity.key).not.toContain("198.51.100.8");
  });

  it("strips only configured right-hand proxies and ignores client-controlled left entries", () => {
    const identity = resolveOAuthSourceIdentity(
      request("127.0.0.1", {
        "x-forwarded-for": "192.0.2.99, 198.51.100.8, 10.0.0.2",
        "x-forwarded-host": "mcp.example",
        "x-forwarded-port": "443",
        "x-forwarded-proto": "https",
      }),
      policy,
    );
    const expected = resolveOAuthSourceIdentity(request("198.51.100.8"), policy);
    expect(identity).toEqual({ key: expected.key, forwarded: true });
  });

  it("fails closed on absent, untrusted, duplicate, ambiguous, or canonical-mismatch identity", () => {
    expect(() => resolveOAuthSourceIdentity(request(undefined), policy)).toThrow(
      OAuthSourceIdentityError,
    );
    expect(() => resolveOAuthSourceIdentity(request("127.0.0.1"), policy)).toThrow(
      /omitted source/u,
    );
    expect(() =>
      resolveOAuthSourceIdentity(
        request("203.0.113.4", { "x-forwarded-for": "198.51.100.8" }),
        policy,
      ),
    ).toThrow(/untrusted peer/u);
    expect(() =>
      resolveOAuthSourceIdentity(
        {
          headers: {
            "x-forwarded-for": "198.51.100.8",
            "x-forwarded-host": "mcp.example",
            "x-forwarded-proto": "https",
          },
          rawHeaders: ["x-forwarded-for", "198.51.100.8", "x-forwarded-for", "198.51.100.9"],
          socket: { remoteAddress: "127.0.0.1" },
        },
        policy,
      ),
    ).toThrow(/ambiguous/u);
    expect(() =>
      resolveOAuthSourceIdentity(
        request("127.0.0.1", {
          forwarded: "for=198.51.100.8;proto=https",
          "x-forwarded-for": "198.51.100.8",
          "x-forwarded-host": "mcp.example",
          "x-forwarded-proto": "https",
        }),
        policy,
      ),
    ).toThrow(/RFC Forwarded/u);
    expect(() =>
      resolveOAuthSourceIdentity(
        request("127.0.0.1", {
          "x-forwarded-for": "198.51.100.8",
          "x-forwarded-host": "mcp.example",
          "x-forwarded-proto": "http",
        }),
        policy,
      ),
    ).toThrow(/protocol/u);
    expect(() =>
      resolveOAuthSourceIdentity(
        request("127.0.0.1", {
          "x-forwarded-for": "10.0.0.2",
          "x-forwarded-host": "mcp.example",
          "x-forwarded-proto": "https",
        }),
        policy,
      ),
    ).toThrow(/no untrusted client/u);
    expect(() =>
      resolveOAuthSourceIdentity(
        request("127.0.0.1", {
          "x-forwarded-for": "192.0.2.1, 192.0.2.2, 198.51.100.8, 10.0.0.2",
          "x-forwarded-host": "mcp.example",
          "x-forwarded-proto": "https",
        }),
        policy,
      ),
    ).toThrow(/configured bound/u);
  });
});
