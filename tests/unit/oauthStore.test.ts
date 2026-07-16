import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  OAuthClockRollbackError,
  OAuthRefreshReplayError,
  OAuthStateCorruptionError,
  OAuthStateStore,
  OAuthStoreLockedError,
  OAuthTokenInvalidError,
} from "../../src/server/oauth/index.js";
import {
  createOAuthPolicy,
  MAX_REGISTERED_CLIENTS,
  OAUTH_SCOPE,
} from "../../src/server/oauth/policy.js";

const temporary: string[] = [];
const stores: OAuthStateStore[] = [];
const execFileAsync = promisify(execFile);

async function fixture(
  policyOverrides: { registeredClientTtlSeconds?: number; refreshTtlSeconds?: number } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "tdmcp-oauth-store-"));
  temporary.push(root);
  const stateDirectory = join(root, "private-state");
  const policy = createOAuthPolicy({
    publicBaseUrl: "http://127.0.0.1:3939",
    stateDirectory,
    allowInsecureLoopback: true,
    ...policyOverrides,
  });
  let now = 10_000;
  let sequence = 0;
  const options = {
    clock: () => now,
    tokenFactory: () => `token_${String(++sequence).padStart(40, "0")}`,
    idFactory: () => `identity_${String(++sequence).padStart(32, "0")}`,
  };
  const store = await OAuthStateStore.open(policy, options);
  stores.push(store);
  return { policy, stateDirectory, store, options, setNow: (value: number) => (now = value) };
}

