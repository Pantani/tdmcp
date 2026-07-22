import { randomBytes } from "node:crypto";
import { authorizationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { revocationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/revoke.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type {
  OAuthMetadata,
  OAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import express from "express";
import { createRollbackGuardedClock, OAuthClockRollbackError } from "./clock.js";
import { OAUTH_SCOPE, type OAuthPolicy } from "./policy.js";
import {
  OAuthConsentNotFoundError,
  OAuthConsentPendingError,
  type TdmcpOAuthProvider,
} from "./provider.js";
import {
  type OAuthSourceIdentity,
  OAuthSourceIdentityError,
  type OAuthSourceRequest,
  resolveOAuthSourceIdentity,
} from "./sourceIdentity.js";
import { type OAuthStateStore, OAuthStoreCapacityError } from "./store.js";

export interface TdmcpOAuthRouterOptions {
  policy: OAuthPolicy;
  provider: TdmcpOAuthProvider;
  store: OAuthStateStore;
  registrationLimitPerHour?: number;
  clock?: () => number;
}

const OAUTH_SOURCE_IDENTITY = Symbol("tdmcp.oauthSourceIdentity");

interface HttpRequest extends OAuthSourceRequest {
  body: unknown;
  params: Record<string, string | undefined>;
  [OAUTH_SOURCE_IDENTITY]?: OAuthSourceIdentity;
}

interface HttpResponse {
  setHeader(name: string, value: string): void;
  status(code: number): HttpResponse;
  json(body: unknown): void;
  end(): void;
}

type NextFunction = () => void;
type RequestHandlerLike = (req: HttpRequest, res: HttpResponse, next: NextFunction) => void;
type RouterLike = ReturnType<typeof express.Router>;

function setNoStore(res: HttpResponse): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function requireSourceIdentity(policy: OAuthPolicy): RequestHandlerLike {
  return (req, res, next) => {
    try {
      req[OAUTH_SOURCE_IDENTITY] = resolveOAuthSourceIdentity(req, policy);
      next();
    } catch (error) {
      if (!(error instanceof OAuthSourceIdentityError)) throw error;
      setNoStore(res);
      res.status(403).json({ error: "invalid_request_source" });
    }
  };
}

interface RegistrationBucket {
  available: number;
  lastSeenAt: number;
}

interface RegistrationLimitState {
  lastRefillAt: number;
  globalAvailable: number;
  sources: Map<string, RegistrationBucket>;
}

function registrationClock(clock: () => number, res: HttpResponse): number | undefined {
  try {
    return clock();
  } catch (error) {
    if (!(error instanceof OAuthClockRollbackError)) throw error;
    res.status(503).json({
      error: "temporarily_unavailable",
      error_description: "OAuth clock safety check failed",
    });
    return undefined;
  }
}

function refillRegistrationBuckets(
  state: RegistrationLimitState,
  now: number,
  maximum: number,
  globalMaximum: number,
  sourceTtlSeconds: number,
): void {
  if (now <= state.lastRefillAt) return;
  const elapsed = now - state.lastRefillAt;
  state.globalAvailable = Math.min(
    globalMaximum,
    state.globalAvailable + (elapsed * globalMaximum) / 3_600,
  );
  for (const [key, bucket] of state.sources) {
    if (now - bucket.lastSeenAt >= sourceTtlSeconds) {
      state.sources.delete(key);
      continue;
    }
    bucket.available = Math.min(maximum, bucket.available + (elapsed * maximum) / 3_600);
  }
  state.lastRefillAt = now;
}

function oldestSourceKey(sources: ReadonlyMap<string, RegistrationBucket>): string | undefined {
  let oldestKey: string | undefined;
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const [key, candidate] of sources) {
    if (candidate.lastSeenAt >= oldestAt) continue;
    oldestAt = candidate.lastSeenAt;
    oldestKey = key;
  }
  return oldestKey;
}

function sourceBucket(
  state: RegistrationLimitState,
  identityKey: string,
  now: number,
  maximum: number,
  maxSources: number,
): RegistrationBucket {
  const existing = state.sources.get(identityKey);
  if (existing) return existing;
  if (state.sources.size >= maxSources) {
    const oldestKey = oldestSourceKey(state.sources);
    if (oldestKey) state.sources.delete(oldestKey);
  }
  const created = { available: maximum, lastSeenAt: now };
  state.sources.set(identityKey, created);
  return created;
}

function rejectRegistrationRateLimit(res: HttpResponse): void {
  res.status(429).json({
    error: "temporarily_unavailable",
    error_description: "registration rate limit reached",
  });
}

function createRegistrationLimit(maximum: number, clock: () => number): RequestHandlerLike {
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 3_600) {
    throw new Error("OAuth registration rate must be an integer between 1 and 3600 per hour");
  }
  const globalMaximum = Math.min(3_600, maximum * 16);
  const sourceTtlSeconds = 2 * 3_600;
  const maxSources = 256;
  const guardedClock = createRollbackGuardedClock(clock);
  const state: RegistrationLimitState = {
    lastRefillAt: guardedClock(),
    globalAvailable: globalMaximum,
    sources: new Map(),
  };
  return (req, res, next) => {
    const identity = req[OAUTH_SOURCE_IDENTITY];
    if (!identity) {
      res.status(403).json({ error: "invalid_request_source" });
      return;
    }
    const now = registrationClock(guardedClock, res);
    if (now === undefined) return;
    refillRegistrationBuckets(state, now, maximum, globalMaximum, sourceTtlSeconds);
    const source = sourceBucket(state, identity.key, now, maximum, maxSources);
    source.lastSeenAt = now;
    if (source.available < 1 || state.globalAvailable < 1) {
      rejectRegistrationRateLimit(res);
      return;
    }
    source.available -= 1;
    state.globalAvailable -= 1;
    next();
  };
}

function registrationRouter(options: TdmcpOAuthRouterOptions): RouterLike {
  const router = express.Router();
  const clock = options.clock ?? (() => Math.floor(Date.now() / 1_000));
  router.use((_req: HttpRequest, res: HttpResponse, next: NextFunction) => {
    setNoStore(res);
    next();
  });
  router.options("/", (_req: HttpRequest, res: HttpResponse) => res.status(204).end());
  router.use(createRegistrationLimit(options.registrationLimitPerHour ?? 20, clock));
  router.use(express.json({ limit: "16kb", strict: true }));
  router.post("/", async (req: HttpRequest, res: HttpResponse) => {
    try {
      const client = await options.store.registerPublicClient(req.body);
      res.status(201).json(client);
    } catch (error) {
      if (error instanceof OAuthStoreCapacityError) {
        res
          .status(429)
          .json({ error: "temporarily_unavailable", error_description: error.message });
        return;
      }
      res.status(400).json({ error: "invalid_client_metadata" });
    }
  });
  router.use((error: unknown, _req: HttpRequest, res: HttpResponse, _next: NextFunction) => {
    res.status(400).json({
      error: "invalid_client_metadata",
      ...(error instanceof Error && error.message.includes("too large")
        ? { error_description: "registration payload is too large" }
        : {}),
    });
  });
  return router;
}

export function oauthMetadata(policy: OAuthPolicy): OAuthMetadata {
  return {
    issuer: policy.issuer.href,
    authorization_endpoint: new URL("/authorize", policy.issuer).href,
    token_endpoint: new URL("/token", policy.issuer).href,
    registration_endpoint: new URL("/register", policy.issuer).href,
    revocation_endpoint: new URL("/revoke", policy.issuer).href,
    scopes_supported: [OAUTH_SCOPE],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
  };
}

export function protectedResourceMetadata(policy: OAuthPolicy): OAuthProtectedResourceMetadata {
  return {
    resource: policy.resource.href,
    authorization_servers: [policy.issuer.href],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "tdmcp TouchDesigner MCP server",
  };
}

export function createTdmcpOAuthRouter(options: TdmcpOAuthRouterOptions): RouterLike {
  const router = express.Router();
  const metadata = oauthMetadata(options.policy);
  const protectedMetadata = protectedResourceMetadata(options.policy);

  router.use(requireSourceIdentity(options.policy));

  router.get(
    "/.well-known/oauth-protected-resource/mcp",
    (_req: HttpRequest, res: HttpResponse) => {
      res.status(200).json(protectedMetadata);
    },
  );
  router.get("/.well-known/oauth-authorization-server", (_req: HttpRequest, res: HttpResponse) => {
    res.status(200).json(metadata);
  });
  router.use("/register", registrationRouter(options));
  router.use("/authorize", authorizationHandler({ provider: options.provider }));
  router.use("/token", suppressCorsHeaders, tokenHandler({ provider: options.provider }));
  router.use("/revoke", suppressCorsHeaders, revocationHandler({ provider: options.provider }));

  router.get("/oauth/consent/:transactionId/status", (req: HttpRequest, res: HttpResponse) => {
    setNoStore(res);
    try {
      res.status(200).json(options.provider.authorizationStatus(req.params.transactionId ?? ""));
    } catch (error) {
      if (error instanceof OAuthConsentNotFoundError) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.status(500).json({ error: "server_error" });
    }
  });

  router.get(
    "/oauth/consent/:transactionId/complete",
    async (req: HttpRequest, res: HttpResponse) => {
      setNoStore(res);
      try {
        const completion = await options.provider.completeAuthorization(
          req.params.transactionId ?? "",
        );
        const redirect = new URL(completion.redirectUri);
        if (completion.outcome === "allowed" && completion.code)
          redirect.searchParams.set("code", completion.code);
        else redirect.searchParams.set("error", completion.error ?? "access_denied");
        if (completion.state !== undefined) redirect.searchParams.set("state", completion.state);
        res.status(302).setHeader("Location", redirect.href);
        res.end();
      } catch (error) {
        if (error instanceof OAuthConsentPendingError) {
          res.status(409).json({ error: "authorization_pending" });
          return;
        }
        if (error instanceof OAuthConsentNotFoundError) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        res.status(500).json({ error: "server_error" });
      }
    },
  );

  return router;
}

function suppressCorsHeaders(
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const original = res.setHeader.bind(res);
  res.setHeader = ((name: string, value: number | string | readonly string[]) => {
    if (name.toLowerCase().startsWith("access-control-")) return res;
    return original(name, value);
  }) as typeof res.setHeader;
  next();
}

export function createOAuthBearerMiddleware(
  policy: OAuthPolicy,
  provider: TdmcpOAuthProvider,
): ReturnType<typeof requireBearerAuth> {
  return requireBearerAuth({
    verifier: provider,
    requiredScopes: [OAUTH_SCOPE],
    resourceMetadataUrl: policy.resourceMetadataUrl.href,
  });
}

export function opaqueTestValue(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}
