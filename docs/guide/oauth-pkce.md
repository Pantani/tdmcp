---
description: "Opt-in OAuth 2.1-style authorization for tdmcp Streamable HTTP, with S256 PKCE and fail-closed TouchDesigner-native consent."
---

# OAuth, PKCE & TouchDesigner consent

<FeatureAvailability status="source-only" locale="en" />

tdmcp can protect its Streamable HTTP `/mcp` endpoint with an opt-in,
co-located authorization server. The Node process owns discovery, client
registration, authorization codes and tokens. TouchDesigner only displays one
bounded **Allow / Deny** decision in the existing non-modal Interactions inbox.
Codes, PKCE verifiers, OAuth state and bearer tokens never enter the TD project.

This mode targets a single-owner tdmcp deployment. Use an external identity
provider/authorization server for shared, federated or multi-user deployments.

## Compatibility and modes

`TDMCP_HTTP_AUTH_MODE` accepts five values:

| Mode | Meaning |
| --- | --- |
| `auto` | Compatibility default: use `static` when `TDMCP_HTTP_AUTH_TOKEN` exists, otherwise `none`. OAuth is never enabled implicitly. |
| `none` | No HTTP bearer authentication. Startup refuses an ignored static token. |
| `static` | Existing pre-shared bearer token only. This is not OAuth. |
| `oauth` | OAuth authorization-code flow with required S256 PKCE. Startup refuses a static token. |
| `hybrid` | Explicit migration mode that accepts both OAuth access tokens and the configured legacy static bearer. |

There is no silent downgrade. Invalid combinations fail startup. The
TouchDesigner bridge bearer (`TDMCP_BRIDGE_TOKEN`) is a separate credential and
still authenticates Node-to-TD REST calls.

## Local loopback setup

Plain HTTP is allowed only as an explicit development exception on numeric
loopback. `localhost`, wildcard binds and non-loopback HTTP are refused.

```bash
export TDMCP_TRANSPORT=http
export TDMCP_HTTP_HOST=127.0.0.1
export TDMCP_HTTP_PORT=3939
export TDMCP_HTTP_AUTH_MODE=oauth
export TDMCP_PUBLIC_BASE_URL=http://127.0.0.1:3939
export TDMCP_OAUTH_ALLOW_INSECURE_LOOPBACK=1
export TDMCP_BRIDGE_TOKEN='separate-bridge-secret'

tdmcp
```

Production/public use requires one canonical HTTPS origin in
`TDMCP_PUBLIC_BASE_URL`, an exact external Host, an owner-private OAuth state
directory and TLS termination at a trusted reverse proxy on the same host. The
Node HTTP listener still binds numeric loopback; wildcard/LAN OAuth binds fail
startup so cleartext cannot be exposed directly.

## Client and redirect policy

Wave 11 exposes bounded Dynamic Client Registration for public clients only:

- authorization-code plus rotating refresh-token grants;
- `token_endpoint_auth_method: "none"`;
- exact scope `tdmcp:access` and exact resource `<public-base>/mcp`;
- required `code_challenge_method=S256`; plain or missing PKCE is rejected;
- numeric loopback HTTP callbacks with an explicit port;
- non-loopback callbacks only over HTTPS and only from origins listed in
  `TDMCP_OAUTH_REDIRECT_ORIGINS`.

Registered public clients have a **seven-day default inactivity lifetime**
(bounded internally from one hour to 365 days). The inactivity clock starts at
registration and advances on security-relevant token issuance/refresh, not on
an unauthenticated client lookup. Once the lifetime expires, a client with no
live token row is pruned. At the 128-client capacity boundary, registration
evicts the oldest tokenless client before refusing the new client; any client
that still owns a non-expired, non-revoked access or refresh row is retained.
The lifetime is policy-construction state in this source tree, not a documented
environment variable.

Unauthenticated DCR uses a continuously refilling bucket per opaque source (20
registrations/hour by default) under a separate global ceiling of 16 times that
rate, capped at 3,600. Source state is bounded to 256 entries and expires after
two hours. Direct requests use the numeric socket peer. Forwarding headers are
accepted only when the immediate peer and every stripped proxy hop are explicitly
pinned by `TDMCP_OAUTH_TRUSTED_PROXY_HOPS`; ambiguous, non-numeric, untrusted or
canonical-host/protocol-mismatched forwarding fails closed. Source keys are
process-local hashes and are neither returned nor logged.

Client ID Metadata Documents are not implemented in this wave. DCR is the
supported public-client registration path; clients that require CIMD need a
later, separately threat-modelled interoperability wave.

Discovery is path-specific at
`/.well-known/oauth-protected-resource/mcp`; the legacy root protected-resource
metadata URL intentionally returns 404. Authorization-server metadata is at
`/.well-known/oauth-authorization-server`.

## Native consent and failure behavior

Opening `/authorize` returns a small `202` waiting page immediately; it does not
hold the original request open while TouchDesigner waits. The TD inbox shows the
bounded self-asserted client name, redirect, resource and scope with exact choices
**Allow / Deny**. Only a consumed, target-matching **Allow** can create a code.

The fail-closed contract maps close, timeout, disconnect, duplicate consumption,
queue saturation, Perform Mode, missing/headless UI, scheduling error or Node
shutdown to **Deny**. A disposable TD 2025.32820 sandbox passed Allow, Deny,
timeout, close, disconnect and Perform-mode denial through the native callback
transport. Actual headless TD, a physical pointer click and production HTTPS/TLS
deployment remain UNVERIFIED. Panic, blackout and emergency paths never wait for
OAuth consent.
`TDMCP_BRIDGE_ALLOW_EXEC=0` remains supported because consent uses structured,
authenticated bridge routes, not `/api/exec`.

The OAuth state directory stores public client metadata and HMAC digests of
access/refresh tokens in owner-private, atomically replaced files. Raw tokens,
authorization codes and pending consent are not persisted. Access tokens
default to 15 minutes; refresh tokens default to 30 days and rotate on use.

## Evidence examples

```json
{
  "status": "PASS",
  "evidence": "offline authorization issued a scoped token only after simulated Allow; DCR pruned expired tokenless rows, evicted the oldest tokenless row at capacity and retained a live-token owner"
}
```

```json
{
  "status": "FAIL",
  "evidence": "startup refused oauth mode with a legacy static token instead of silently accepting it"
}
```

```json
{
  "status": "UNVERIFIED",
  "reason": "final integrated TD-native prompt was not exercised in a fresh disposable sandbox",
  "checks": ["Allow and Deny in TD 2025.32820", "Perform/headless UI", "production HTTPS deployment"]
}
```

Offline proof is not live TouchDesigner proof. Keep the final rows UNVERIFIED
until a fresh isolated bridge runs them without a thread-conflict alert.

## Configuration reference

See [Environment variables](/reference/environment) for body limits, redirect
origins, state paths and bounded token/consent TTLs. There is currently no
public environment variable for registered-client inactivity. `tdmcp status`
reports only the resolved HTTP auth mode; it never prints tokens or the bridge
bearer.