const registration = {
  redirect_uris: ["http://127.0.0.1:3000/callback"],
  token_endpoint_auth_method: "none" as const,
  grant_types: ["authorization_code", "refresh_token"] as const,
  response_types: ["code"] as const,
  client_name: "Test client",
  scope: OAUTH_SCOPE,
};

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("OAuth owner-private HMAC state store", () => {
  it("persists only token digests with private permissions and verifies after restart", async () => {
    const { policy, stateDirectory, store, options } = await fixture();
    const client = await store.registerPublicClient(registration);
    const pair = await store.issueTokenPair(client.client_id, [OAUTH_SCOPE], policy.resource.href);
    expect((await store.verifyAccessToken(pair.accessToken)).clientId).toBe(client.client_id);

    const raw = await readFile(join(stateDirectory, "state.json"), "utf8");
    expect(raw).not.toContain(pair.accessToken);
    expect(raw).not.toContain(pair.refreshToken);
    expect(raw).toContain('"digest"');
    const snapshot = await store.snapshotForTest();
    expect(snapshot.tokens).toHaveLength(2);
    expect(snapshot.tokens.every((token) => /^[a-f0-9]{64}$/u.test(token.digest))).toBe(true);

    if (process.platform !== "win32") {
      expect((await lstat(stateDirectory)).mode & 0o777).toBe(0o700);
      expect((await lstat(join(stateDirectory, "state.json"))).mode & 0o777).toBe(0o600);
      expect((await lstat(join(stateDirectory, "token-hmac.key"))).mode & 0o777).toBe(0o600);
    }

    store.close();
    const reopened = await OAuthStateStore.open(policy, options);
    stores.push(reopened);
    expect((await reopened.verifyAccessToken(pair.accessToken)).resource.href).toBe(
      policy.resource.href,
    );
  });

  it("rotates refresh tokens and revokes the entire family on replay", async () => {
    const { policy, store, options } = await fixture();
    const client = await store.registerPublicClient(registration);
    const first = await store.issueTokenPair(client.client_id, [OAUTH_SCOPE], policy.resource.href);
    const second = await store.rotateRefreshToken(
      first.refreshToken,
      client.client_id,
      undefined,
      policy.resource.href,
    );
    expect((await store.verifyAccessToken(second.accessToken)).clientId).toBe(client.client_id);
    await expect(
      store.rotateRefreshToken(
        first.refreshToken,
        client.client_id,
        undefined,
        policy.resource.href,
      ),
    ).rejects.toBeInstanceOf(OAuthRefreshReplayError);
    await expect(store.verifyAccessToken(first.accessToken)).rejects.toBeInstanceOf(
      OAuthTokenInvalidError,
    );
    await expect(store.verifyAccessToken(second.accessToken)).rejects.toBeInstanceOf(
      OAuthTokenInvalidError,
    );
    await expect(
      store.rotateRefreshToken(
        second.refreshToken,
        client.client_id,
        undefined,
        policy.resource.href,
      ),
    ).rejects.toBeInstanceOf(OAuthTokenInvalidError);
    store.close();
    const reopened = await OAuthStateStore.open(policy, options);
    stores.push(reopened);
    await expect(reopened.verifyAccessToken(second.accessToken)).rejects.toBeInstanceOf(
      OAuthTokenInvalidError,
    );
  });

  it("enforces audience, expiry, client binding, scope and idempotent revocation", async () => {
    const { policy, store, setNow } = await fixture();
    const client = await store.registerPublicClient(registration);
    const other = await store.registerPublicClient(registration);
    const pair = await store.issueTokenPair(client.client_id, [OAUTH_SCOPE], policy.resource.href);
    await expect(
      store.rotateRefreshToken(pair.refreshToken, other.client_id, undefined, policy.resource.href),
    ).rejects.toBeInstanceOf(OAuthTokenInvalidError);
    await expect(
      store.rotateRefreshToken(
        pair.refreshToken,
        client.client_id,
        undefined,
        "https://other.example/mcp",
      ),
    ).rejects.toBeInstanceOf(OAuthTokenInvalidError);
    await store.revokeToken(other.client_id, pair.accessToken);
    expect((await store.verifyAccessToken(pair.accessToken)).clientId).toBe(client.client_id);
    await store.revokeToken(client.client_id, pair.accessToken);
    await store.revokeToken(client.client_id, pair.accessToken);
    await expect(store.verifyAccessToken(pair.accessToken)).rejects.toBeInstanceOf(
      OAuthTokenInvalidError,
    );

    const expiring = await store.issueTokenPair(
      client.client_id,
      [OAUTH_SCOPE],
      policy.resource.href,
    );
    setNow(10_000 + policy.accessTtlSeconds);
    await expect(store.verifyAccessToken(expiring.accessToken)).rejects.toBeInstanceOf(
      OAuthTokenInvalidError,
    );
  });

  it("fails startup on corrupt durable state instead of resetting it", async () => {
    const { policy, stateDirectory, store, options } = await fixture();
    store.close();
    await writeFile(join(stateDirectory, "state.json"), "{broken", {
      encoding: "utf8",
      mode: 0o600,
    });
    await expect(OAuthStateStore.open(policy, options)).rejects.toBeInstanceOf(
      OAuthStateCorruptionError,
    );
  });

  it("prunes inactive clients at the exact TTL", async () => {
    const { store, setNow } = await fixture({ registeredClientTtlSeconds: 3_600 });
    const first = await store.registerPublicClient(registration);
    expect(first).not.toHaveProperty("last_active_at");
    setNow(13_599);
    await expect(store.getClient(first.client_id)).resolves.toBeDefined();
    setNow(13_600);
    const replacement = await store.registerPublicClient({
      ...registration,
      client_name: "Replacement client",
    });
    const snapshot = await store.snapshotForTest();
    expect(snapshot.clients).toHaveLength(1);
    expect(snapshot.clients[0]?.client_id).toBe(replacement.client_id);
    await expect(store.getClient(first.client_id)).resolves.toBeUndefined();
  });

  it("evicts the oldest tokenless client at capacity while retaining live-token owners", async () => {
    const { policy, store, setNow } = await fixture({
      registeredClientTtlSeconds: 3_600,
      refreshTtlSeconds: 7_200,
    });
    const tokenOwner = await store.registerPublicClient({
      ...registration,
      client_name: "Live token owner",
    });
    const pair = await store.issueTokenPair(
      tokenOwner.client_id,
      [OAUTH_SCOPE],
      policy.resource.href,
    );
    setNow(10_001);
    const oldestTokenless = await store.registerPublicClient({
      ...registration,
      client_name: "Oldest tokenless client",
    });
    for (let index = 2; index < MAX_REGISTERED_CLIENTS; index += 1) {
      await store.registerPublicClient({
        ...registration,
        client_name: `Capacity client ${index}`,
      });
    }

    const replacement = await store.registerPublicClient({
      ...registration,
      client_name: "Capacity replacement",
    });
    const snapshot = await store.snapshotForTest();
    expect(snapshot.clients).toHaveLength(MAX_REGISTERED_CLIENTS);
    await expect(store.getClient(oldestTokenless.client_id)).resolves.toBeUndefined();
    await expect(store.getClient(tokenOwner.client_id)).resolves.toBeDefined();
    await expect(store.verifyAccessToken(pair.accessToken)).resolves.toMatchObject({
      clientId: tokenOwner.client_id,
    });
    await expect(store.getClient(replacement.client_id)).resolves.toBeDefined();
  });

  it("does not let unauthenticated lookup extend inactivity, but retains live token owners", async () => {
    const { policy, store, setNow } = await fixture({
      registeredClientTtlSeconds: 3_600,
      refreshTtlSeconds: 7_200,
    });
    const lookupOnly = await store.registerPublicClient({
      ...registration,
      client_name: "Lookup-only client",
    });
    setNow(13_599);
    await expect(store.getClient(lookupOnly.client_id)).resolves.toBeDefined();
    setNow(13_600);
    await expect(store.getClient(lookupOnly.client_id)).resolves.toBeUndefined();

    const tokenOwner = await store.registerPublicClient({
      ...registration,
      client_name: "Token owner",
    });
    const pair = await store.issueTokenPair(
      tokenOwner.client_id,
      [OAUTH_SCOPE],
      policy.resource.href,
    );
    setNow(17_200);
    await store.registerPublicClient({ ...registration, client_name: "Prune trigger" });
    await expect(store.getClient(tokenOwner.client_id)).resolves.toBeDefined();
    await expect(store.verifyAccessToken(pair.accessToken)).rejects.toBeInstanceOf(
      OAuthTokenInvalidError,
    );

    setNow(20_800);
    await store.registerPublicClient({ ...registration, client_name: "Final prune trigger" });
    await expect(store.getClient(tokenOwner.client_id)).resolves.toBeUndefined();
  });

  it("loads schema-v1 client rows without last_active_at and expires them deterministically", async () => {
    const { policy, stateDirectory, store, options, setNow } = await fixture({
      registeredClientTtlSeconds: 3_600,
    });
    const client = await store.registerPublicClient(registration);
    const statePath = join(stateDirectory, "state.json");
    const durable = JSON.parse(await readFile(statePath, "utf8")) as {
      clients: Array<Record<string, unknown>>;
    };
    delete durable.clients[0]?.last_active_at;
    await writeFile(statePath, `${JSON.stringify(durable)}\n`, { encoding: "utf8", mode: 0o600 });

    store.close();
    const reopened = await OAuthStateStore.open(policy, options);
    stores.push(reopened);
    await expect(reopened.getClient(client.client_id)).resolves.toBeDefined();
    setNow(13_600);
    await expect(reopened.getClient(client.client_id)).resolves.toBeUndefined();
  });

  it("owns one state directory exclusively and releases it only on explicit close", async () => {
    const { policy, stateDirectory, store, options } = await fixture();
    await expect(OAuthStateStore.open(policy, options)).rejects.toBeInstanceOf(
      OAuthStoreLockedError,
    );
    const policyModule = pathToFileURL(resolve("src/server/oauth/policy.ts")).href;
    const storeModule = pathToFileURL(resolve("src/server/oauth/store.ts")).href;
    const probe = `
      import { createOAuthPolicy } from ${JSON.stringify(policyModule)};
      import { OAuthStateStore, OAuthStoreLockedError } from ${JSON.stringify(storeModule)};
      const policy = createOAuthPolicy({
        publicBaseUrl: "http://127.0.0.1:3939",
        stateDirectory: ${JSON.stringify(stateDirectory)},
        allowInsecureLoopback: true,
      });
      try {
        await OAuthStateStore.open(policy);
        process.exitCode = 2;
      } catch (error) {
        if (!(error instanceof OAuthStoreLockedError)) throw error;
        process.stdout.write("locked\\n");
      }
    `;
    const child = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", probe],
      { cwd: process.cwd() },
    );
    expect(child.stdout).toBe("locked\n");
    store.close();
    const reopened = await OAuthStateStore.open(policy, options);
    stores.push(reopened);
    await expect(reopened.snapshotForTest()).resolves.toMatchObject({ schema_version: 1 });
  });

  it("latches a backwards epoch step before tokens can gain extended lifetime", async () => {
    const { policy, store, setNow } = await fixture();
    const client = await store.registerPublicClient(registration);
    const pair = await store.issueTokenPair(client.client_id, [OAUTH_SCOPE], policy.resource.href);
    setNow(9_999);
    await expect(store.verifyAccessToken(pair.accessToken)).rejects.toBeInstanceOf(
      OAuthClockRollbackError,
    );
    setNow(10_001);
    await expect(store.verifyAccessToken(pair.accessToken)).rejects.toBeInstanceOf(
      OAuthClockRollbackError,
    );
    expect((await store.snapshotForTest()).tokens).toHaveLength(2);
  });
});
