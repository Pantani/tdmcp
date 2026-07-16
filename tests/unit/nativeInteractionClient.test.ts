import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { TdApiError } from "../../src/td-client/types.js";
import { BatchOperationSchema, CreateNodeInputSchema } from "../../src/td-client/validators.js";

const BASE = "http://127.0.0.1:9980";
const ok = (data: unknown) => HttpResponse.json({ ok: true, data });
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function interaction(
  state: "pending" | "resolved" | "expired" | "cancelled" | "failed",
  choice: string | null,
  kind:
    | "delete_node"
    | "save_overwrite"
    | "artifact_overwrite"
    | "oauth_client_consent" = "delete_node",
) {
  const choices =
    kind === "delete_node"
      ? ["Delete", "Bypass", "Keep"]
      : kind === "oauth_client_consent"
        ? ["Allow", "Deny"]
        : ["Overwrite", "Keep"];
  return {
    request_id: "opaque-request-id-1234567890",
    kind,
    state,
    choices,
    created_at: 1,
    expires_at: 31,
    consumed: false,
    result: choice === null ? null : { choice, reason: "user_choice", at: 2 },
  };
}

const nodeDetail = {
  path: "/project1/noise1",
  type: "noiseTOP",
  name: "noise1",
  parameters: {},
};

