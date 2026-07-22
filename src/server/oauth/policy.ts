import { isIP } from "node:net";
import { resolve } from "node:path";
import { z } from "zod";

export const OAUTH_SCOPE = "tdmcp:access" as const;
export const DEFAULT_ACCESS_TTL_SECONDS = 15 * 60;
export const DEFAULT_REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
export const DEFAULT_CONSENT_TTL_SECONDS = 60;
export const DEFAULT_REGISTERED_CLIENT_TTL_SECONDS = 7 * 24 * 60 * 60;
export const AUTHORIZATION_CODE_TTL_SECONDS = 60;
export const MAX_REGISTERED_CLIENTS = 128;
export const MAX_TOKEN_ROWS = 2_048;
export const MAX_REFRESH_FAMILIES = 256;
export const MAX_AUTHORIZATION_CODES = 64;
export const MAX_PENDING_CONSENTS = 3;
export const MAX_RETAINED_CONSENTS = 64;
export const MAX_REDIRECT_URIS = 5;
export const MAX_OAUTH_URI_LENGTH = 144;
export const MAX_TRUSTED_PROXY_HOPS = 8;

const NUMERIC_LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);

export interface OAuthPolicyInput {
  publicBaseUrl: string | URL;
  stateDirectory: string;
  allowInsecureLoopback?: boolean;
  redirectOrigins?: readonly string[];
  accessTtlSeconds?: number;
  refreshTtlSeconds?: number;
  consentTtlSeconds?: number;
  registeredClientTtlSeconds?: number;
  trustedProxyHops?: readonly string[];
}

export interface OAuthPolicy {
  issuer: URL;
  resource: URL;
  resourceMetadataUrl: URL;
  stateDirectory: string;
  allowInsecureLoopback: boolean;
  redirectOrigins: ReadonlySet<string>;
  scope: typeof OAUTH_SCOPE;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  consentTtlSeconds: number;
  registeredClientTtlSeconds: number;
  trustedProxyHops: ReadonlySet<string>;
}

function isNumericLoopback(url: URL): boolean {
  return NUMERIC_LOOPBACK_HOSTS.has(url.hostname);
}

function hasForbiddenUrlParts(url: URL): boolean {
  return Boolean(url.username || url.password || url.hash);
}

