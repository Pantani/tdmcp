import { randomBytes } from "node:crypto";
import { createRollbackGuardedClock, OAuthClockRollbackError } from "./clock.js";
import { MAX_PENDING_CONSENTS, MAX_RETAINED_CONSENTS, type OAUTH_SCOPE } from "./policy.js";

export type OAuthConsentChoice = "Allow" | "Deny";

export interface OAuthConsentRequest {
  transactionId: string;
  clientId: string;
  clientName?: string;
  redirectUri: string;
  registeredRedirectUris: string[];
  allowedRedirectOrigins: string[];
  scopes: [typeof OAUTH_SCOPE];
  resource: string;
  ttlSeconds: number;
  signal: AbortSignal;
}

export type OAuthConsentRequester = (request: OAuthConsentRequest) => Promise<OAuthConsentChoice>;

export interface OAuthConsentTransactionInput {
  clientId: string;
  clientName?: string;
  redirectUri: string;
  registeredRedirectUris: string[];
  allowedRedirectOrigins: string[];
  scopes: [typeof OAUTH_SCOPE];
  resource: string;
  state?: string;
  codeChallenge: string;
}

export interface OAuthConsentCompletion {
  redirectUri: string;
  state?: string;
  outcome: "allowed" | "denied";
  code?: string;
  error?: "access_denied" | "server_error";
}

interface ConsentRecord extends OAuthConsentTransactionInput {
  id: string;
  status: "pending" | "allowed" | "denied" | "expired" | "completing" | "completed";
  createdAt: number;
  expiresAt: number;
  terminalAt?: number;
  controller: AbortController;
}

export interface OAuthConsentCoordinatorOptions {
  requester: OAuthConsentRequester;
  ttlSeconds: number;
  clock?: () => number;
  idFactory?: () => string;
  pendingCap?: number;
  retainedCap?: number;
  terminalRetentionSeconds?: number;
}

export class OAuthConsentCapacityError extends Error {}
export class OAuthConsentNotFoundError extends Error {}
export class OAuthConsentPendingError extends Error {}

function validOpaqueId(value: string): boolean {
  return /^[A-Za-z0-9_-]{24,128}$/u.test(value);
}

export class OAuthConsentCoordinator {
  readonly #requester: OAuthConsentRequester;
  readonly #ttlSeconds: number;
  readonly #clock: () => number;
  readonly #idFactory: () => string;
  readonly #pendingCap: number;
  readonly #retainedCap: number;
  readonly #terminalRetentionSeconds: number;
  readonly #records = new Map<string, ConsentRecord>();

