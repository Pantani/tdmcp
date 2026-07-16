import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  AccessDeniedError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
  TemporarilyUnavailableError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { createRollbackGuardedClock } from "./clock.js";
import {
  OAuthConsentCapacityError,
  type OAuthConsentCompletion,
  OAuthConsentCoordinator,
  OAuthConsentNotFoundError,
  OAuthConsentPendingError,
  type OAuthConsentRequester,
  type OAuthConsentTransactionInput,
  oauthWaitingPage,
} from "./consent.js";
import {
  AUTHORIZATION_CODE_TTL_SECONDS,
  MAX_AUTHORIZATION_CODES,
  type OAUTH_SCOPE,
  type OAuthPolicy,
  redirectUriMatchesPolicy,
  validateExactResource,
  validateScopes,
} from "./policy.js";
import { OAuthRefreshReplayError, type OAuthStateStore, OAuthTokenInvalidError } from "./store.js";

interface AuthorizationCodeRecord {
  digest: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: [typeof OAUTH_SCOPE];
  codeChallenge: string;
  expiresAt: number;
}

export interface TdmcpOAuthProviderOptions {
  policy: OAuthPolicy;
  store: OAuthStateStore;
  consentRequester: OAuthConsentRequester;
  clock?: () => number;
  tokenFactory?: () => string;
  codeHmacKey?: Buffer;
  consentIdFactory?: () => string;
}

const PKCE_S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/u;
const PKCE_CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/u;

interface OAuthHttpResponse {
  setHeader(name: string, value: string): void;
  status(code: number): OAuthHttpResponse;
  send(body: string): void;
}

function noStoreWaitingHeaders(res: OAuthHttpResponse, nonce: string): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  );
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
}

function validatedAuthorizationTransaction(
  policy: OAuthPolicy,
  client: OAuthClientInformationFull,
  params: AuthorizationParams,
): OAuthConsentTransactionInput {
  const scopes = validateScopes(params.scopes);
  const resource = validateExactResource(params.resource, policy);
  const redirectMatches = client.redirect_uris.some((registered) =>
    redirectUriMatchesPolicy(params.redirectUri, registered, policy),
  );
  if (!redirectMatches) {
    throw new AccessDeniedError("redirect URI is not registered under the tdmcp policy");
  }
  if (!PKCE_S256_CHALLENGE.test(params.codeChallenge)) {
    throw new AccessDeniedError("PKCE S256 challenge is invalid");
  }
  if (params.state !== undefined && params.state.length > 512) {
    throw new AccessDeniedError("OAuth state exceeds 512 characters");
  }
  return {
    clientId: client.client_id,
    ...(client.client_name ? { clientName: client.client_name } : {}),
    redirectUri: params.redirectUri,
    registeredRedirectUris: [...client.redirect_uris],
    allowedRedirectOrigins: [...policy.redirectOrigins],
    scopes,
    resource: resource.href,
    ...(params.state === undefined ? {} : { state: params.state }),
    codeChallenge: params.codeChallenge,
  };
}

function authorizationError(error: unknown): Error {
  if (error instanceof OAuthConsentCapacityError) {
    return new TemporarilyUnavailableError(error.message);
  }
  if (error instanceof AccessDeniedError) return error;
  if (String(error).includes("scope")) return new InvalidScopeError(String(error));
  if (String(error).includes("resource")) return new InvalidTargetError(String(error));
  return new AccessDeniedError("OAuth authorization request was refused");
}

export class TdmcpOAuthProvider implements OAuthServerProvider {
  readonly #policy: OAuthPolicy;
  readonly #store: OAuthStateStore;
  readonly #clock: () => number;
  readonly #tokenFactory: () => string;
  readonly #codeHmacKey: Buffer;
  readonly #codes = new Map<string, AuthorizationCodeRecord>();
  readonly #consents: OAuthConsentCoordinator;
  // SDK 1.29 validates the challenge equality but does not enforce RFC 7636's
  // verifier entropy/length contract. Keep verification in this provider so a
  // one-character verifier can never weaken the authorization code.
  readonly skipLocalPkceValidation = true;

