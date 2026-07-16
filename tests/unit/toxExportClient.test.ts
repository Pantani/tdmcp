import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";

const BASE = "http://127.0.0.1:9980";
const ok = (data: unknown) => HttpResponse.json({ ok: true, data });
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function queued(operationId = "opaque_export_operation") {
  return {
    operation_id: operationId,
    status: "queued",
    verdict: null,
    source_path: "/project1/widget",
    target_path: "/tmp/widget.tox",
    mode: "as_is",
    decision: "not_required",
    interaction_id: null,
    action_applied: false,
    phases: [],
  };
}

function succeeded() {
  return {
    ...queued(),
    status: "succeeded",
    verdict: "PASS",
    action_applied: true,
    artifact: {
      path: "/tmp/widget.tox",
      size_bytes: 64,
      sha256: "a".repeat(64),
    },
  };
}

function broker(choice: "Overwrite" | "Keep") {
  return {
    request_id: "opaque_interaction_request",
    kind: "artifact_overwrite",
    state: "resolved",
    choices: ["Overwrite", "Keep"],
    created_at: 1,
    expires_at: 31,
    consumed: false,
    result: { choice, reason: "user_choice", at: 2 },
  };
}

describe("transactional TOX export client", () => {
  it("starts, polls, and returns only a verified terminal receipt", async () => {
    server.use(
      http.post(`${BASE}/api/artifacts/tox/exports`, () => ok(queued())),
      http.get(`${BASE}/api/artifacts/tox/exports/:id`, () => ok(succeeded())),
    );

    await expect(
      new TouchDesignerClient({ baseUrl: BASE }).exportToxTransaction({
        source_path: "/project1/widget",
        target_path: "/tmp/widget.tox",
      }),
    ).resolves.toMatchObject({ status: "succeeded", action_applied: true });
  });

  it("refuses overwrite without opening the broker by default", async () => {
    let prompts = 0;
    server.use(
      http.post(`${BASE}/api/artifacts/tox/exports`, () =>
        HttpResponse.json(
          {
            ok: false,
            error: { code: "artifact_overwrite_required", message: "approval required" },
          },
          { status: 403 },
        ),
      ),
      http.post(`${BASE}/api/interactions`, () => {
        prompts += 1;
        return ok(broker("Overwrite"));
      }),
    );

    await expect(
      new TouchDesignerClient({ baseUrl: BASE }).exportToxTransaction({
        source_path: "/project1/widget",
        target_path: "/tmp/widget.tox",
      }),
    ).rejects.toMatchObject({ apiCode: "artifact_overwrite_required" });
    expect(prompts).toBe(0);
  });

  it("binds ask-policy approval to the structured retry", async () => {
    let starts = 0;
    server.use(
      http.post(`${BASE}/api/artifacts/tox/exports`, async ({ request }) => {
        starts += 1;
        const body = (await request.json()) as Record<string, unknown>;
        if (starts === 1) {
          return HttpResponse.json(
            {
              ok: false,
              error: { code: "artifact_overwrite_required", message: "approval required" },
            },
            { status: 403 },
          );
        }
        expect(body.interaction_id).toBe("opaque_interaction_request");
        return ok(succeeded());
      }),
      http.post(`${BASE}/api/interactions`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        expect(body).toMatchObject({
          kind: "artifact_overwrite",
          target: {
            source_path: "/project1/widget",
            target_path: "/tmp/widget.tox",
          },
        });
        return ok(broker("Overwrite"));
      }),
    );

    await expect(
      new TouchDesignerClient({ baseUrl: BASE }).exportToxTransaction({
        source_path: "/project1/widget",
        target_path: "/tmp/widget.tox",
        overwrite_policy: "ask",
      }),
    ).resolves.toMatchObject({ status: "succeeded", decision: "not_required" });
    expect(starts).toBe(2);
  });

  it("maps Keep to a confirmed no-op without retrying the export", async () => {
    let starts = 0;
    server.use(
      http.post(`${BASE}/api/artifacts/tox/exports`, () => {
        starts += 1;
        return HttpResponse.json(
          {
            ok: false,
            error: { code: "artifact_overwrite_required", message: "approval required" },
          },
          { status: 403 },
        );
      }),
      http.post(`${BASE}/api/interactions`, () => ok(broker("Keep"))),
    );

    await expect(
      new TouchDesignerClient({ baseUrl: BASE }).exportToxTransaction({
        source_path: "/project1/widget",
        target_path: "/tmp/widget.tox",
        overwrite_policy: "ask",
      }),
    ).resolves.toMatchObject({
      status: "cancelled",
      decision: "Keep",
      action_applied: false,
    });
    expect(starts).toBe(1);
  });

  it("recovers a response-lost start by idempotency key without replaying POST", async () => {
    let starts = 0;
    server.use(
      http.post(`${BASE}/api/artifacts/tox/exports`, () => {
        starts += 1;
        return HttpResponse.error();
      }),
      http.get(`${BASE}/api/artifacts/tox/exports/by-key/:key`, ({ params }) => {
        expect(params.key).toBe("stable_retry_key_1234");
        return ok(succeeded());
      }),
    );

    await expect(
      new TouchDesignerClient({ baseUrl: BASE, retries: 0 }).exportToxTransaction({
        source_path: "/project1/widget",
        target_path: "/tmp/widget.tox",
        idempotency_key: "stable_retry_key_1234",
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(starts).toBe(1);
  });
});
