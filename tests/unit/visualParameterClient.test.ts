import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";

const BASE = "http://127.0.0.1:9980";
const server = setupServer();
const ok = (data: unknown) => HttpResponse.json({ ok: true, data });
const fingerprintA = "a".repeat(64);
const fingerprintB = "b".repeat(64);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("TouchDesignerClient visual parameter routes", () => {
  it("uses authenticated structured inspect, Apply, commit and restore requests", async () => {
    const bodies: Record<string, unknown> = {};
    const auth: string[] = [];
    server.use(
      http.post(`${BASE}/api/editor/visual-parameters/inspect`, async ({ request }) => {
        auth.push(request.headers.get("authorization") ?? "");
        bodies.inspect = await request.json();
        return ok({
          scope_path: "/project1",
          output_top_path: "/project1/out1",
          fingerprint: fingerprintA,
          targets: [
            {
              id: "t1",
              path: "/project1/level1",
              parameter: "opacity",
              type: "Float",
              mode: "CONSTANT",
              value: 0.5,
              minimum: 0,
              maximum: 1,
            },
          ],
        });
      }),
      http.post(`${BASE}/api/interactions`, async ({ request }) => {
        auth.push(request.headers.get("authorization") ?? "");
        bodies.interaction = await request.json();
        return ok({
          request_id: "visual-interaction-1234567890",
          kind: "visual_parameter_apply",
          state: "resolved",
          choices: ["Apply", "Keep"],
          created_at: 1,
          expires_at: 31,
          consumed: false,
          result: { choice: "Apply", reason: "user_choice", at: 2 },
        });
      }),
      http.post(`${BASE}/api/editor/visual-parameters/commit`, async ({ request }) => {
        auth.push(request.headers.get("authorization") ?? "");
        bodies.commit = await request.json();
        return ok({
          status: "committed",
          applied: true,
          verified: true,
          final_fingerprint: fingerprintB,
          restore_token: "r".repeat(43),
          readback: [{ target_id: "t1", value: 0.75 }],
          replayed: false,
          undo_label: "MCP enhance_build visual parameters /project1",
        });
      }),
      http.post(`${BASE}/api/editor/visual-parameters/restore`, async ({ request }) => {
        auth.push(request.headers.get("authorization") ?? "");
        bodies.restore = await request.json();
        return ok({
          restored: true,
          verified: true,
          restored_fingerprint: fingerprintA,
          reason: null,
          replayed: false,
        });
      }),
    );
    const client = new TouchDesignerClient({ baseUrl: BASE, token: "bridge-secret" });
    const inspected = await client.inspectVisualParameters({
      scope_path: "/project1",
      output_top_path: "/project1/out1",
      targets: [{ node_path: "/project1/level1", parameter: "opacity", minimum: 0, maximum: 1 }],
    });
    expect(inspected.fingerprint).toBe(fingerprintA);

    const decision = await client.requestVisualParameterDecision({
      expected_fingerprint: fingerprintA,
      proposal_digest: "c".repeat(64),
      changes: [{ target_id: "t1", value: 0.75 }],
      timeout_ms: 5_000,
      dedupe_key: "visual-dedupe-key-1234",
    });
    expect(decision).toMatchObject({ state: "resolved", choice: "Apply" });

    const committed = await client.commitVisualParameters({
      scope_path: "/project1",
      output_top_path: "/project1/out1",
      expected_fingerprint: fingerprintA,
      proposal_digest: "c".repeat(64),
      idempotency_key: "d".repeat(64),
      interaction_id: decision.request_id,
      changes: [{ target_id: "t1", value: 0.75 }],
    });
    expect(committed.status).toBe("committed");
    const restored = await client.restoreVisualParameters({
      restore_token: "r".repeat(43),
      expected_committed_fingerprint: fingerprintB,
      idempotency_key: "e".repeat(64),
    });
    expect(restored).toMatchObject({ restored: true, verified: true });

    expect(auth).toEqual(Array(4).fill("Bearer bridge-secret"));
    expect(bodies.interaction).toEqual({
      kind: "visual_parameter_apply",
      target: {
        expected_fingerprint: fingerprintA,
        proposal_digest: "c".repeat(64),
        changes: [{ target_id: "t1", value: 0.75 }],
      },
      ttl_seconds: 5,
      dedupe_key: "visual-dedupe-key-1234",
    });
    expect(bodies.commit).toMatchObject({
      interaction_id: "visual-interaction-1234567890",
      idempotency_key: "d".repeat(64),
    });
    expect(bodies.restore).toEqual({
      restore_token: "r".repeat(43),
      expected_committed_fingerprint: fingerprintB,
      idempotency_key: "e".repeat(64),
    });
  });

  it("maps a failed or closed native interaction to Keep", async () => {
    server.use(
      http.post(`${BASE}/api/interactions`, () =>
        ok({
          request_id: "visual-interaction-1234567890",
          kind: "visual_parameter_apply",
          state: "failed",
          choices: ["Apply", "Keep"],
          created_at: 1,
          expires_at: 31,
          consumed: false,
          result: { choice: "Keep", reason: "ui_unavailable", at: 2 },
        }),
      ),
    );
    const result = await new TouchDesignerClient({ baseUrl: BASE }).requestVisualParameterDecision({
      expected_fingerprint: fingerprintA,
      proposal_digest: "c".repeat(64),
      changes: [{ target_id: "t1", value: 0.75 }],
      timeout_ms: 5_000,
      dedupe_key: "visual-dedupe-key-1234",
    });
    expect(result).toMatchObject({ state: "failed", choice: "Keep" });
  });

  it("rejects an unbounded or malformed structured response", async () => {
    server.use(
      http.post(`${BASE}/api/editor/visual-parameters/inspect`, () =>
        ok({
          scope_path: "/project1",
          output_top_path: "/project1/out1",
          fingerprint: "not-a-fingerprint",
          targets: [],
        }),
      ),
    );
    await expect(
      new TouchDesignerClient({ baseUrl: BASE }).inspectVisualParameters({
        scope_path: "/project1",
        output_top_path: "/project1/out1",
        targets: [{ node_path: "/project1/level1", parameter: "opacity", minimum: 0, maximum: 1 }],
      }),
    ).rejects.toThrow();
  });
});