  constructor(options: OAuthConsentCoordinatorOptions) {
    this.#requester = options.requester;
    this.#ttlSeconds = options.ttlSeconds;
    this.#clock = createRollbackGuardedClock(
      options.clock ?? (() => Math.floor(Date.now() / 1_000)),
    );
    this.#idFactory = options.idFactory ?? (() => randomBytes(24).toString("base64url"));
    this.#pendingCap = options.pendingCap ?? MAX_PENDING_CONSENTS;
    this.#retainedCap = options.retainedCap ?? MAX_RETAINED_CONSENTS;
    this.#terminalRetentionSeconds = options.terminalRetentionSeconds ?? 300;
  }

  start(input: OAuthConsentTransactionInput): string {
    this.#prune();
    const active = [...this.#records.values()].filter((record) => record.status === "pending");
    if (active.length >= this.#pendingCap) {
      throw new OAuthConsentCapacityError("OAuth consent pending limit reached");
    }
    this.#makeRoom();
    const id = this.#newId();
    const now = this.#clock();
    const record: ConsentRecord = {
      ...input,
      id,
      status: "pending",
      createdAt: now,
      expiresAt: now + this.#ttlSeconds,
      controller: new AbortController(),
    };
    this.#records.set(id, record);
    const request: OAuthConsentRequest = {
      transactionId: id,
      clientId: input.clientId,
      ...(input.clientName ? { clientName: input.clientName } : {}),
      redirectUri: input.redirectUri,
      registeredRedirectUris: input.registeredRedirectUris,
      allowedRedirectOrigins: input.allowedRedirectOrigins,
      scopes: input.scopes,
      resource: input.resource,
      ttlSeconds: this.#ttlSeconds,
      signal: record.controller.signal,
    };
    void this.#requester(request).then(
      (choice) => this.#resolve(id, choice === "Allow" ? "allowed" : "denied"),
      () => this.#resolve(id, "denied"),
    );
    return id;
  }

  status(id: string): { status: "pending" | "ready" } {
    this.#prune();
    const record = this.#require(id);
    return { status: record.status === "pending" ? "pending" : "ready" };
  }

  async complete(
    id: string,
    issueCode: (input: OAuthConsentTransactionInput) => Promise<string>,
  ): Promise<OAuthConsentCompletion> {
    this.#prune();
    const record = this.#require(id);
    if (record.status === "pending") throw new OAuthConsentPendingError("OAuth consent is pending");
    if (record.status === "completing" || record.status === "completed") {
      throw new OAuthConsentNotFoundError("OAuth consent transaction is already complete");
    }
    if (record.status === "denied" || record.status === "expired") {
      return this.#completeDenied(record, "access_denied");
    }
    return this.#completeAllowed(record, issueCode);
  }

  async #completeAllowed(
    record: ConsentRecord,
    issueCode: (input: OAuthConsentTransactionInput) => Promise<string>,
  ): Promise<OAuthConsentCompletion> {
    record.status = "completing";
    try {
      const code = await issueCode({
        clientId: record.clientId,
        ...(record.clientName ? { clientName: record.clientName } : {}),
        redirectUri: record.redirectUri,
        registeredRedirectUris: record.registeredRedirectUris,
        allowedRedirectOrigins: record.allowedRedirectOrigins,
        scopes: record.scopes,
        resource: record.resource,
        ...(record.state === undefined ? {} : { state: record.state }),
        codeChallenge: record.codeChallenge,
      });
      record.status = "completed";
      record.terminalAt = this.#clock();
      return {
        redirectUri: record.redirectUri,
        ...(record.state === undefined ? {} : { state: record.state }),
        outcome: "allowed",
        code,
      };
    } catch {
      return this.#completeDenied(record, "server_error");
    }
  }

  #completeDenied(
    record: ConsentRecord,
    error: "access_denied" | "server_error",
  ): OAuthConsentCompletion {
    record.status = "completed";
    record.terminalAt = this.#clock();
    return {
      redirectUri: record.redirectUri,
      ...(record.state === undefined ? {} : { state: record.state }),
      outcome: "denied",
      error,
    };
  }

  close(): void {
    for (const record of this.#records.values()) {
      if (record.status === "pending") record.controller.abort();
    }
    this.#records.clear();
  }

  #resolve(id: string, status: "allowed" | "denied"): void {
    this.#prune();
    const record = this.#records.get(id);
    if (!record || record.status !== "pending") return;
    record.status = status;
    record.terminalAt = this.#clock();
  }

  #expireAllPendingAfterClockRollback(): void {
    for (const record of this.#records.values()) {
      if (record.status !== "pending") continue;
      record.status = "expired";
      record.terminalAt = record.createdAt;
      record.controller.abort();
    }
  }

  #pruneClock(): number {
    try {
      return this.#clock();
    } catch (error) {
      if (error instanceof OAuthClockRollbackError) {
        this.#expireAllPendingAfterClockRollback();
      }
      throw error;
    }
  }

  #expireRecord(record: ConsentRecord, now: number): void {
    if (record.status !== "pending" || record.expiresAt > now) return;
    record.status = "expired";
    record.terminalAt = now;
    record.controller.abort();
  }

  #retentionElapsed(record: ConsentRecord, now: number): boolean {
    return (
      record.terminalAt !== undefined && now - record.terminalAt >= this.#terminalRetentionSeconds
    );
  }

  #prune(): void {
    const now = this.#pruneClock();
    for (const [id, record] of this.#records) {
      this.#expireRecord(record, now);
      if (this.#retentionElapsed(record, now)) this.#records.delete(id);
    }
  }

  #makeRoom(): void {
    if (this.#records.size < this.#retainedCap) return;
    const terminal = [...this.#records.values()]
      .filter((record) => record.status !== "pending")
      .sort(
        (left, right) =>
          (left.terminalAt ?? left.createdAt) - (right.terminalAt ?? right.createdAt),
      );
    const oldest = terminal[0];
    if (!oldest) throw new OAuthConsentCapacityError("OAuth consent record limit reached");
    this.#records.delete(oldest.id);
  }

  #newId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = this.#idFactory();
      if (!validOpaqueId(id)) throw new Error("OAuth consent id factory returned an invalid id");
      if (!this.#records.has(id)) return id;
    }
    throw new OAuthConsentCapacityError("OAuth consent id allocation failed");
  }

  #require(id: string): ConsentRecord {
    if (!validOpaqueId(id)) throw new OAuthConsentNotFoundError("OAuth consent not found");
    const record = this.#records.get(id);
    if (!record) throw new OAuthConsentNotFoundError("OAuth consent not found");
    return record;
  }
}

export function oauthWaitingPage(transactionId: string, nonce: string): string {
  if (!validOpaqueId(transactionId) || !validOpaqueId(nonce)) {
    throw new Error("OAuth waiting page received an invalid opaque value");
  }
  const statusPath = `/oauth/consent/${transactionId}/status`;
  const completePath = `/oauth/consent/${transactionId}/complete`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Approve tdmcp connection</title></head>
<body><main><h1>Approve in TouchDesigner</h1><p id="status">Waiting for the artist…</p></main>
<script nonce="${nonce}">
const statusNode = document.getElementById("status");
async function poll() {
  try {
    const response = await fetch("${statusPath}", { cache: "no-store", credentials: "omit" });
    if (!response.ok) { statusNode.textContent = "This request expired. Return to your MCP client."; return; }
    const body = await response.json();
    if (body.status === "ready") { location.replace("${completePath}"); return; }
    setTimeout(poll, 500);
  } catch { statusNode.textContent = "Connection lost. Return to your MCP client."; }
}
setTimeout(poll, 250);
</script></body></html>`;
}
