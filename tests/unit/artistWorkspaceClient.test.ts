import { delay, HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { TdApiError, TdConnectionError, TdTimeoutError } from "../../src/td-client/types.js";
import { ArtistWorkspaceReceiptSchema } from "../../src/td-client/validators.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const workspaceId = "workspace_opaque_123456789";
const baselineFingerprint = "a".repeat(64);
const workspaceFingerprint = "b".repeat(64);

function receipt(status: "scheduled" | "active", deduplicated = false) {
  const active = status === "active";
  return {
    workspace_id: workspaceId,
    action: "open",
    status,
    deduplicated,
    created_at: 10,
    expires_at: 310,
    targets: {
      network_path: "/project1/show",
      viewer_path: "/project1/show/out1",
      viewer_mode: "top_output",
      split_ratio: 0.62,
    },
    source_pane: active ? { id: 1, name: "network", type: "NETWORKEDITOR" } : null,
    owned_pane: active ? { id: 2, name: "tdmcp_workspace", type: "TOPVIEWER" } : null,
    baseline: active ? { pane_count: 1, fingerprint: baselineFingerprint } : null,
    workspace: active ? { pane_count: 2, fingerprint: workspaceFingerprint } : null,
    cleanup: {
      attempted: false,
      owned_pane_closed: false,
      source_restored: false,
      baseline_verified: false,
    },
    reason: null,
    warnings: [],
    undo_label: null,
  };
}

function lifecycleReceipt(
  action: "status" | "restore" | "cancel",
  status: "restore_scheduled" | "cancel_scheduled" | "restored" | "cancelled",
) {
  const terminal = status === "restored" || status === "cancelled";
  return {
    ...receipt("active"),
    action,
    status,
    expires_at: terminal ? null : 310,
    cleanup: terminal
      ? {
          attempted: true,
          owned_pane_closed: true,
          source_restored: true,
          baseline_verified: true,
        }
      : receipt("active").cleanup,
    reason: status === "cancelled" ? "client_cancelled" : null,
  };
}

describe("TouchDesignerClient artist workspaces", () => {
  it("recovers one lost open response with the identical idempotency key", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let openCalls = 0;
    server.use(
      http.post(`${TD_BASE}/api/editor/workspaces`, async ({ request }) => {
        openCalls += 1;
        bodies.push((await request.json()) as Record<string, unknown>);
        if (openCalls === 1) return HttpResponse.error();
        return HttpResponse.json({ ok: true, data: receipt("scheduled", true) });
      }),
      http.get(`${TD_BASE}/api/editor/workspaces/:workspaceId`, () =>
        HttpResponse.json({ ok: true, data: receipt("active", true) }),
      ),
    );

    const client = new TouchDesignerClient({ baseUrl: TD_BASE, retries: 0 });
    const result = await client.manageArtistWorkspace({
      action: "open",
      network_path: "/project1/show",
      viewer_path: "/project1/show/out1",
      viewer_mode: "top_output",
    });

    expect(result.status).toBe("active");
    expect(openCalls).toBe(2);
    expect(bodies[0]?.idempotency_key).toBe(bodies[1]?.idempotency_key);
    expect(String(bodies[0]?.idempotency_key)).toMatch(/^open_[a-f0-9]{32}$/);
  });

  it("does not retry an open rejected by a domain error", async () => {
    let openCalls = 0;
    server.use(
      http.post(`${TD_BASE}/api/editor/workspaces`, () => {
        openCalls += 1;
        return HttpResponse.json(
          { ok: false, error: { code: "workspace_capacity", message: "capacity" } },
          { status: 400 },
        );
      }),
    );

    const client = new TouchDesignerClient({ baseUrl: TD_BASE, retries: 0 });
    await expect(
      client.manageArtistWorkspace({
        action: "open",
        network_path: "/project1/show",
        viewer_path: "/project1/show/out1",
        viewer_mode: "top_output",
      }),
    ).rejects.toBeInstanceOf(TdApiError);
    expect(openCalls).toBe(1);
  });

  it("polls through multiple scheduled receipts before claiming active", async () => {
    let polls = 0;
    server.use(
      http.post(`${TD_BASE}/api/editor/workspaces`, () =>
        HttpResponse.json({ ok: true, data: receipt("scheduled") }),
      ),
      http.get(`${TD_BASE}/api/editor/workspaces/:workspaceId`, () => {
        polls += 1;
        return HttpResponse.json({
          ok: true,
          data: polls < 3 ? receipt("scheduled") : receipt("active"),
        });
      }),
    );

    const result = await new TouchDesignerClient({ baseUrl: TD_BASE }).manageArtistWorkspace({
      action: "open",
      network_path: "/project1/show",
      viewer_path: "/project1/show/out1",
      viewer_mode: "top_output",
    });

    expect(result.status).toBe("active");
    expect(polls).toBe(3);
  });

  it("status is one pure GET with retries disabled", async () => {
    let calls = 0;
    server.use(
      http.get(`${TD_BASE}/api/editor/workspaces/:workspaceId`, () => {
        calls += 1;
        return HttpResponse.error();
      }),
    );

    const client = new TouchDesignerClient({ baseUrl: TD_BASE, retries: 2, retryDelayMs: 0 });
    await expect(
      client.manageArtistWorkspace({ action: "status", workspace_id: workspaceId }),
    ).rejects.toBeInstanceOf(TdConnectionError);
    expect(calls).toBe(1);
  });

  it("best-effort cancels a known workspace after polling disconnect", async () => {
    const cancelBodies: Array<Record<string, unknown>> = [];
    server.use(
      http.post(`${TD_BASE}/api/editor/workspaces`, () =>
        HttpResponse.json({ ok: true, data: receipt("scheduled") }),
      ),
      http.get(`${TD_BASE}/api/editor/workspaces/:workspaceId`, () => HttpResponse.error()),
      http.post(`${TD_BASE}/api/editor/workspaces/:workspaceId/cancel`, async ({ request }) => {
        cancelBodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({
          ok: true,
          data: lifecycleReceipt("cancel", "cancelled"),
        });
      }),
    );

    await expect(
      new TouchDesignerClient({ baseUrl: TD_BASE, retries: 0 }).manageArtistWorkspace({
        action: "open",
        network_path: "/project1/show",
        viewer_path: "/project1/show/out1",
        viewer_mode: "top_output",
      }),
    ).rejects.toBeInstanceOf(TdConnectionError);
    expect(cancelBodies).toHaveLength(1);
    expect(String(cancelBodies[0]?.idempotency_key)).toMatch(/^cancel_[a-f0-9]{32}$/);
  });

  it("best-effort cancels a known workspace after bounded polling timeout", async () => {
    let cancelCalls = 0;
    server.use(
      http.post(`${TD_BASE}/api/editor/workspaces`, () =>
        HttpResponse.json({ ok: true, data: receipt("scheduled") }),
      ),
      http.get(`${TD_BASE}/api/editor/workspaces/:workspaceId`, async () => {
        await delay(2_000);
        return HttpResponse.json({ ok: true, data: receipt("scheduled") });
      }),
      http.post(`${TD_BASE}/api/editor/workspaces/:workspaceId/cancel`, () => {
        cancelCalls += 1;
        return HttpResponse.json({
          ok: true,
          data: lifecycleReceipt("cancel", "cancelled"),
        });
      }),
    );

    await expect(
      new TouchDesignerClient({ baseUrl: TD_BASE, retries: 0 }).manageArtistWorkspace({
        action: "open",
        network_path: "/project1/show",
        viewer_path: "/project1/show/out1",
        viewer_mode: "top_output",
      }),
    ).rejects.toBeInstanceOf(TdTimeoutError);
    expect(cancelCalls).toBe(1);
  });

  it.each([
    ["restore", "restore_scheduled", "restored"],
    ["cancel", "cancel_scheduled", "cancelled"],
  ] as const)("uses one transport key for %s and returns the verified terminal receipt", async (action, scheduled, terminal) => {
    const bodies: Array<Record<string, unknown>> = [];
    server.use(
      http.post(`${TD_BASE}/api/editor/workspaces/:workspaceId/${action}`, async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({
          ok: true,
          data: lifecycleReceipt(action, scheduled),
        });
      }),
      http.get(`${TD_BASE}/api/editor/workspaces/:workspaceId`, () =>
        HttpResponse.json({ ok: true, data: lifecycleReceipt("status", terminal) }),
      ),
    );

    const result = await new TouchDesignerClient({ baseUrl: TD_BASE }).manageArtistWorkspace({
      action,
      workspace_id: workspaceId,
    });

    expect(result.status).toBe(terminal);
    expect(bodies).toHaveLength(1);
    expect(String(bodies[0]?.idempotency_key)).toMatch(new RegExp(`^${action}_[a-f0-9]{32}$`));
  });

  it.each([
    ["restore", "restore_scheduled", "restored"],
    ["cancel", "cancel_scheduled", "cancelled"],
  ] as const)("recovers one lost %s response with the identical idempotency key", async (action, scheduled, terminal) => {
    const bodies: Array<Record<string, unknown>> = [];
    let actionCalls = 0;
    let statusCalls = 0;
    server.use(
      http.post(`${TD_BASE}/api/editor/workspaces/:workspaceId/${action}`, async ({ request }) => {
        actionCalls += 1;
        bodies.push((await request.json()) as Record<string, unknown>);
        if (actionCalls === 1) return HttpResponse.error();
        return HttpResponse.json({
          ok: true,
          data: { ...lifecycleReceipt(action, scheduled), deduplicated: true },
        });
      }),
      http.get(`${TD_BASE}/api/editor/workspaces/:workspaceId`, () => {
        statusCalls += 1;
        return HttpResponse.json({
          ok: true,
          data: lifecycleReceipt("status", terminal),
        });
      }),
    );

    const result = await new TouchDesignerClient({
      baseUrl: TD_BASE,
      retries: 0,
    }).manageArtistWorkspace({ action, workspace_id: workspaceId });

    expect(result.status).toBe(terminal);
    expect(actionCalls).toBe(2);
    expect(statusCalls).toBe(1);
    expect(bodies[0]?.idempotency_key).toBe(bodies[1]?.idempotency_key);
    expect(String(bodies[0]?.idempotency_key)).toMatch(new RegExp(`^${action}_[a-f0-9]{32}$`));
  });

  it.each([
    ["restore", 400, "workspace_conflict"],
    ["cancel", 401, "unauthorized"],
  ] as const)("does not retry %s after HTTP %i", async (action, status, code) => {
    let actionCalls = 0;
    server.use(
      http.post(`${TD_BASE}/api/editor/workspaces/:workspaceId/${action}`, () => {
        actionCalls += 1;
        return HttpResponse.json({ ok: false, error: { code, message: code } }, { status });
      }),
    );

    await expect(
      new TouchDesignerClient({ baseUrl: TD_BASE, retries: 0 }).manageArtistWorkspace({
        action,
        workspace_id: workspaceId,
      }),
    ).rejects.toMatchObject({ status, apiCode: code });
    expect(actionCalls).toBe(1);
  });

  it("stops after one bounded cancel recovery attempt when both responses are lost", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    server.use(
      http.post(`${TD_BASE}/api/editor/workspaces/:workspaceId/cancel`, async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.error();
      }),
    );

    await expect(
      new TouchDesignerClient({ baseUrl: TD_BASE, retries: 3 }).manageArtistWorkspace({
        action: "cancel",
        workspace_id: workspaceId,
      }),
    ).rejects.toBeInstanceOf(TdConnectionError);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.idempotency_key).toBe(bodies[1]?.idempotency_key);
  });

  it("returns an already-terminal status as a pure no-op receipt", async () => {
    server.use(
      http.get(`${TD_BASE}/api/editor/workspaces/:workspaceId`, () =>
        HttpResponse.json({
          ok: true,
          data: lifecycleReceipt("status", "restored"),
        }),
      ),
    );
    const result = await new TouchDesignerClient({ baseUrl: TD_BASE }).manageArtistWorkspace({
      action: "status",
      workspace_id: workspaceId,
    });
    expect(result.status).toBe("restored");
    expect(result.cleanup.baseline_verified).toBe(true);
  });

  it("rejects ambiguous terminal cleanup receipts", () => {
    const restored = lifecycleReceipt("status", "restored");
    expect(
      ArtistWorkspaceReceiptSchema.safeParse({
        ...restored,
        cleanup: { ...restored.cleanup, baseline_verified: false },
      }).success,
    ).toBe(false);

    const cancelledAfterApply = lifecycleReceipt("status", "cancelled");
    expect(
      ArtistWorkspaceReceiptSchema.safeParse({
        ...cancelledAfterApply,
        cleanup: { ...cancelledAfterApply.cleanup, baseline_verified: false },
      }).success,
    ).toBe(false);

    expect(
      ArtistWorkspaceReceiptSchema.safeParse({
        ...cancelledAfterApply,
        cleanup: receipt("scheduled").cleanup,
      }).success,
    ).toBe(false);
  });
});
