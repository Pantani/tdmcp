import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { z } from "zod";
import { createRollbackGuardedClock } from "./clock.js";
import {
  MAX_REFRESH_FAMILIES,
  MAX_REGISTERED_CLIENTS,
  MAX_TOKEN_ROWS,
  OAUTH_SCOPE,
  type OAuthPolicy,
  type PublicClientRegistration,
  validatePublicClientRegistration,
} from "./policy.js";

const STATE_FILE = "state.json";
const KEY_FILE = "token-hmac.key";
const LOCK_FILE = "state.lock";
const STATE_SCHEMA_VERSION = 1;

const ClientRecordSchema = z.object({
  client_id: z.string().min(16).max(128),
  client_id_issued_at: z.number().int().nonnegative(),
  redirect_uris: z.array(z.string()).min(1),
  token_endpoint_auth_method: z.literal("none"),
  grant_types: z.tuple([z.literal("authorization_code"), z.literal("refresh_token")]),
  response_types: z.tuple([z.literal("code")]),
  client_name: z.string().optional(),
  client_uri: z.string().optional(),
  scope: z.literal(OAUTH_SCOPE),
  // Added compatibly to schema v1. Older state files omit this field and use
  // client_id_issued_at as their initial activity timestamp.
  last_active_at: z.number().int().nonnegative().optional(),
});

const TokenRecordSchema = z.object({
  kind: z.enum(["access", "refresh"]),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  client_id: z.string(),
  scopes: z.tuple([z.literal(OAUTH_SCOPE)]),
  resource: z.string().url(),
  family_id: z.string().min(16).max(128),
  generation: z.number().int().nonnegative(),
  issued_at: z.number().int().nonnegative(),
  expires_at: z.number().int().positive(),
  status: z.enum(["active", "used", "revoked"]),
});

const DurableStateSchema = z.object({
  schema_version: z.literal(STATE_SCHEMA_VERSION),
  clients: z.array(ClientRecordSchema).max(MAX_REGISTERED_CLIENTS),
  tokens: z.array(TokenRecordSchema).max(MAX_TOKEN_ROWS),
});

type ClientRecord = z.infer<typeof ClientRecordSchema>;
type TokenRecord = z.infer<typeof TokenRecordSchema>;
type DurableState = z.infer<typeof DurableStateSchema>;

export class OAuthStateCorruptionError extends Error {}
export class OAuthStoreLockedError extends Error {}
export class OAuthStoreCapacityError extends Error {}
export class OAuthTokenInvalidError extends Error {}
export class OAuthRefreshReplayError extends Error {}

export interface OAuthTokenPair {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  scopes: [typeof OAUTH_SCOPE];
  resource: string;
}

export interface VerifiedOAuthToken {
  token: string;
  clientId: string;
  scopes: [typeof OAUTH_SCOPE];
  expiresAt: number;
  resource: URL;
}

export interface OAuthStateStoreOptions {
  clock?: () => number;
  tokenFactory?: () => string;
  idFactory?: () => string;
}

interface OAuthStoreLock {
  fd: number;
  path: string;
  owner: string;
  released: boolean;
}

function emptyState(): DurableState {
  return { schema_version: STATE_SCHEMA_VERSION, clients: [], tokens: [] };
}

function cloneState(state: DurableState): DurableState {
  return structuredClone(state);
}

async function assertPrivatePath(path: string, kind: "directory" | "file"): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new OAuthStateCorruptionError(`${path} must not be a symlink`);
  if (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) {
    throw new OAuthStateCorruptionError(`${path} has the wrong filesystem type`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new OAuthStateCorruptionError(`${path} permissions are not owner-private`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  if (!(await pathExists(path))) await mkdir(path, { recursive: true, mode: 0o700 });
  await assertPrivatePath(path, "directory");
  if (process.platform !== "win32") await chmod(path, 0o700);
}

function acquireStoreLock(directory: string): OAuthStoreLock {
  const path = join(directory, LOCK_FILE);
  const owner = `${process.pid}:${randomUUID()}\n`;
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new OAuthStoreLockedError("OAuth state is already owned by another server process");
    }
    throw error;
  }
  try {
    writeFileSync(fd, owner, { encoding: "utf8" });
    fsyncSync(fd);
    if (process.platform !== "win32") chmodSync(path, 0o600);
    return { fd, path, owner, released: false };
  } catch (error) {
    closeSync(fd);
    try {
      unlinkSync(path);
    } catch {
      // The original error remains authoritative; a retained lock fails closed.
    }
    throw error;
  }
}

