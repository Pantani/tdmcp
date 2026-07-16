import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InvalidGrantError,
  InvalidTargetError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { afterEach, describe, expect, it } from "vitest";
import { createOAuthPolicy, OAUTH_SCOPE } from "../../src/server/oauth/policy.js";
import { TdmcpOAuthProvider } from "../../src/server/oauth/provider.js";
import { OAuthStateStore } from "../../src/server/oauth/store.js";

const temporary: string[] = [];
const providers: TdmcpOAuthProvider[] = [];

class FakeResponse {
  statusCode = 0;
  body = "";
  readonly headers = new Map<string, string>();

  setHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value);
  }

  status(code: number): FakeResponse {
    this.statusCode = code;
    return this;
  }

  send(body: string): void {
    this.body = body;
  }
}

afterEach(async () => {
  for (const provider of providers.splice(0)) provider.close();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function fixture(choice: "Allow" | "Deny" = "Allow") {
  const root = await mkdtemp(join(tmpdir(), "tdmcp-oauth-provider-"));
  temporary.push(root);
  let now = 5_000;
  const policy = createOAuthPolicy({
    publicBaseUrl: "http://127.0.0.1:3939",
    stateDirectory: join(root, "state"),
    allowInsecureLoopback: true,
  });
  const store = await OAuthStateStore.open(policy, { clock: () => now });
  const client = await store.registerPublicClient({
    redirect_uris: ["http://127.0.0.1:3000/callback"],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: OAUTH_SCOPE,
  });
  const provider = new TdmcpOAuthProvider({
    policy,
    store,
    clock: () => now,
    consentRequester: async () => choice,
  });
  providers.push(provider);
  return { policy, client, provider, setNow: (value: number) => (now = value) };
}

function transactionId(body: string): string {
  const id = body.match(/\/oauth\/consent\/([^/]+)\/status/u)?.[1];
  if (!id) throw new Error("waiting page did not contain a transaction id");
  return id;
}

describe("OAuth provider authorization-code lifecycle", () => {
  it("rejects a short PKCE verifier and consumes the attacked code", async () => {
    const { policy, client, provider } = await fixture();
    const verifier = "v".repeat(64);
    const response = new FakeResponse();
    await provider.authorize(
      client,
      {
        redirectUri: "http://127.0.0.1:3000/callback",
        codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
        scopes: [OAUTH_SCOPE],
        resource: policy.resource,
      },
      response,
    );
    await new Promise((resolve) => setImmediate(resolve));
    const completion = await provider.completeAuthorization(transactionId(response.body));
    await expect(
      provider.exchangeAuthorizationCode(
        client,
        completion.code as string,
        "x",
        "http://127.0.0.1:3000/callback",
        policy.resource,
      ),
    ).rejects.toBeInstanceOf(InvalidGrantError);
    await expect(
      provider.exchangeAuthorizationCode(
        client,
        completion.code as string,
        verifier,
        "http://127.0.0.1:3000/callback",
        policy.resource,
      ),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it("rejects every PKCE verifier boundary and a wrong full-length verifier", async () => {
    const correctVerifier = "v".repeat(64);
    const attacks = [
      ["42 characters", "v".repeat(42)],
      ["129 characters", "v".repeat(129)],
      ["invalid charset", `${"v".repeat(42)}!`],
      ["wrong valid-length verifier", "w".repeat(64)],
    ] as const;
    for (const [name, attack] of attacks) {
      const { policy, client, provider } = await fixture();
      const response = new FakeResponse();
      await provider.authorize(
        client,
        {
          redirectUri: "http://127.0.0.1:3000/callback",
          codeChallenge: createHash("sha256").update(correctVerifier).digest("base64url"),
          scopes: [OAUTH_SCOPE],
          resource: policy.resource,
        },
        response,
      );
      await new Promise((resolve) => setImmediate(resolve));
      const completion = await provider.completeAuthorization(transactionId(response.body));
      await expect(
        provider.exchangeAuthorizationCode(
          client,
          completion.code as string,
          attack,
          "http://127.0.0.1:3000/callback",
          policy.resource,
        ),
        name,
      ).rejects.toBeInstanceOf(InvalidGrantError);
    }
  });

  it("expires one-use authorization codes after exactly the bounded minute", async () => {
    const { policy, client, provider, setNow } = await fixture();
    const response = new FakeResponse();
    await provider.authorize(
      client,
      {
        redirectUri: "http://127.0.0.1:49152/callback",
        codeChallenge: "c".repeat(43),
        scopes: [OAUTH_SCOPE],
        resource: policy.resource,
      },
      response,
    );
    await new Promise((resolve) => setImmediate(resolve));
    const completion = await provider.completeAuthorization(transactionId(response.body));
    expect(completion.outcome).toBe("allowed");
    expect(completion.code).toBeTruthy();
    setNow(5_060);
    await expect(
      provider.challengeForAuthorizationCode(client, completion.code as string),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it("turns Deny into access_denied without creating a code", async () => {
    const { policy, client, provider } = await fixture("Deny");
    const response = new FakeResponse();
    await provider.authorize(
      client,
      {
        redirectUri: "http://127.0.0.1:3000/callback",
        codeChallenge: "c".repeat(43),
        scopes: [OAUTH_SCOPE],
        resource: policy.resource,
      },
      response,
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(await provider.completeAuthorization(transactionId(response.body))).toMatchObject({
      outcome: "denied",
      error: "access_denied",
    });
  });

  it("refuses a non-canonical resource before starting consent", async () => {
    const { client, provider } = await fixture();
    const response = new FakeResponse();
    await expect(
      provider.authorize(
        client,
        {
          redirectUri: "http://127.0.0.1:3000/callback",
          codeChallenge: "c".repeat(43),
          scopes: [OAUTH_SCOPE],
          resource: new URL("https://other.example/mcp"),
        },
        response,
      ),
    ).rejects.toBeInstanceOf(InvalidTargetError);
    expect(response.body).toBe("");
  });
});