describe("TouchDesignerClient native interaction flows", () => {
  const oauthRequest = {
    transactionId: "transaction_opaque_1234567890123456",
    clientId: "client_123",
    clientName: "Studio controller",
    redirectUri: "http://127.0.0.1:4567/callback",
    registeredRedirectUris: ["http://127.0.0.1:4567/callback"],
    allowedRedirectOrigins: [],
    resource: "http://127.0.0.1:3939/mcp",
    scopes: ["tdmcp:access"] as const,
    ttlSeconds: 5,
  };

  it("issues OAuth Allow only after the exact TD ticket is consumed", async () => {
    let interactionTarget: unknown;
    server.use(
      http.post(`${BASE}/api/interactions`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        expect(body.kind).toBe("oauth_client_consent");
        expect(body.dedupe_key).toBe(oauthRequest.transactionId);
        expect(body).not.toHaveProperty("code");
        expect(body).not.toHaveProperty("code_verifier");
        expect(body).not.toHaveProperty("state");
        interactionTarget = body.target;
        return ok(interaction("resolved", "Allow", "oauth_client_consent"));
      }),
      http.post(`${BASE}/api/oauth/consents/:id/consume`, async ({ request }) => {
        const body = (await request.json()) as { target: unknown };
        expect(body.target).toEqual(interactionTarget);
        return ok({
          request_id: "opaque-request-id-1234567890",
          state: "resolved",
          accepted: true,
          decision: "Allow",
          error: null,
        });
      }),
    );
    await expect(
      new TouchDesignerClient({ baseUrl: BASE }).requestOAuthConsent(oauthRequest),
    ).resolves.toBe("Allow");
  });

  it("recovers one lost OAuth enqueue response with the identical dedupe target", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let calls = 0;
    server.use(
      http.post(`${BASE}/api/interactions`, async ({ request }) => {
        calls += 1;
        bodies.push((await request.json()) as Record<string, unknown>);
        if (calls === 1) return HttpResponse.error();
        return ok(interaction("resolved", "Allow", "oauth_client_consent"));
      }),
      http.post(`${BASE}/api/oauth/consents/:id/consume`, () =>
        ok({
          request_id: "opaque-request-id-1234567890",
          state: "resolved",
          accepted: true,
          decision: "Allow",
          error: null,
        }),
      ),
    );
    await expect(
      new TouchDesignerClient({ baseUrl: BASE, retries: 3 }).requestOAuthConsent(oauthRequest),
    ).resolves.toBe("Allow");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.dedupe_key).toBe(bodies[1]?.dedupe_key);
    expect(bodies[0]?.target).toEqual(bodies[1]?.target);
  });

  it.each(["Deny", "Keep"])("fails OAuth closed for terminal choice %s", async (choice) => {
    let consumeCalls = 0;
    server.use(
      http.post(`${BASE}/api/interactions`, () =>
        ok(interaction("resolved", choice, "oauth_client_consent")),
      ),
      http.post(`${BASE}/api/oauth/consents/:id/consume`, () => {
        consumeCalls += 1;
        return ok({
          request_id: "opaque-request-id-1234567890",
          state: "resolved",
          accepted: choice === "Deny",
          decision: "Deny",
          error: choice === "Deny" ? null : "invalid_choice",
        });
      }),
    );
    await expect(
      new TouchDesignerClient({ baseUrl: BASE }).requestOAuthConsent(oauthRequest),
    ).resolves.toBe("Deny");
    expect(consumeCalls).toBe(1);
  });

  it("reads only the bounded content-free interaction summary", async () => {
    server.use(
      http.get(`${BASE}/api/interactions/status`, () =>
        ok({
          pending_count: 1,
          pending_limit: 3,
          active: true,
          delivery_configured: true,
        }),
      ),
    );
    await expect(
      new TouchDesignerClient({ baseUrl: BASE }).getInteractionSummary(),
    ).resolves.toEqual({
      pending_count: 1,
      pending_limit: 3,
      active: true,
      delivery_configured: true,
    });
  });

  it("rejects interaction summaries that leak prompt content", async () => {
    server.use(
      http.get(`${BASE}/api/interactions/status`, () =>
        ok({
          pending_count: 1,
          pending_limit: 3,
          active: true,
          delivery_configured: true,
          prompt: "secret project content",
        }),
      ),
    );
    await expect(
      new TouchDesignerClient({ baseUrl: BASE }).getInteractionSummary(),
    ).rejects.toBeInstanceOf(TdApiError);
  });

  it("preserves typed bridge codes for invalid Pulse parameters", async () => {
    server.use(
      http.post(`${BASE}/api/nodes/:path/params/:parameter/pulse`, () =>
        HttpResponse.json(
          {
            ok: false,
            error: {
              code: "invalid_parameter_type",
              message: "Parameter speed is Float, not Pulse",
            },
          },
          { status: 400 },
        ),
      ),
    );
    const error = await new TouchDesignerClient({ baseUrl: BASE })
      .pulseParameter("/project1/movie1", "speed")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TdApiError);
    expect(error).toMatchObject({ apiCode: "invalid_parameter_type", status: 400 });
  });

  it("binds delete approval to an opaque ticket before the final mutation", async () => {
    let mutationCount = 0;
    server.use(
      http.get(`${BASE}/api/nodes/:path`, () => ok(nodeDetail)),
      http.post(`${BASE}/api/interactions`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        expect(body.kind).toBe("delete_node");
        expect(body.target).toEqual({ path: nodeDetail.path });
        expect(body).not.toHaveProperty("target_fingerprint");
        expect(body).not.toHaveProperty("choices");
        return ok(interaction("resolved", "Delete"));
      }),
      http.delete(`${BASE}/api/nodes/:path`, ({ request }) => {
        mutationCount += 1;
        const query = new URL(request.url).searchParams;
        expect(query.get("interaction_id")).toBe("opaque-request-id-1234567890");
        expect(query.get("confirmation_policy")).toBe("native");
        return ok({
          deleted: nodeDetail.path,
          mode: "delete",
          decision: "Delete",
          original_path: nodeDetail.path,
          final_path: null,
          action_applied: "delete",
          applied: true,
          request_id: query.get("interaction_id"),
          confirmation_policy: "native",
        });
      }),
    );
    const client = new TouchDesignerClient({ baseUrl: BASE });
    const result = await client.deleteNode(nodeDetail.path, "delete", { timeoutMs: 5_000 });
    expect(result.decision).toBe("Delete");
    expect(mutationCount).toBe(1);
  });

  it("polls a pending ticket until it resolves before mutating", async () => {
    let pollCount = 0;
    let mutationCount = 0;
    server.use(
      http.get(`${BASE}/api/nodes/:path`, () => ok(nodeDetail)),
      http.post(`${BASE}/api/interactions`, () => ok(interaction("pending", null))),
      http.get(`${BASE}/api/interactions/:id`, () => {
        pollCount += 1;
        return ok(interaction("resolved", "Delete"));
      }),
      http.delete(`${BASE}/api/nodes/:path`, () => {
        mutationCount += 1;
        return ok({
          deleted: nodeDetail.path,
          mode: "delete",
          decision: "Delete",
          original_path: nodeDetail.path,
          final_path: null,
          action_applied: "delete",
          applied: true,
          request_id: "opaque-request-id-1234567890",
          confirmation_policy: "native",
        });
      }),
    );
    const result = await new TouchDesignerClient({ baseUrl: BASE }).deleteNode(
      nodeDetail.path,
      "delete",
      { timeoutMs: 1_000 },
    );
    expect(result.decision).toBe("Delete");
    expect(pollCount).toBe(1);
    expect(mutationCount).toBe(1);
  });

  it("cancels a still-pending ticket at the client deadline without mutating", async () => {
    let cancelCount = 0;
    let mutationCount = 0;
    server.use(
      http.get(`${BASE}/api/nodes/:path`, () => ok(nodeDetail)),
      http.post(`${BASE}/api/interactions`, () => ok(interaction("pending", null))),
      http.get(`${BASE}/api/interactions/:id`, () => ok(interaction("pending", null))),
      http.post(`${BASE}/api/interactions/:id/cancel`, () => {
        cancelCount += 1;
        return ok(interaction("cancelled", "Keep"));
      }),
      http.delete(`${BASE}/api/nodes/:path`, () => {
        mutationCount += 1;
        return HttpResponse.error();
      }),
    );
    const result = await new TouchDesignerClient({ baseUrl: BASE }).deleteNode(
      nodeDetail.path,
      "delete",
      { timeoutMs: 20 },
    );
    expect(result.decision).toBe("Keep");
    expect(cancelCount).toBe(1);
    expect(mutationCount).toBe(0);
  });

  it.each([
    ["expired", "Keep"],
    ["cancelled", "Keep"],
    ["failed", "Keep"],
  ] as const)("fails closed without a DELETE when the broker is %s", async (state, choice) => {
    let mutationCount = 0;
    server.use(
      http.get(`${BASE}/api/nodes/:path`, () => ok(nodeDetail)),
      http.post(`${BASE}/api/interactions`, () => ok(interaction(state, choice))),
      http.delete(`${BASE}/api/nodes/:path`, () => {
        mutationCount += 1;
        return HttpResponse.error();
      }),
    );
    const client = new TouchDesignerClient({ baseUrl: BASE });
    const result = await client.deleteNode(nodeDetail.path, "delete", { timeoutMs: 5_000 });
    expect(result.decision).toBe("Keep");
    expect(result.applied).toBe(false);
    expect(mutationCount).toBe(0);
  });

  it("polls with one bounded GET attempt and cancels fail-closed on disconnect", async () => {
    let pollCount = 0;
    let cancelCount = 0;
    let mutationCount = 0;
    server.use(
      http.get(`${BASE}/api/nodes/:path`, () => ok(nodeDetail)),
      http.post(`${BASE}/api/interactions`, () => ok(interaction("pending", null))),
      http.get(`${BASE}/api/interactions/:id`, () => {
        pollCount += 1;
        return HttpResponse.json(
          { ok: false, error: { message: "bridge disconnected" } },
          { status: 503 },
        );
      }),
      http.post(`${BASE}/api/interactions/:id/cancel`, () => {
        cancelCount += 1;
        return ok(interaction("cancelled", "Keep"));
      }),
      http.delete(`${BASE}/api/nodes/:path`, () => {
        mutationCount += 1;
        return HttpResponse.error();
      }),
    );
    const result = await new TouchDesignerClient({
      baseUrl: BASE,
      retries: 2,
    }).deleteNode(nodeDetail.path, "delete", { timeoutMs: 5_000 });
    expect(result.decision).toBe("Keep");
    expect(pollCount).toBe(1);
    expect(cancelCount).toBe(1);
    expect(mutationCount).toBe(0);
  });

  it("keeps explicit YOLO auditable and skips the broker", async () => {
    let interactionCount = 0;
    server.use(
      http.post(`${BASE}/api/interactions`, () => {
        interactionCount += 1;
        return HttpResponse.error();
      }),
      http.delete(`${BASE}/api/nodes/:path`, ({ request }) => {
        expect(new URL(request.url).searchParams.get("confirmation_policy")).toBe("yolo");
        return ok({
          deleted: nodeDetail.path,
          mode: "delete",
          decision: "Delete",
          original_path: nodeDetail.path,
          final_path: null,
          action_applied: "delete",
          applied: true,
          confirmation_policy: "yolo",
        });
      }),
    );
    const result = await new TouchDesignerClient({ baseUrl: BASE }).deleteNode(
      nodeDetail.path,
      "delete",
      { confirmationPolicy: "yolo" },
    );
    expect(result.confirmation_policy).toBe("yolo");
    expect(interactionCount).toBe(0);
  });

  it("requires resolved overwrite consent before the second Save As request", async () => {
    let saveCalls = 0;
    server.use(
      http.post(`${BASE}/api/project/save`, async ({ request }) => {
        saveCalls += 1;
        const body = (await request.json()) as { path: string; interaction_id?: string };
        if (saveCalls === 1) {
          return HttpResponse.json(
            {
              ok: false,
              error: {
                message:
                  "project save: existing Save As target requires resolved Overwrite approval",
              },
            },
            { status: 403 },
          );
        }
        expect(body.interaction_id).toBe("opaque-request-id-1234567890");
        return ok({
          requested_path: body.path,
          final_path: body.path,
          decision: "overwrite",
          verified_exists: true,
          saved: true,
          action_applied: true,
          request_id: body.interaction_id,
          project: {},
        });
      }),
      http.post(`${BASE}/api/interactions`, () =>
        ok(interaction("resolved", "Overwrite", "save_overwrite")),
      ),
    );
    const path = "/show/existing.toe";
    const result = await new TouchDesignerClient({ baseUrl: BASE }).saveProject({ path });
    expect(result.saved).toBe(true);
    expect(saveCalls).toBe(2);
  });

  it("returns a bounded native artifact-overwrite decision without mutating", async () => {
    server.use(
      http.post(`${BASE}/api/interactions`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        expect(body.kind).toBe("artifact_overwrite");
        expect(body.target).toEqual({
          source_path: "/project1/widget",
          target_path: "/tmp/widget.tox",
        });
        return ok(interaction("resolved", "Overwrite", "artifact_overwrite"));
      }),
    );
    await expect(
      new TouchDesignerClient({ baseUrl: BASE }).requestArtifactOverwriteDecision(
        "/project1/widget",
        "/tmp/widget.tox",
        5_000,
      ),
    ).resolves.toMatchObject({
      request_id: "opaque-request-id-1234567890",
      choice: "Overwrite",
      state: "resolved",
    });
  });

  it.each([
    "expired",
    "cancelled",
    "failed",
  ] as const)("treats %s artifact-overwrite decisions as Keep", async (state) => {
    server.use(
      http.post(`${BASE}/api/interactions`, () =>
        ok(interaction(state, "Keep", "artifact_overwrite")),
      ),
    );
    await expect(
      new TouchDesignerClient({ baseUrl: BASE }).requestArtifactOverwriteDecision(
        "/project1/widget",
        "/tmp/widget.tox",
        5_000,
      ),
    ).resolves.toMatchObject({ choice: "Keep", state });
  });

  it("sends bearer auth on the broker and mutation requests", async () => {
    const seen: string[] = [];
    server.use(
      http.get(`${BASE}/api/nodes/:path`, ({ request }) => {
        seen.push(request.headers.get("authorization") ?? "");
        return ok(nodeDetail);
      }),
      http.post(`${BASE}/api/interactions`, ({ request }) => {
        seen.push(request.headers.get("authorization") ?? "");
        return ok(interaction("resolved", "Delete"));
      }),
      http.delete(`${BASE}/api/nodes/:path`, ({ request }) => {
        seen.push(request.headers.get("authorization") ?? "");
        return ok({
          deleted: nodeDetail.path,
          mode: "delete",
          decision: "Delete",
          original_path: nodeDetail.path,
          final_path: null,
          action_applied: "delete",
          applied: true,
          confirmation_policy: "native",
        });
      }),
    );
    await new TouchDesignerClient({ baseUrl: BASE, token: "secret" }).deleteNode(nodeDetail.path);
    expect(seen).toEqual(["Bearer secret", "Bearer secret", "Bearer secret"]);
  });
});

