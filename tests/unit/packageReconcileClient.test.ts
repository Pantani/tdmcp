import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";

const BASE = "http://127.0.0.1:9980";
const ok = (data: unknown) => HttpResponse.json({ ok: true, data });
const server = setupServer();
const PLAN_ID = "plan_000000000000000000000001";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const plan = {
  status: "planned",
  plan_id: PLAN_ID,
  expires_at: 1_000,
  package_id: "package-a",
  scope: "project",
  intent: "prune",
  classification: "aligned_owned",
  actionable: true,
  resolved_target_path: "/project1/tdmcp_packages/package_a",
  marker: { matched: true, schema_version: 1 },
  candidates: [
    {
      path: "/project1/tdmcp_packages/package_a",
      marker_status: "match",
      marker_schema_version: 1,
    },
  ],
  warnings: [],
  deduplicated: false,
};

describe("package namespace structured client", () => {
  it("uses authenticated structured check/apply routes without exec", async () => {
    const seen: string[] = [];
    server.use(
      http.post(`${BASE}/api/packages/reconcile/check`, ({ request }) => {
        seen.push(`${request.method} ${new URL(request.url).pathname}`);
        expect(request.headers.get("authorization")).toBe("Bearer secret");
        return ok(plan);
      }),
      http.post(`${BASE}/api/packages/reconcile/apply`, async ({ request }) => {
        seen.push(`${request.method} ${new URL(request.url).pathname}`);
        expect(await request.json()).toEqual({
          plan_id: PLAN_ID,
          choice: "Bypass",
          confirmation_policy: "explicit_mode",
        });
        return ok({
          status: "applied",
          plan_id: PLAN_ID,
          package_id: "package-a",
          classification: "aligned_owned",
          resolved_target_path: "/project1/tdmcp_packages/package_a",
          decision: "Bypass",
          action_applied: "bypass",
          final_path: "/project1/tdmcp_packages/package_a",
          confirmation_policy: "explicit_mode",
          request_id: null,
          marker: { matched: true, schema_version: 1 },
          warnings: [],
        });
      }),
    );

    const client = new TouchDesignerClient({ baseUrl: BASE, token: "secret" });
    await client.checkPackageNamespace({
      project_path: "/project1",
      package_id: "package-a",
      source_url: "https://github.com/example/package-a",
      recorded_ref: "v1",
      recorded_target_path: "/project1/tdmcp_packages/package_a",
      scope: "project",
      intent: "prune",
    });
    await client.applyPackageNamespace({
      plan_id: PLAN_ID,
      choice: "Bypass",
      confirmation_policy: "explicit_mode",
    });
    expect(seen).toEqual([
      "POST /api/packages/reconcile/check",
      "POST /api/packages/reconcile/apply",
    ]);
  });
});
