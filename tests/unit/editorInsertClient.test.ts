import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";

const BASE = "http://127.0.0.1:9980";
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("editor insert structured client", () => {
  it("posts the authenticated bounded request and validates the connector receipt", async () => {
    const input = {
      type: "nullTOP",
      name: "inserted",
      expected_context: {
        owner_path: "/project1",
        selected_path: "/project1/source",
        current_path: "/project1/source",
      },
      idempotency_key: "opaque_insert_key_1234",
    };
    server.use(
      http.post(`${BASE}/api/editor/insert`, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer secret");
        expect(await request.json()).toEqual(input);
        return HttpResponse.json({
          ok: true,
          data: {
            status: "applied",
            idempotency_key: input.idempotency_key,
            context: input.expected_context,
            node: {
              path: "/project1/inserted",
              type: "nullTOP",
              name: "inserted",
              nodeX: 200,
              nodeY: 0,
              viewer: false,
            },
            before: {
              edges: [
                {
                  from_path: "/project1/source",
                  out_index: 0,
                  to_path: "/project1/out",
                  in_index: 0,
                },
              ],
            },
            after: {
              edges: [
                {
                  from_path: "/project1/source",
                  out_index: 0,
                  to_path: "/project1/inserted",
                  in_index: 0,
                },
                {
                  from_path: "/project1/inserted",
                  out_index: 0,
                  to_path: "/project1/out",
                  in_index: 0,
                },
              ],
            },
            rollback: { attempted: false, succeeded: true },
            warnings: [],
            undo_label: "MCP insert_operator_at_selection /project1/source",
          },
        });
      }),
    );

    await expect(
      new TouchDesignerClient({ baseUrl: BASE, token: "secret" }).insertOperatorAtSelection(input),
    ).resolves.toMatchObject({
      status: "applied",
      node: { path: "/project1/inserted", viewer: false },
    });
  });

  it("rejects a malformed success receipt instead of claiming insertion", async () => {
    server.use(
      http.post(`${BASE}/api/editor/insert`, () =>
        HttpResponse.json({ ok: true, data: { status: "applied" } }),
      ),
    );
    const client = new TouchDesignerClient({ baseUrl: BASE });
    await expect(
      client.insertOperatorAtSelection({
        type: "nullTOP",
        expected_context: {
          owner_path: "/project1",
          selected_path: "/project1/source",
          current_path: "/project1/source",
        },
        idempotency_key: "opaque_insert_key_1234",
      }),
    ).rejects.toBeDefined();
  });
});