describe("create node placement contract", () => {
  it("preserves legacy omission and validates explicit coordinates", () => {
    expect(
      CreateNodeInputSchema.parse({ parent_path: "/project1", type: "noiseTOP" }),
    ).not.toHaveProperty("placement");
    expect(() =>
      CreateNodeInputSchema.parse({
        parent_path: "/project1",
        type: "noiseTOP",
        placement: "explicit",
        node_x: 10,
      }),
    ).toThrow(/requires both/);
  });

  it("makes batch delete policy explicit while preserving fail-closed legacy input", () => {
    expect(BatchOperationSchema.parse({ action: "delete", path: "/project1/geo1" })).toEqual({
      action: "delete",
      path: "/project1/geo1",
    });
    expect(
      BatchOperationSchema.parse({
        action: "delete",
        path: "/project1/geo1",
        mode: "bypass",
      }),
    ).toMatchObject({ mode: "bypass" });
  });

  it("sends exact placement and viewer state without exec fallback", async () => {
    server.use(
      http.post(`${BASE}/api/nodes`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        expect(body).toMatchObject({
          placement: "explicit",
          node_x: 320,
          node_y: -160,
          viewer: true,
        });
        return ok({
          path: "/project1/noise1",
          type: "noiseTOP",
          name: "noise1",
          nodeX: 320,
          nodeY: -160,
          viewer: true,
        });
      }),
    );
    const result = await new TouchDesignerClient({ baseUrl: BASE }).createNode({
      parent_path: "/project1",
      type: "noiseTOP",
      placement: "explicit",
      node_x: 320,
      node_y: -160,
      viewer: true,
    });
    expect(result).toMatchObject({ nodeX: 320, nodeY: -160, viewer: true });
  });

  it("rejects a stale bridge that silently ignores explicit placement", async () => {
    server.use(
      http.post(`${BASE}/api/nodes`, () =>
        ok({ path: "/project1/noise1", type: "noiseTOP", name: "noise1" }),
      ),
    );
    await expect(
      new TouchDesignerClient({ baseUrl: BASE }).createNode({
        parent_path: "/project1",
        type: "noiseTOP",
        placement: "explicit",
        node_x: 320,
        node_y: -160,
        viewer: true,
      }),
    ).rejects.toMatchObject({ apiCode: "create_state_unconfirmed" });
  });

  it("preserves an idempotently reused node without moving it", async () => {
    server.use(
      http.post(`${BASE}/api/nodes`, () =>
        ok({
          path: "/project1/noise1",
          type: "noiseTOP",
          name: "noise1",
          already_existed: true,
        }),
      ),
    );
    await expect(
      new TouchDesignerClient({ baseUrl: BASE }).createNode({
        parent_path: "/project1",
        type: "noiseTOP",
        name: "noise1",
        placement: "explicit",
        node_x: 320,
        node_y: -160,
      }),
    ).resolves.toMatchObject({ already_existed: true });
  });
});
