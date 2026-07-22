import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";

const BASE = "http://127.0.0.1:9980";
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("custom parameter lifecycle client", () => {
  it("uses the authenticated structured route and preserves rollback receipts", async () => {
    server.use(
      http.post(`${BASE}/api/nodes/:path/custom_params`, async ({ request, params }) => {
        expect(params.path).toBe("/project1/widget");
        expect(request.headers.get("authorization")).toBe("Bearer secret");
        expect(await request.json()).toEqual({
          operations: [{ action: "delete_parameter", name: "Gain" }],
        });
        return HttpResponse.json({
          ok: true,
          data: {
            status: "rolled_back",
            comp_path: "/project1/widget",
            results: [],
            rollback: { attempted: true, succeeded: true },
            warnings: [],
            request_fingerprint: "a".repeat(64),
            error: { code: "mutation_failed", message: "induced failure" },
          },
        });
      }),
    );

    await expect(
      new TouchDesignerClient({ baseUrl: BASE, token: "secret" }).applyCustomParameterLifecycle(
        "/project1/widget",
        { operations: [{ action: "delete_parameter", name: "Gain" }] },
      ),
    ).resolves.toMatchObject({
      status: "rolled_back",
      rollback: { attempted: true, succeeded: true },
    });
  });

  it("accepts a replay receipt without inventing a new undo item", async () => {
    server.use(
      http.post(`${BASE}/api/nodes/:path/custom_params`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            status: "replayed",
            comp_path: "/project1/widget",
            results: [],
            rollback: { attempted: false, succeeded: true },
            warnings: [],
            request_fingerprint: "b".repeat(64),
            replayed: true,
          },
        }),
      ),
    );

    await expect(
      new TouchDesignerClient({ baseUrl: BASE, token: "secret" }).applyCustomParameterLifecycle(
        "/project1/widget",
        { operations: [{ action: "delete_parameter", name: "Gain" }] },
      ),
    ).resolves.toMatchObject({ status: "replayed", replayed: true });
  });
});
