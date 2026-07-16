import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { OAuthPolicy } from "./policy.js";

const FORWARDING_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-real-ip",
] as const;

export class OAuthSourceIdentityError extends Error {
  override readonly name = "OAuthSourceIdentityError";
}

export interface OAuthSourceRequest {
  headers: Record<string, string | readonly string[] | undefined>;
  rawHeaders?: readonly string[];
  socket?: { remoteAddress?: string };
}

export interface OAuthSourceIdentity {
  /** Opaque, process-local rate-limit key. It is never returned or logged. */
  key: string;
  forwarded: boolean;
}

function normalizeAddress(raw: string | undefined): string {
  if (!raw) throw new OAuthSourceIdentityError("OAuth request source is unavailable");
  const value = raw.startsWith("::ffff:") ? raw.slice("::ffff:".length) : raw;
  if (isIP(value) === 0) {
    throw new OAuthSourceIdentityError("OAuth request source is not a numeric IP address");
  }
  return value.toLowerCase();
}

function rawHeaderCount(request: OAuthSourceRequest, name: string): number {
  if (request.rawHeaders) {
    let count = 0;
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      if (request.rawHeaders[index]?.toLowerCase() === name) count += 1;
    }
    return count;
  }
  const value = request.headers[name];
  if (Array.isArray(value)) return value.length;
  return value === undefined ? 0 : 1;
}

function scalarHeader(request: OAuthSourceRequest, name: string): string | undefined {
  const count = rawHeaderCount(request, name);
  if (count > 1) throw new OAuthSourceIdentityError("OAuth forwarding headers are ambiguous");
  const value = request.headers[name];
  if (typeof value === "string" || value === undefined) return value;
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      throw new OAuthSourceIdentityError("OAuth forwarding headers are ambiguous");
    }
    return value[0];
  }
  throw new OAuthSourceIdentityError("OAuth forwarding headers are invalid");
}

function hasForwardingHeaders(request: OAuthSourceRequest): boolean {
  return FORWARDING_HEADERS.some((name) => rawHeaderCount(request, name) > 0);
}

function expectedPort(policy: OAuthPolicy): string {
  if (policy.issuer.port) return policy.issuer.port;
  return policy.issuer.protocol === "https:" ? "443" : "80";
}

function opaqueKey(source: string): string {
  return createHash("sha256").update(`tdmcp-oauth-source\0${source}`, "utf8").digest("hex");
}

interface ForwardingEnvelope {
  rawFor: string;
  host: string;
  proto: string;
  port?: string;
}

function directSourceIdentity(peer: string, policy: OAuthPolicy): OAuthSourceIdentity {
  if (policy.trustedProxyHops.has(peer)) {
    throw new OAuthSourceIdentityError("Trusted OAuth proxy omitted source identity");
  }
  return { key: opaqueKey(peer), forwarded: false };
}

function requireTrustedForwardingPeer(peer: string, policy: OAuthPolicy): void {
  if (!policy.trustedProxyHops.has(peer)) {
    throw new OAuthSourceIdentityError("OAuth forwarding headers came from an untrusted peer");
  }
}

function rejectUnsupportedForwardingHeaders(request: OAuthSourceRequest): void {
  if (scalarHeader(request, "forwarded") !== undefined) {
    throw new OAuthSourceIdentityError(
      "RFC Forwarded is not accepted alongside the pinned proxy contract",
    );
  }
  if (scalarHeader(request, "x-real-ip") !== undefined) {
    throw new OAuthSourceIdentityError(
      "X-Real-IP is not accepted alongside the pinned proxy contract",
    );
  }
}

function forwardingEnvelope(request: OAuthSourceRequest): ForwardingEnvelope {
  const rawFor = scalarHeader(request, "x-forwarded-for");
  const host = scalarHeader(request, "x-forwarded-host");
  const proto = scalarHeader(request, "x-forwarded-proto");
  const port = scalarHeader(request, "x-forwarded-port");
  if (!rawFor || !host || !proto) {
    throw new OAuthSourceIdentityError("OAuth proxy source, host, and protocol are required");
  }
  if (host.includes(",") || proto.includes(",") || port?.includes(",")) {
    throw new OAuthSourceIdentityError("OAuth forwarding headers are ambiguous");
  }
  return { rawFor, host, proto, ...(port === undefined ? {} : { port }) };
}

function validateCanonicalForwarding(envelope: ForwardingEnvelope, policy: OAuthPolicy): void {
  if (envelope.host.trim().toLowerCase() !== policy.issuer.host.toLowerCase()) {
    throw new OAuthSourceIdentityError("OAuth forwarded host does not match canonical identity");
  }
  if (`${envelope.proto.trim().toLowerCase()}:` !== policy.issuer.protocol) {
    throw new OAuthSourceIdentityError(
      "OAuth forwarded protocol does not match canonical identity",
    );
  }
  if (envelope.port && envelope.port.trim() !== expectedPort(policy)) {
    throw new OAuthSourceIdentityError("OAuth forwarded port does not match canonical identity");
  }
}

function forwardedClientSource(rawFor: string, policy: OAuthPolicy): string {
  const chain = rawFor.split(",").map((value) => normalizeAddress(value.trim()));
  if (chain.length < 1 || chain.length > policy.trustedProxyHops.size + 1) {
    throw new OAuthSourceIdentityError("OAuth forwarding chain exceeds its configured bound");
  }
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const candidate = chain[index];
    if (!candidate || policy.trustedProxyHops.has(candidate)) continue;
    return candidate;
  }
  throw new OAuthSourceIdentityError("OAuth forwarding chain has no untrusted client hop");
}

/**
 * Resolves one source identity without trusting client-supplied forwarding
 * metadata. Direct requests use the socket peer. Forwarding metadata is
 * accepted only when the immediate peer and every stripped right-hand proxy
 * are explicitly configured trusted hops. The first untrusted address from the
 * right is the client identity; client-controlled values further left cannot
 * override it.
 */
export function resolveOAuthSourceIdentity(
  request: OAuthSourceRequest,
  policy: OAuthPolicy,
): OAuthSourceIdentity {
  const peer = normalizeAddress(request.socket?.remoteAddress);
  const forwarded = hasForwardingHeaders(request);
  if (!forwarded) return directSourceIdentity(peer, policy);

  requireTrustedForwardingPeer(peer, policy);
  rejectUnsupportedForwardingHeaders(request);
  const envelope = forwardingEnvelope(request);
  validateCanonicalForwarding(envelope, policy);
  const source = forwardedClientSource(envelope.rawFor, policy);
  return { key: opaqueKey(source), forwarded: true };
}
