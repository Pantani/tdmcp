import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { TdApiError, TdBackpressureError, TdConnectionError } from "../../src/td-client/types.js";
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

  it("getHealth returns the parsed liveness report", async () => {
    server.use(
      http.get(`${TD_BASE}/api/health`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            state: "ok",
            uptime_seconds: 12.5,
            heartbeat: { stale: false, age_seconds: 1.2 },
            touchdesigner: { td_version: "099", bridge_version: "0.12.0" },
          },
        }),
      ),
    );
    const health = await client().getHealth();
    expect(health.state).toBe("ok");
    expect(health.uptime_seconds).toBe(12.5);
    expect(health.touchdesigner?.bridge_version).toBe("0.12.0");
  });

  it("getHealth rejects with a typed TdError on an invalid envelope", async () => {
    server.use(
      http.get(`${TD_BASE}/api/health`, () => HttpResponse.json({ ok: true, data: { state: 42 } })),
    );
    await expect(client().getHealth()).rejects.toMatchObject({ name: "TdApiError" });
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

  it("surfaces a 503 as a retryable TdBackpressureError carrying retryAfterMs", async () => {
    server.use(
      http.get(`${TD_BASE}/api/info`, () =>
        HttpResponse.json(
          { ok: false, error: { code: "backpressure", message: "busy", retry_after: 3 } },
          { status: 503 },
        ),
      ),
    );
    const err = await client()
      .getInfo()
      .catch((e) => e);
    expect(err).toBeInstanceOf(TdBackpressureError);
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(3000);
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

describe("TouchDesignerClient retry (idempotent GET)", () => {
  const retryClient = () =>
    new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000, retries: 2, retryDelayMs: 0 });

  it("retries a transient connection failure on a GET and then succeeds", async () => {
    let calls = 0;
    server.use(
      http.get(`${TD_BASE}/api/info`, () => {
        calls++;
        if (calls < 2) return HttpResponse.error(); // network failure on the first try
        return HttpResponse.json({ ok: true, data: { td_version: "2023.12000" } });
      }),
    );
    const info = await retryClient().getInfo();
    expect(info.td_version).toBe("2023.12000");
    expect(calls).toBe(2);
  });

  it("gives up with TdConnectionError after exhausting retries (1 + 2)", async () => {
    let calls = 0;
    server.use(
      http.get(`${TD_BASE}/api/info`, () => {
        calls++;
        return HttpResponse.error();
      }),
    );
    await expect(retryClient().getInfo()).rejects.toBeInstanceOf(TdConnectionError);
    expect(calls).toBe(3);
  });

  it("does NOT retry a non-idempotent POST (avoids double-create)", async () => {
    let calls = 0;
    server.use(
      http.post(`${TD_BASE}/api/nodes`, () => {
        calls++;
        return HttpResponse.error();
      }),
    );
    await expect(
      retryClient().createNode({ parent_path: "/project1", type: "noiseTOP" }),
    ).rejects.toBeInstanceOf(TdConnectionError);
    expect(calls).toBe(1);
  });

  it("does not retry when retries is 0", async () => {
    let calls = 0;
    server.use(
      http.get(`${TD_BASE}/api/info`, () => {
        calls++;
        return HttpResponse.error();
      }),
    );
    const noRetry = new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000, retries: 0 });
    await expect(noRetry.getInfo()).rejects.toBeInstanceOf(TdConnectionError);
    expect(calls).toBe(1);
  });
});
