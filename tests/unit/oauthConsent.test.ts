import { describe, expect, it } from "vitest";
import { OAuthClockRollbackError } from "../../src/server/oauth/clock.js";
import {
  OAuthConsentCapacityError,
  OAuthConsentCoordinator,
  OAuthConsentNotFoundError,
  oauthWaitingPage,
} from "../../src/server/oauth/consent.js";
import { OAUTH_SCOPE } from "../../src/server/oauth/policy.js";

function transaction() {
  return {
    clientId: "client_12345678901234567890",
    clientName: "Unverified client",
    redirectUri: "http://127.0.0.1:3000/callback",
    registeredRedirectUris: ["http://127.0.0.1:3000/callback"],
    allowedRedirectOrigins: [],
    scopes: [OAUTH_SCOPE] as [typeof OAUTH_SCOPE],
    resource: "http://127.0.0.1:3939/mcp",
    state: "client-secret-state",
    codeChallenge: "challenge-that-must-never-reach-the-td-consent-request",
  };
}

describe("OAuth asynchronous consent coordinator", () => {
  it("passes only display-safe fields to consent and completes Allow exactly once", async () => {
    let resolveChoice: (choice: "Allow" | "Deny") => void = () => undefined;
    let observed: Record<string, unknown> | undefined;
    const coordinator = new OAuthConsentCoordinator({
      ttlSeconds: 60,
      idFactory: () => "transaction_123456789012345678901234",
      requester: async (request) => {
        observed = request as unknown as Record<string, unknown>;
        return new Promise((resolve) => {
          resolveChoice = resolve;
        });
      },
    });
    const id = coordinator.start(transaction());
    expect(coordinator.status(id)).toEqual({ status: "pending" });
    expect(observed).not.toHaveProperty("state");
    expect(observed).not.toHaveProperty("codeChallenge");
    expect(observed).toMatchObject({
      transactionId: id,
      clientId: "client_12345678901234567890",
      scopes: [OAUTH_SCOPE],
    });

    resolveChoice("Allow");
    await new Promise((resolve) => setImmediate(resolve));
    expect(coordinator.status(id)).toEqual({ status: "ready" });
    const completion = await coordinator.complete(id, async () => "one-time-code");
    expect(completion).toMatchObject({ outcome: "allowed", code: "one-time-code" });
    await expect(coordinator.complete(id, async () => "another-code")).rejects.toBeInstanceOf(
      OAuthConsentNotFoundError,
    );
  });

  it("maps rejection, non-Allow results, timeout and close to no authorization", async () => {
    let now = 1_000;
    const rejected = new OAuthConsentCoordinator({
      ttlSeconds: 5,
      clock: () => now,
      idFactory: () => "transaction_rejected_123456789012345",
      requester: async () => {
        throw new Error("bridge offline");
      },
    });
    const rejectedId = rejected.start(transaction());
    await Promise.resolve();
    expect(rejected.status(rejectedId)).toEqual({ status: "ready" });
    expect(await rejected.complete(rejectedId, async () => "must-not-run")).toMatchObject({
      outcome: "denied",
      error: "access_denied",
    });

    let aborted = false;
    const timed = new OAuthConsentCoordinator({
      ttlSeconds: 5,
      clock: () => now,
      idFactory: () => "transaction_timeout_1234567890123456",
      requester: async (request) => {
        request.signal.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise(() => undefined);
      },
    });
    const timedId = timed.start(transaction());
    now += 5;
    expect(timed.status(timedId)).toEqual({ status: "ready" });
    expect(aborted).toBe(true);
    expect(await timed.complete(timedId, async () => "must-not-run")).toMatchObject({
      outcome: "denied",
    });

    const closing = new OAuthConsentCoordinator({
      ttlSeconds: 60,
      idFactory: () => "transaction_close_123456789012345678",
      requester: async (request) => {
        request.signal.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise(() => undefined);
      },
    });
    closing.start(transaction());
    aborted = false;
    closing.close();
    expect(aborted).toBe(true);
  });

  it("enforces the pending cap before creating another prompt", () => {
    let sequence = 0;
    const coordinator = new OAuthConsentCoordinator({
      ttlSeconds: 60,
      pendingCap: 3,
      idFactory: () => `transaction_capacity_${String(++sequence).padStart(24, "0")}`,
      requester: async () => new Promise(() => undefined),
    });
    coordinator.start(transaction());
    coordinator.start(transaction());
    coordinator.start(transaction());
    expect(() => coordinator.start(transaction())).toThrow(OAuthConsentCapacityError);
  });

  it("renders a same-origin no-secret polling page", () => {
    const html = oauthWaitingPage(
      "transaction_123456789012345678901234",
      "nonce_1234567890123456789012345",
    );
    expect(html).toContain("/oauth/consent/transaction_123456789012345678901234/status");
    expect(html).toContain('credentials: "omit"');
    expect(html).not.toContain("client-secret-state");
    expect(html).not.toContain("codeChallenge");
    expect(html).not.toContain("access_token");
  });

  it("aborts pending consent and latches failure when the epoch clock moves backwards", () => {
    let now = 1_000;
    let aborted = false;
    const coordinator = new OAuthConsentCoordinator({
      ttlSeconds: 60,
      clock: () => now,
      idFactory: () => "transaction_rollback_1234567890123456",
      requester: async (request) => {
        request.signal.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise(() => undefined);
      },
    });
    const id = coordinator.start(transaction());
    now = 999;
    expect(() => coordinator.status(id)).toThrow(OAuthClockRollbackError);
    expect(aborted).toBe(true);
    now = 1_001;
    expect(() => coordinator.status(id)).toThrow(OAuthClockRollbackError);
  });
});