function hasWildcard(value: string): boolean {
  return value.includes("*");
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function normalizeTrustedProxyHop(raw: string): string {
  const value = raw.startsWith("::ffff:") ? raw.slice("::ffff:".length) : raw;
  if (isIP(value) === 0) {
    throw new Error("OAuth trusted proxy hops must be numeric IP addresses");
  }
  return value.toLowerCase();
}

function parseOrigin(raw: string): string {
  if (hasWildcard(raw)) throw new Error("OAuth redirect origins must not contain wildcards");
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("OAuth redirect origins must use HTTPS");
  if (hasForbiddenUrlParts(url) || url.search || url.pathname !== "/") {
    throw new Error("OAuth redirect origins must be origins without path, query, or fragment");
  }
  if (url.hostname === "localhost" || isNumericLoopback(url)) {
    throw new Error("OAuth HTTPS redirect origins must not be loopback hosts");
  }
  return url.origin;
}

function validateIssuer(input: OAuthPolicyInput): {
  issuer: URL;
  allowInsecureLoopback: boolean;
} {
  if (String(input.publicBaseUrl).length > MAX_OAUTH_URI_LENGTH) {
    throw new Error("OAuth public base URL exceeds its bounded URI contract");
  }
  const issuer = new URL(input.publicBaseUrl);
  const allowInsecureLoopback = input.allowInsecureLoopback === true;
  if (hasWildcard(issuer.href) || hasForbiddenUrlParts(issuer) || issuer.search) {
    throw new Error(
      "OAuth public base URL must not contain wildcard, credentials, query, or fragment",
    );
  }
  if (issuer.pathname !== "/") {
    throw new Error("OAuth public base URL must be an origin without a path");
  }
  if (issuer.hostname === "localhost") {
    throw new Error("OAuth public base URL must use a numeric loopback host, not localhost");
  }
  if (issuer.protocol === "http:" && (!allowInsecureLoopback || !isNumericLoopback(issuer))) {
    throw new Error("OAuth public HTTP is forbidden; only explicit numeric loopback is allowed");
  }
  if (issuer.protocol !== "http:" && issuer.protocol !== "https:") {
    throw new Error("OAuth public base URL must use HTTPS");
  }
  return { issuer, allowInsecureLoopback };
}

function trustedProxyHops(input: OAuthPolicyInput): ReadonlySet<string> {
  const configured = input.trustedProxyHops ?? [];
  if (configured.length > MAX_TRUSTED_PROXY_HOPS) {
    throw new Error(
      `OAuth trusted proxy hops must contain at most ${MAX_TRUSTED_PROXY_HOPS} entries`,
    );
  }
  const normalized = new Set(configured.map(normalizeTrustedProxyHop));
  if (normalized.size !== configured.length) {
    throw new Error("OAuth trusted proxy hops must be unique");
  }
  return normalized;
}

export function createOAuthPolicy(input: OAuthPolicyInput): OAuthPolicy {
  const { issuer, allowInsecureLoopback } = validateIssuer(input);

  const redirectOrigins = new Set((input.redirectOrigins ?? []).map(parseOrigin));
  const normalizedTrustedProxyHops = trustedProxyHops(input);
  const resource = new URL("/mcp", issuer);
  const resourceMetadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", issuer);
  return {
    issuer,
    resource,
    resourceMetadataUrl,
    stateDirectory: resolve(input.stateDirectory),
    allowInsecureLoopback,
    redirectOrigins,
    scope: OAUTH_SCOPE,
    accessTtlSeconds: boundedInteger(
      input.accessTtlSeconds ?? DEFAULT_ACCESS_TTL_SECONDS,
      "OAuth access TTL",
      60,
      3_600,
    ),
    refreshTtlSeconds: boundedInteger(
      input.refreshTtlSeconds ?? DEFAULT_REFRESH_TTL_SECONDS,
      "OAuth refresh TTL",
      3_600,
      90 * 24 * 60 * 60,
    ),
    consentTtlSeconds: boundedInteger(
      input.consentTtlSeconds ?? DEFAULT_CONSENT_TTL_SECONDS,
      "OAuth consent TTL",
      5,
      120,
    ),
    registeredClientTtlSeconds: boundedInteger(
      input.registeredClientTtlSeconds ?? DEFAULT_REGISTERED_CLIENT_TTL_SECONDS,
      "OAuth registered client inactivity TTL",
      3_600,
      365 * 24 * 60 * 60,
    ),
    trustedProxyHops: normalizedTrustedProxyHops,
  };
}

export function validateRedirectUri(raw: string, policy: OAuthPolicy): URL {
  if (raw.length > MAX_OAUTH_URI_LENGTH || hasWildcard(raw)) {
    throw new Error("OAuth redirect URI is invalid");
  }
  const url = new URL(raw);
  if (hasForbiddenUrlParts(url))
    throw new Error("OAuth redirect URI must not contain credentials or fragment");
  if (url.hostname === "localhost") {
    throw new Error("OAuth redirect URI must use a numeric loopback host, not localhost");
  }
  if (url.protocol === "http:") {
    if (!isNumericLoopback(url) || !url.port) {
      throw new Error("HTTP redirects require a numeric loopback host and explicit port");
    }
    return url;
  }
  if (url.protocol !== "https:" || isNumericLoopback(url)) {
    throw new Error("Non-loopback OAuth redirects must use HTTPS");
  }
  if (!policy.redirectOrigins.has(url.origin)) {
    throw new Error("OAuth redirect origin is not allowlisted");
  }
  return url;
}

export function redirectUriMatchesPolicy(
  requestedRaw: string,
  registeredRaw: string,
  policy: OAuthPolicy,
): boolean {
  let requested: URL;
  let registered: URL;
  try {
    requested = validateRedirectUri(requestedRaw, policy);
    registered = validateRedirectUri(registeredRaw, policy);
  } catch {
    return false;
  }
  if (requested.href === registered.href) return true;
  if (
    requested.protocol !== "http:" ||
    registered.protocol !== "http:" ||
    requested.hostname !== registered.hostname
  ) {
    return false;
  }
  return (
    requested.pathname === registered.pathname &&
    requested.search === registered.search &&
    requested.username === registered.username &&
    requested.password === registered.password
  );
}

export function validateExactResource(resource: URL | undefined, policy: OAuthPolicy): URL {
  if (!resource || resource.href !== policy.resource.href) {
    throw new Error("OAuth resource must exactly match the canonical MCP resource");
  }
  return resource;
}

export function validateScopes(scopes: readonly string[] | undefined): [typeof OAUTH_SCOPE] {
  if (!scopes || scopes.length !== 1 || scopes[0] !== OAUTH_SCOPE) {
    throw new Error(`OAuth scope must be exactly ${OAUTH_SCOPE}`);
  }
  return [OAUTH_SCOPE];
}

export const PublicClientRegistrationSchema = z
  .object({
    redirect_uris: z
      .array(z.string().min(1).max(MAX_OAUTH_URI_LENGTH))
      .min(1)
      .max(MAX_REDIRECT_URIS),
    token_endpoint_auth_method: z.literal("none"),
    grant_types: z.tuple([z.literal("authorization_code"), z.literal("refresh_token")]),
    response_types: z.tuple([z.literal("code")]),
    client_name: z.string().trim().min(1).max(80).optional(),
    client_uri: z.string().url().max(512).optional(),
    scope: z.literal(OAUTH_SCOPE).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.client_name && hasControlCharacters(value.client_name)) {
      context.addIssue({
        code: "custom",
        path: ["client_name"],
        message: "control characters are forbidden",
      });
    }
    if (new Set(value.redirect_uris).size !== value.redirect_uris.length) {
      context.addIssue({
        code: "custom",
        path: ["redirect_uris"],
        message: "redirect URIs must be unique",
      });
    }
  });

export type PublicClientRegistration = z.infer<typeof PublicClientRegistrationSchema>;

export function validatePublicClientRegistration(
  value: unknown,
  policy: OAuthPolicy,
): PublicClientRegistration {
  const parsed = PublicClientRegistrationSchema.parse(value);
  for (const uri of parsed.redirect_uris) validateRedirectUri(uri, policy);
  if (parsed.client_uri) {
    const clientUri = new URL(parsed.client_uri);
    if (
      clientUri.protocol !== "https:" ||
      hasForbiddenUrlParts(clientUri) ||
      clientUri.hostname === "localhost" ||
      isNumericLoopback(clientUri)
    ) {
      throw new Error("OAuth client URI must be a public HTTPS URL");
    }
  }
  return parsed;
}
