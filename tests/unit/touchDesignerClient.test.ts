import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { TdApiError, TdConnectionError } from "../../src/td-client/types.js";
import { makeTdServer, offlineInfoHandler, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function client() {
  return new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 });
}

describe("TouchDesignerClient", () => {
  it("getInfo returns parsed data", async () => {
    const info = await client().getInfo();
    expect(info.td_version).toBe("2023.12000");
  });

  it("createNode posts and returns the node ref", async () => {
    const node = await client().createNode({ parent_path: "/project1", type: "noiseTOP" });
    expect(node.path).toBe("/project1/noisetop1");
    expect(node.type).toBe("noiseTOP");
  });

  it("throws TdApiError when the bridge reports ok:false", async () => {
    server.use(
      http.get(`${TD_BASE}/api/info`, () =>
        HttpResponse.json({ ok: false, error: { message: "boom" } }),
      ),
    );
    await expect(client().getInfo()).rejects.toBeInstanceOf(TdApiError);
  });

  it("throws TdApiError on HTTP 404", async () => {
    server.use(
      http.get(`${TD_BASE}/api/info`, () =>
        HttpResponse.json({ error: { message: "nope" } }, { status: 404 }),
      ),
    );
    await expect(client().getInfo()).rejects.toMatchObject({ name: "TdApiError" });
  });

  it("throws TdConnectionError when TD is offline", async () => {
    server.use(offlineInfoHandler);
    await expect(client().getInfo()).rejects.toBeInstanceOf(TdConnectionError);
  });

  it("sends an Authorization bearer header when a token is configured", async () => {
    let auth: string | null = "MISSING";
    server.use(
      http.get(`${TD_BASE}/api/info`, ({ request }) => {
        auth = request.headers.get("authorization");
        return HttpResponse.json({ ok: true, data: { td_version: "x" } });
      }),
    );
    const tokened = new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000, token: "s3cret" });
    await tokened.getInfo();
    expect(auth).toBe("Bearer s3cret");
  });

  it("omits the Authorization header when no token is configured", async () => {
    let auth: string | null = "MISSING";
    server.use(
      http.get(`${TD_BASE}/api/info`, ({ request }) => {
        auth = request.headers.get("authorization");
        return HttpResponse.json({ ok: true, data: { td_version: "x" } });
      }),
    );
    await client().getInfo();
    expect(auth).toBeNull();
  });

  it("encodes the node path into a single URL segment", async () => {
    let pathname = "";
    server.use(
      http.get(`${TD_BASE}/api/nodes/:seg`, ({ request }) => {
        pathname = new URL(request.url).pathname;
        return HttpResponse.json({
          ok: true,
          data: { path: "/project1/a/b", type: "x", name: "b", parameters: {} },
        });
      }),
    );
    await client().getNode("/project1/a/b");
    expect(pathname).toBe(`/api/nodes/${encodeURIComponent("/project1/a/b")}`);
  });
});