function releaseStoreLock(lock: OAuthStoreLock): void {
  if (lock.released) return;
  lock.released = true;
  let stillOwned = false;
  try {
    stillOwned = readFileSync(lock.path, "utf8") === lock.owner;
  } catch {
    // A missing or replaced lock is not ours to remove.
  }
  try {
    closeSync(lock.fd);
  } finally {
    if (stillOwned) {
      try {
        unlinkSync(lock.path);
      } catch {
        // Failure retains a fail-closed lock for explicit operator recovery.
      }
    }
  }
}

async function loadOrCreateKey(path: string): Promise<Buffer> {
  if (!(await pathExists(path))) {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(`${randomBytes(32).toString("base64url")}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  await assertPrivatePath(path, "file");
  const raw = (await readFile(path, "utf8")).trim();
  const key = Buffer.from(raw, "base64url");
  if (key.length !== 32) throw new OAuthStateCorruptionError("OAuth HMAC key is invalid");
  return key;
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWriteJson(path: string, state: DurableState): Promise<void> {
  const directory = dirname(path);
  const temporary = join(directory, `.${STATE_FILE}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  if (process.platform !== "win32") await chmod(path, 0o600);
  await syncDirectory(directory);
}

function clientResponse(record: ClientRecord): OAuthClientInformationFull {
  return {
    client_id: record.client_id,
    client_id_issued_at: record.client_id_issued_at,
    redirect_uris: [...record.redirect_uris],
    token_endpoint_auth_method: record.token_endpoint_auth_method,
    grant_types: [...record.grant_types],
    response_types: [...record.response_types],
    ...(record.client_name ? { client_name: record.client_name } : {}),
    ...(record.client_uri ? { client_uri: record.client_uri } : {}),
    scope: record.scope,
  };
}

export class OAuthStateStore implements OAuthRegisteredClientsStore {
  readonly #policy: OAuthPolicy;
  readonly #statePath: string;
  readonly #key: Buffer;
  readonly #clock: () => number;
  readonly #tokenFactory: () => string;
  readonly #idFactory: () => string;
  readonly #lock: OAuthStoreLock;
  #state: DurableState;
  #queue: Promise<void> = Promise.resolve();

  private constructor(
    policy: OAuthPolicy,
    key: Buffer,
    state: DurableState,
    options: OAuthStateStoreOptions,
    lock: OAuthStoreLock,
  ) {
    this.#policy = policy;
    this.#statePath = join(policy.stateDirectory, STATE_FILE);
    this.#key = key;
    this.#state = state;
    this.#clock = createRollbackGuardedClock(
      options.clock ?? (() => Math.floor(Date.now() / 1_000)),
    );
    this.#tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#lock = lock;
  }

  static async open(
    policy: OAuthPolicy,
    options: OAuthStateStoreOptions = {},
  ): Promise<OAuthStateStore> {
    await ensurePrivateDirectory(policy.stateDirectory);
    const lock = acquireStoreLock(policy.stateDirectory);
    try {
      const key = await loadOrCreateKey(join(policy.stateDirectory, KEY_FILE));
      const statePath = join(policy.stateDirectory, STATE_FILE);
      let state = emptyState();
      if (await pathExists(statePath)) {
        await assertPrivatePath(statePath, "file");
        try {
          state = DurableStateSchema.parse(JSON.parse(await readFile(statePath, "utf8")));
        } catch {
          // The file is owner-controlled but may be corrupt or attacker-written.
          // Never echo rejected values into startup logs: they could contain a
          // pasted token or other sensitive material.
          throw new OAuthStateCorruptionError("OAuth state failed validation");
        }
      } else {
        await atomicWriteJson(statePath, state);
      }
      return new OAuthStateStore(policy, key, state, options, lock);
    } catch (error) {
      releaseStoreLock(lock);
      throw error;
    }
  }

  /** Releases the cross-process state owner lock. Idempotent and synchronous. */
  close(): void {
    releaseStoreLock(this.#lock);
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return this.#lockedRead(() => {
      const record = this.#state.clients.find((candidate) => candidate.client_id === clientId);
      if (!record || !this.#clientIsRetained(this.#state, record, this.#clock())) return undefined;
      return clientResponse(record);
    });
  }

  async registerClient(
    metadata: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): Promise<OAuthClientInformationFull> {
    return this.registerPublicClient(metadata);
  }

  async registerPublicClient(metadata: unknown): Promise<OAuthClientInformationFull> {
    const registration = validatePublicClientRegistration(metadata, this.#policy);
    return this.#mutate(async (draft) => {
      const now = this.#clock();
      this.#prune(draft, now);
      this.#makeClientCapacity(draft);
      if (draft.clients.length >= MAX_REGISTERED_CLIENTS) {
        throw new OAuthStoreCapacityError("OAuth registered client limit reached");
      }
      const record: ClientRecord = {
        ...registration,
        scope: OAUTH_SCOPE,
        client_id: this.#newClientId(draft),
        client_id_issued_at: now,
        last_active_at: now,
      };
      draft.clients.push(record);
      return clientResponse(record);
    });
  }

  async issueTokenPair(
    clientId: string,
    scopes: [typeof OAUTH_SCOPE],
    resource: string,
  ): Promise<OAuthTokenPair> {
    return this.#mutate(async (draft) => {
      const now = this.#clock();
      this.#prune(draft, now);
      const client = draft.clients.find((candidate) => candidate.client_id === clientId);
      if (!client) throw new OAuthTokenInvalidError("OAuth client is invalid or expired");
      client.last_active_at = now;
      const familyId = this.#newFamilyId(draft);
      this.#assertFamilyCapacity(draft, familyId);
      const accessToken = this.#tokenFactory();
      const refreshToken = this.#tokenFactory();
      const accessExpiresAt = now + this.#policy.accessTtlSeconds;
      const refreshExpiresAt = now + this.#policy.refreshTtlSeconds;
      this.#appendPair(draft, {
        clientId,
        scopes,
        resource,
        familyId,
        generation: 0,
        now,
        accessToken,
        refreshToken,
        accessExpiresAt,
        refreshExpiresAt,
      });
      return { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt, scopes, resource };
    });
  }

  async rotateRefreshToken(
    refreshToken: string,
    clientId: string,
    requestedScopes: [typeof OAUTH_SCOPE] | undefined,
    resource: string,
  ): Promise<OAuthTokenPair> {
    const outcome = await this.#mutate(async (draft) => {
      const now = this.#clock();
      this.#prune(draft, now);
      const record = this.#findToken(draft, refreshToken);
      if (!record || record.kind !== "refresh" || record.client_id !== clientId) {
        throw new OAuthTokenInvalidError("refresh token is invalid");
      }
      if (record.resource !== resource || record.expires_at <= now || record.status === "revoked") {
        throw new OAuthTokenInvalidError("refresh token is invalid");
      }
      if (record.status === "used") {
        this.#revokeFamily(draft, record.family_id);
        return { replay: true as const };
      }
      const client = draft.clients.find((candidate) => candidate.client_id === clientId);
      if (!client) throw new OAuthTokenInvalidError("OAuth client is invalid or expired");
      client.last_active_at = now;
      const scopes = requestedScopes ?? record.scopes;
      if (scopes.length !== 1 || scopes[0] !== OAUTH_SCOPE) {
        throw new OAuthTokenInvalidError("refresh scope is invalid");
      }
      record.status = "used";
      const accessToken = this.#tokenFactory();
      const nextRefreshToken = this.#tokenFactory();
      const accessExpiresAt = now + this.#policy.accessTtlSeconds;
      const refreshExpiresAt = record.expires_at;
      this.#appendPair(draft, {
        clientId,
        scopes,
        resource,
        familyId: record.family_id,
        generation: record.generation + 1,
        now,
        accessToken,
        refreshToken: nextRefreshToken,
        accessExpiresAt,
        refreshExpiresAt,
      });
      return {
        replay: false as const,
        pair: {
          accessToken,
          refreshToken: nextRefreshToken,
          accessExpiresAt,
          refreshExpiresAt,
          scopes,
          resource,
        },
      };
    });
    if (outcome.replay)
      throw new OAuthRefreshReplayError("refresh token replay revoked its family");
    return outcome.pair;
  }

  async verifyAccessToken(token: string): Promise<VerifiedOAuthToken> {
    return this.#lockedRead(() => {
      const now = this.#clock();
      const record = this.#findToken(this.#state, token);
      if (
        !record ||
        record.kind !== "access" ||
        record.status !== "active" ||
        record.expires_at <= now ||
        record.resource !== this.#policy.resource.href
      ) {
        throw new OAuthTokenInvalidError("access token is invalid");
      }
      return {
        token,
        clientId: record.client_id,
        scopes: record.scopes,
        expiresAt: record.expires_at,
        resource: new URL(record.resource),
      };
    });
  }

  async revokeToken(clientId: string, token: string): Promise<void> {
    await this.#mutate(async (draft) => {
      const record = this.#findToken(draft, token);
      if (!record || record.client_id !== clientId) return;
      if (record.kind === "refresh") this.#revokeFamily(draft, record.family_id);
      else record.status = "revoked";
    });
  }

  async snapshotForTest(): Promise<DurableState> {
    return this.#lockedRead(() => cloneState(this.#state));
  }

  #digest(token: string): string {
    return createHmac("sha256", this.#key).update(token, "utf8").digest("hex");
  }

  #findToken(state: DurableState, token: string): TokenRecord | undefined {
    const digest = this.#digest(token);
    return state.tokens.find((candidate) => candidate.digest === digest);
  }

  #prune(state: DurableState, now: number): void {
    state.tokens = state.tokens.filter(
      (record) => record.expires_at > now && record.status !== "revoked",
    );
    state.clients = state.clients.filter((client) => this.#clientIsRetained(state, client, now));
  }

  #clientIsRetained(state: DurableState, client: ClientRecord, now: number): boolean {
    const hasLiveToken = state.tokens.some(
      (token) =>
        token.client_id === client.client_id &&
        token.expires_at > now &&
        token.status !== "revoked",
    );
    if (hasLiveToken) return true;
    const lastActiveAt = client.last_active_at ?? client.client_id_issued_at;
    return lastActiveAt + this.#policy.registeredClientTtlSeconds > now;
  }

  #makeClientCapacity(state: DurableState): void {
    if (state.clients.length < MAX_REGISTERED_CLIENTS) return;
    const tokenOwners = new Set(state.tokens.map((record) => record.client_id));
    const evictable = state.clients
      .filter((client) => !tokenOwners.has(client.client_id))
      .sort((left, right) => {
        const leftActivity = left.last_active_at ?? left.client_id_issued_at;
        const rightActivity = right.last_active_at ?? right.client_id_issued_at;
        return leftActivity - rightActivity || left.client_id.localeCompare(right.client_id);
      })[0];
    if (!evictable) return;
    state.clients = state.clients.filter((client) => client.client_id !== evictable.client_id);
  }

  #assertFamilyCapacity(state: DurableState, nextFamilyId: string): void {
    const families = new Set(state.tokens.map((record) => record.family_id));
    families.add(nextFamilyId);
    if (families.size > MAX_REFRESH_FAMILIES) {
      throw new OAuthStoreCapacityError("OAuth refresh family limit reached");
    }
  }

  #newClientId(state: DurableState): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = this.#idFactory();
      if (
        id.length >= 16 &&
        id.length <= 128 &&
        !state.clients.some((client) => client.client_id === id)
      ) {
        return id;
      }
    }
    throw new OAuthStoreCapacityError("OAuth client id allocation failed");
  }

  #newFamilyId(state: DurableState): string {
    const existing = new Set(state.tokens.map((record) => record.family_id));
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = this.#idFactory();
      if (id.length >= 16 && id.length <= 128 && !existing.has(id)) return id;
    }
    throw new OAuthStoreCapacityError("OAuth refresh family id allocation failed");
  }

  #appendPair(
    state: DurableState,
    input: {
      clientId: string;
      scopes: [typeof OAUTH_SCOPE];
      resource: string;
      familyId: string;
      generation: number;
      now: number;
      accessToken: string;
      refreshToken: string;
      accessExpiresAt: number;
      refreshExpiresAt: number;
    },
  ): void {
    if (state.tokens.length + 2 > MAX_TOKEN_ROWS) {
      throw new OAuthStoreCapacityError("OAuth token record limit reached");
    }
    const accessDigest = this.#digest(input.accessToken);
    const refreshDigest = this.#digest(input.refreshToken);
    const existingDigests = new Set(state.tokens.map((record) => record.digest));
    if (
      accessDigest === refreshDigest ||
      existingDigests.has(accessDigest) ||
      existingDigests.has(refreshDigest)
    ) {
      throw new OAuthStoreCapacityError("OAuth token collision");
    }
    const common = {
      client_id: input.clientId,
      scopes: input.scopes,
      resource: input.resource,
      family_id: input.familyId,
      generation: input.generation,
      issued_at: input.now,
      status: "active" as const,
    };
    state.tokens.push(
      {
        ...common,
        kind: "access",
        digest: accessDigest,
        expires_at: input.accessExpiresAt,
      },
      {
        ...common,
        kind: "refresh",
        digest: refreshDigest,
        expires_at: input.refreshExpiresAt,
      },
    );
  }

  #revokeFamily(state: DurableState, familyId: string): void {
    for (const record of state.tokens) {
      if (record.family_id === familyId) record.status = "revoked";
    }
  }

  #lockedRead<T>(action: () => T | Promise<T>): Promise<T> {
    const result = this.#queue.then(action);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #mutate<T>(action: (draft: DurableState) => T | Promise<T>): Promise<T> {
    return this.#lockedRead(async () => {
      const draft = cloneState(this.#state);
      const result = await action(draft);
      const validated = DurableStateSchema.parse(draft);
      await atomicWriteJson(this.#statePath, validated);
      this.#state = validated;
      return result;
    });
  }
}

export function publicRegistrationFromClient(
  client: OAuthClientInformationFull,
): PublicClientRegistration {
  return {
    redirect_uris: client.redirect_uris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    ...(client.client_name ? { client_name: client.client_name } : {}),
    ...(client.client_uri ? { client_uri: client.client_uri } : {}),
    scope: OAUTH_SCOPE,
  };
}