  constructor(options: TdmcpOAuthProviderOptions) {
    this.#policy = options.policy;
    this.#store = options.store;
    this.#clock = createRollbackGuardedClock(
      options.clock ?? (() => Math.floor(Date.now() / 1_000)),
    );
    this.#tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
    this.#codeHmacKey = options.codeHmacKey ?? randomBytes(32);
    this.#consents = new OAuthConsentCoordinator({
      requester: options.consentRequester,
      ttlSeconds: options.policy.consentTtlSeconds,
      clock: this.#clock,
      ...(options.consentIdFactory ? { idFactory: options.consentIdFactory } : {}),
    });
  }

  get clientsStore(): OAuthStateStore {
    return this.#store;
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: OAuthHttpResponse,
  ): Promise<void> {
    try {
      const transaction = validatedAuthorizationTransaction(this.#policy, client, params);
      const transactionId = this.#consents.start(transaction);
      const nonce = randomBytes(18).toString("base64url");
      noStoreWaitingHeaders(res, nonce);
      res.status(202).send(oauthWaitingPage(transactionId, nonce));
    } catch (error) {
      throw authorizationError(error);
    }
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const record = this.#lookupCode(client.client_id, authorizationCode);
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const digest = this.#codeDigest(authorizationCode);
    const record = this.#lookupCode(client.client_id, authorizationCode);
    this.#codes.delete(digest);
    if (!codeVerifier || !PKCE_CODE_VERIFIER.test(codeVerifier)) {
      throw new InvalidGrantError("authorization code PKCE verifier is invalid");
    }
    const computedChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const expectedChallenge = Buffer.from(record.codeChallenge, "ascii");
    const providedChallenge = Buffer.from(computedChallenge, "ascii");
    if (
      expectedChallenge.length !== providedChallenge.length ||
      !timingSafeEqual(expectedChallenge, providedChallenge)
    ) {
      throw new InvalidGrantError("authorization code PKCE verifier mismatch");
    }
    if (!redirectUri || redirectUri !== record.redirectUri) {
      throw new InvalidGrantError("authorization code redirect URI mismatch");
    }
    if (!resource || resource.href !== record.resource) {
      throw new InvalidGrantError("authorization code resource mismatch");
    }
    const pair = await this.#store.issueTokenPair(client.client_id, record.scopes, record.resource);
    return {
      access_token: pair.accessToken,
      refresh_token: pair.refreshToken,
      token_type: "Bearer",
      expires_in: pair.accessExpiresAt - this.#clock(),
      scope: pair.scopes.join(" "),
    };
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    let exactScopes: [typeof OAUTH_SCOPE] | undefined;
    try {
      exactScopes = scopes === undefined ? undefined : validateScopes(scopes);
      const exactResource = validateExactResource(resource, this.#policy);
      const pair = await this.#store.rotateRefreshToken(
        refreshToken,
        client.client_id,
        exactScopes,
        exactResource.href,
      );
      return {
        access_token: pair.accessToken,
        refresh_token: pair.refreshToken,
        token_type: "Bearer",
        expires_in: pair.accessExpiresAt - this.#clock(),
        scope: pair.scopes.join(" "),
      };
    } catch (error) {
      if (error instanceof OAuthRefreshReplayError || error instanceof OAuthTokenInvalidError) {
        throw new InvalidGrantError(error.message);
      }
      if (String(error).includes("scope")) throw new InvalidScopeError(String(error));
      if (String(error).includes("resource")) throw new InvalidTargetError(String(error));
      throw error;
    }
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      const verified = await this.#store.verifyAccessToken(token);
      return {
        token: verified.token,
        clientId: verified.clientId,
        scopes: verified.scopes,
        expiresAt: verified.expiresAt,
        resource: verified.resource,
      };
    } catch (error) {
      if (error instanceof OAuthTokenInvalidError) throw new InvalidTokenError(error.message);
      throw error;
    }
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    await this.#store.revokeToken(client.client_id, request.token);
  }

  authorizationStatus(transactionId: string): { status: "pending" | "ready" } {
    return this.#consents.status(transactionId);
  }

  async completeAuthorization(transactionId: string): Promise<OAuthConsentCompletion> {
    return this.#consents.complete(transactionId, async (input) => this.#issueCode(input));
  }

  close(): void {
    this.#consents.close();
    this.#codes.clear();
    this.#store.close();
  }

  #lookupCode(clientId: string, code: string): AuthorizationCodeRecord {
    this.#pruneCodes();
    const record = this.#codes.get(this.#codeDigest(code));
    if (!record || record.clientId !== clientId || record.expiresAt <= this.#clock()) {
      throw new InvalidGrantError("authorization code is invalid or expired");
    }
    return record;
  }

  async #issueCode(input: {
    clientId: string;
    redirectUri: string;
    scopes: [typeof OAUTH_SCOPE];
    resource: string;
    codeChallenge: string;
  }): Promise<string> {
    this.#pruneCodes();
    if (this.#codes.size >= MAX_AUTHORIZATION_CODES) {
      throw new TemporarilyUnavailableError("OAuth authorization code limit reached");
    }
    const client = await this.#store.getClient(input.clientId);
    if (!client) throw new InvalidGrantError("OAuth client no longer exists");
    if (
      !client.redirect_uris.some((registered) =>
        redirectUriMatchesPolicy(input.redirectUri, registered, this.#policy),
      )
    ) {
      throw new InvalidGrantError("OAuth redirect changed after consent");
    }
    validateScopes(input.scopes);
    validateExactResource(new URL(input.resource), this.#policy);
    if (!PKCE_S256_CHALLENGE.test(input.codeChallenge)) {
      throw new InvalidGrantError("OAuth PKCE challenge changed after consent");
    }
    const code = this.#tokenFactory();
    const digest = this.#codeDigest(code);
    if (this.#codes.has(digest)) throw new TemporarilyUnavailableError("OAuth code collision");
    this.#codes.set(digest, {
      digest,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      resource: input.resource,
      scopes: input.scopes,
      codeChallenge: input.codeChallenge,
      expiresAt: this.#clock() + AUTHORIZATION_CODE_TTL_SECONDS,
    });
    return code;
  }

  #codeDigest(code: string): string {
    return createHmac("sha256", this.#codeHmacKey).update(code, "utf8").digest("hex");
  }

  #pruneCodes(): void {
    const now = this.#clock();
    for (const [digest, record] of this.#codes) {
      if (record.expiresAt <= now) this.#codes.delete(digest);
    }
  }
}

export { OAuthConsentNotFoundError, OAuthConsentPendingError };
