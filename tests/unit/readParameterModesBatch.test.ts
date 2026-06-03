import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { TdApiError, TdTimeoutError } from "../../src/td-client/types.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeClient(timeoutMs = 2000): TouchDesignerClient {
  return new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs });
}

describe("readParameterModesBatch — bridge endpoint", () => {
  it("200 → returns validated {items: [...]}", async () => {
    server.use(
      http.post(`${TD_BASE}/api/param_modes/batch`, async ({ request }) => {
        const body = (await request.json()) as {
          items: Array<{ path: string; non_default_only: boolean }>;
          continue_on_error: boolean;
        };
        expect(body.continue_on_error).toBe(true);
        expect(body.items).toHaveLength(2);
        expect(body.items[0]?.path).toBe("/p/a");
        return HttpResponse.json({
          ok: true,
          data: {
            items: [
              {
                path: "/p/a",
                type: "noiseTOP",
                name: "a",
                parameters: [{ name: "amp", mode: "CONSTANT", value: 0.5 }],
                warnings: [],
              },
              {
                path: "/p/missing",
                type: "",
                name: "",
                parameters: [],
                warnings: [],
                error: "Node not found: /p/missing",
              },
            ],
          },
        });
      }),
    );
    const res = await makeClient().readParameterModesBatch([
      { path: "/p/a" },
      { path: "/p/missing" },
    ]);
    expect(res.items).toHaveLength(2);
    expect(res.items[0]?.parameters[0]?.name).toBe("amp");
    expect(res.items[1]?.error).toContain("Node not found");
  });

  it("400 → TdApiError", async () => {
    server.use(
      http.post(`${TD_BASE}/api/param_modes/batch`, () =>
        HttpResponse.json({ ok: false, error: { message: "bad items" } }, { status: 400 }),
      ),
    );
    await expect(makeClient().readParameterModesBatch([{ path: "/p/a" }])).rejects.toBeInstanceOf(
      TdApiError,
    );
  });

  it("5xx → TdApiError", async () => {
    server.use(
      http.post(`${TD_BASE}/api/param_modes/batch`, () =>
        HttpResponse.json({ ok: false, error: { message: "boom" } }, { status: 500 }),
      ),
    );
    await expect(makeClient().readParameterModesBatch([{ path: "/p/a" }])).rejects.toBeInstanceOf(
      TdApiError,
    );
  });

  it("timeout → TdTimeoutError", async () => {
    server.use(
      http.post(`${TD_BASE}/api/param_modes/batch`, async () => {
        await new Promise((r) => setTimeout(r, 200));
        return HttpResponse.json({ ok: true, data: { items: [] } });
      }),
    );
    await expect(makeClient(20).readParameterModesBatch([{ path: "/p/a" }])).rejects.toBeInstanceOf(
      TdTimeoutError,
    );
  });

  it("bad shape → TdApiError (validator)", async () => {
    server.use(
      http.post(`${TD_BASE}/api/param_modes/batch`, () =>
        HttpResponse.json({ ok: true, data: { items: [{ /* missing path */ type: "x" }] } }),
      ),
    );
    await expect(makeClient().readParameterModesBatch([{ path: "/p/a" }])).rejects.toBeInstanceOf(
      TdApiError,
    );
  });
});

describe("readParameterModesBatchWithFallback — older bridge", () => {
  it("404 on batch → loops singular readParameterModes per item", async () => {
    let batchCalls = 0;
    const singularCalls: string[] = [];
    server.use(
      http.post(`${TD_BASE}/api/param_modes/batch`, () => {
        batchCalls += 1;
        return HttpResponse.json(
          { ok: false, error: { message: "Unsupported POST /api/param_modes/batch" } },
          { status: 404 },
        );
      }),
      http.get(`${TD_BASE}/api/nodes/:seg/params`, ({ params, request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("modes")).toBe("true");
        const path = decodeURIComponent(params.seg as string);
        singularCalls.push(path);
        return HttpResponse.json({
          ok: true,
          data: {
            path,
            type: "noiseTOP",
            name: path.split("/").pop() ?? "",
            parameters: [{ name: "amp", mode: "CONSTANT", value: 1 }],
            warnings: [],
          },
        });
      }),
    );
    const res = await makeClient().readParameterModesBatchWithFallback([
      { path: "/p/a" },
      { path: "/p/b" },
    ]);
    expect(batchCalls).toBe(1);
    expect(singularCalls).toEqual(["/p/a", "/p/b"]);
    expect(res.items).toHaveLength(2);
    expect(res.items[0]?.path).toBe("/p/a");
    expect(res.items[1]?.parameters[0]?.name).toBe("amp");
  });

  it("404 on batch + per-item failure → captured as item.error when continueOnError", async () => {
    server.use(
      http.post(`${TD_BASE}/api/param_modes/batch`, () =>
        HttpResponse.json(
          { ok: false, error: { message: "Unsupported POST /api/param_modes/batch" } },
          { status: 404 },
        ),
      ),
      http.get(`${TD_BASE}/api/nodes/:seg/params`, ({ params }) => {
        const path = decodeURIComponent(params.seg as string);
        if (path === "/p/bad") {
          return HttpResponse.json(
            { ok: false, error: { message: "Node not found: /p/bad" } },
            { status: 400 },
          );
        }
        return HttpResponse.json({
          ok: true,
          data: { path, type: "x", name: "x", parameters: [], warnings: [] },
        });
      }),
    );
    const res = await makeClient().readParameterModesBatchWithFallback(
      [{ path: "/p/ok" }, { path: "/p/bad" }],
      true,
    );
    expect(res.items).toHaveLength(2);
    expect(res.items[0]?.error).toBeUndefined();
    expect(res.items[1]?.error).toContain("Node not found");
  });
});
