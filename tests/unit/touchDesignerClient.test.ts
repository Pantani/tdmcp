import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  TdApiError,
  TdBackpressureError,
  TdConnectionError,
  TdTimeoutError,
} from "../../src/td-client/types.js";
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

  it("uses structured annotation-layout context and apply routes", async () => {
    let applyBody: unknown;
    server.use(
      http.post(`${TD_BASE}/api/editor/annotation-layout/context`, async ({ request }) => {
        expect(await request.json()).toEqual({ root_path: "/project1/show", recursive: true });
        return HttpResponse.json({
          ok: true,
          data: {
            root_path: "/project1/show",
            recursive: true,
            fingerprint: "a".repeat(64),
            networks: [],
          },
        });
      }),
      http.post(`${TD_BASE}/api/editor/annotation-layout/apply`, async ({ request }) => {
        applyBody = await request.json();
        return HttpResponse.json({
          ok: true,
          data: {
            applied: true,
            rolled_back: false,
            root_path: "/project1/show",
            fingerprint: "a".repeat(64),
            moved: 0,
            resized_annotations: 0,
            networks: 0,
            rollback_errors: [],
          },
        });
      }),
    );

    const context = await client().getAnnotationLayoutContext("/project1/show", true);
    expect(context.networks).toEqual([]);
    const result = await client().applyAnnotationLayout({
      root_path: context.root_path,
      recursive: context.recursive,
      fingerprint: context.fingerprint,
      networks: [],
    });
    expect(result.applied).toBe(true);
    expect(applyBody).toEqual({
      root_path: "/project1/show",
      recursive: true,
      fingerprint: "a".repeat(64),
      networks: [],
    });
  });

  it("reads one parameter menu with bounded no-retry options", async () => {
    server.use(
      http.get(`${TD_BASE}/api/nodes/:path/params/:parameter/menu`, ({ params }) => {
        expect(params.path).toBe("/project1/math1");
        expect(params.parameter).toBe("Combine");
        return HttpResponse.json({
          ok: true,
          data: {
            path: "/project1/math1",
            parameter: "Combine",
            style: "Menu",
            names: ["add", "multiply"],
            labels: ["Add", "Multiply"],
            current: "add",
          },
        });
      }),
    );

    await expect(
      client().getParameterMenu("/project1/math1", "Combine", {
        timeoutMs: 500,
        retryGet: false,
      }),
    ).resolves.toMatchObject({ names: ["add", "multiply"], current: "add" });
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
            performance: { available: true, cook_time_ms: 0.4, fps: 60 },
            degraded_signals: [],
            warnings: [],
            touchdesigner: { td_version: "099", bridge_version: "0.12.0" },
          },
        }),
      ),
    );
    const health = await client().getHealth();
    expect(health.state).toBe("ok");
    expect(health.uptime_seconds).toBe(12.5);
    expect(health.touchdesigner?.bridge_version).toBe("0.12.0");
    expect(health.performance?.cook_time_ms).toBe(0.4);
    expect(health.warnings).toEqual([]);
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

  it("keeps the timeout active while reading a response body", async () => {
    const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const signal = init?.signal;
      return {
        text: () =>
          new Promise<string>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(new DOMException("The operation was aborted.", "AbortError")),
              { once: true },
            );
          }),
      } as Response;
    }) as typeof fetch;
    const bodyStallClient = new TouchDesignerClient({
      baseUrl: TD_BASE,
      timeoutMs: 20,
      retries: 0,
      fetchImpl,
    });

    await expect(bodyStallClient.getInfo()).rejects.toBeInstanceOf(TdTimeoutError);
  });

  it("supports one bounded non-retrying editor-context read", async () => {
    let calls = 0;
    server.use(
      http.get(`${TD_BASE}/api/editor/context`, () => {
        calls += 1;
        return HttpResponse.error();
      }),
    );
    const bounded = new TouchDesignerClient({
      baseUrl: TD_BASE,
      timeoutMs: 2000,
      retries: 2,
      retryDelayMs: 0,
    });

    await expect(bounded.getEditorContext({ timeoutMs: 100, retry: false })).rejects.toBeInstanceOf(
      TdConnectionError,
    );
    expect(calls).toBe(1);
  });

  it("distinguishes external editor-context cancellation from its deadline", async () => {
    const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        );
      })) as typeof fetch;
    const cancellable = new TouchDesignerClient({
      baseUrl: TD_BASE,
      timeoutMs: 2000,
      retries: 0,
      fetchImpl,
    });
    const controller = new AbortController();
    const pending = cancellable.getEditorContext({
      timeoutMs: 1000,
      retry: false,
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "cancelled" });
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

  it("keeps parameter-search content filters in the authenticated POST body", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    let capturedAuth: string | null = null;
    server.use(
      http.post(`${TD_BASE}/api/params/search`, async ({ request }) => {
        capturedUrl = request.url;
        capturedBody = (await request.json()) as Record<string, unknown>;
        capturedAuth = request.headers.get("authorization");
        return HttpResponse.json({
          ok: true,
          data: {
            root_path: "/project1",
            max_depth: 3,
            results: [],
            scanned_nodes: 0,
            scanned_parameters: 0,
            matched: 0,
            returned: 0,
            limit: 100,
            truncated: false,
            scan_truncated: false,
            count_complete: true,
            unreadable_parameters: 0,
            skipped_parameters: 0,
            redacted_parameters: 0,
            stop_reason: "completed",
            elapsed_ms: 1,
          },
        });
      }),
    );
    const tokened = new TouchDesignerClient({
      baseUrl: TD_BASE,
      timeoutMs: 2000,
      token: "local-test-token",
    });

    await tokened.searchParameters({
      rootPath: "/project1",
      maxDepth: 3,
      valueGlob: "private-filter-sentinel*",
      expressionGlob: "*absTime*",
      typeMatch: "partial",
      nonDefaultOnly: false,
      limit: 100,
      nodeScanLimit: 1_000,
      parameterScanLimit: 25_000,
      timeBudgetMs: 1_000,
    });

    expect(new URL(capturedUrl).search).toBe("");
    expect(capturedUrl).not.toContain("private-filter-sentinel");
    expect(capturedBody).toMatchObject({
      value_glob: "private-filter-sentinel*",
      expression_glob: "*absTime*",
    });
    expect(capturedAuth).toBe("Bearer local-test-token");
  });

  it("uses authenticated bounded operation preview, commit, and receipt bodies", async () => {
    const operationPlan = {
      schema_version: 1 as const,
      label: "Wave 15 client",
      owner_path: "/project1/show",
      intents: [
        {
          kind: "create_operator" as const,
          ref: "created",
          type: "nullTOP" as const,
          name: "created1",
          parent: { path: "/project1/show" },
          position: { x: 200, y: 100 },
        },
      ],
    };
    const previewToken = "opaque.preview-token";
    const capability = "c".repeat(43);
    const operationId = "operation-wave15-0001";
    const planDigest = "a".repeat(64);
    const receipt = {
      status: "applied" as const,
      operation_id: operationId,
      receipt_capability: capability,
      bridge_instance_id: "bridge-instance-wave15",
      plan_digest: planDigest,
      owner_path: "/project1/show",
      affected_paths: ["/project1/show/created1"],
      results: [
        {
          index: 0,
          kind: "create_operator" as const,
          status: "applied" as const,
          final_paths: ["/project1/show/created1"],
        },
      ],
      verification: { status: "PASS" as const, snapshot: "after" as const },
      rollback: { attempted: false, succeeded: true, errors: [] },
      journal: {
        registered: true,
        operation_id: operationId,
        label: "MCP operation Wave 15 client",
        native_stack_delta: 1 as const,
        observed_state: "applied" as const,
      },
      warnings: [],
    };
    const requests: Array<{ path: string; body: unknown; auth: string | null }> = [];
    server.use(
      http.post(`${TD_BASE}/api/operations/preview`, async ({ request }) => {
        requests.push({
          path: new URL(request.url).pathname,
          body: await request.json(),
          auth: request.headers.get("authorization"),
        });
        return HttpResponse.json({
          ok: true,
          data: {
            status: "preview",
            schema_version: 1,
            bridge_instance_id: "bridge-instance-wave15",
            preview_token: previewToken,
            expires_at: "2026-07-16T12:00:00Z",
            plan_digest: planDigest,
            owner_path: "/project1/show",
            label: "Wave 15 client",
            effects: [
              {
                index: 0,
                kind: "create_operator",
                target_paths: ["/project1/show/created1"],
                field_names: ["type", "position"],
                summary: "create_operator affects one bounded path",
              },
            ],
            affected_paths: ["/project1/show/created1"],
            counts: {
              intents: 1,
              creates: 1,
              parameter_writes: 0,
              metadata_writes: 0,
              connects: 0,
              disconnects: 0,
            },
            risk: "bounded_graph_mutation",
            rollback_coverage: "complete_for_allowlist",
            journal_eligible: true,
            warnings: [],
          },
        });
      }),
      http.post(`${TD_BASE}/api/operations/commit`, async ({ request }) => {
        requests.push({
          path: new URL(request.url).pathname,
          body: await request.json(),
          auth: request.headers.get("authorization"),
        });
        return HttpResponse.json({ ok: true, data: receipt });
      }),
      http.post(`${TD_BASE}/api/operations/receipt`, async ({ request }) => {
        requests.push({
          path: new URL(request.url).pathname,
          body: await request.json(),
          auth: request.headers.get("authorization"),
        });
        return HttpResponse.json({
          ok: true,
          data: {
            status: "receipt",
            receipt,
            observation: {
              available: true,
              state: "applied",
              verification: "PASS",
              snapshot: "after",
            },
          },
        });
      }),
    );
    const logs: string[] = [];
    const logger = {
      debug: (message: string) => logs.push(message),
      info: (message: string) => logs.push(message),
      warn: (message: string) => logs.push(message),
      error: (message: string) => logs.push(message),
    };
    const tokened = new TouchDesignerClient({
      baseUrl: TD_BASE,
      timeoutMs: 2_000,
      token: "operation-token",
      logger,
    });

    const preview = await tokened.previewOperation(operationPlan);
    const committed = await tokened.commitOperation({
      ...operationPlan,
      preview_token: preview.preview_token,
      idempotency_key: "wave15-client-key-01",
    });
    const observed = await tokened.getOperationReceipt({
      schema_version: 1,
      operation_id: committed.operation_id,
      receipt_capability: committed.receipt_capability,
    });

    expect(observed.observation).toMatchObject({ state: "applied", snapshot: "after" });
    expect(requests.map((request) => request.path)).toEqual([
      "/api/operations/preview",
      "/api/operations/commit",
      "/api/operations/receipt",
    ]);
    expect(requests.every((request) => request.auth === "Bearer operation-token")).toBe(true);
    expect(requests[2]?.body).toEqual({
      schema_version: 1,
      operation_id: operationId,
      receipt_capability: capability,
    });
    expect(requests[2]?.path).not.toContain(capability);
    expect(receipt).not.toHaveProperty("idempotency_key");
    expect(logs.join("\n")).not.toContain(capability);
    expect(logs.join("\n")).not.toContain("wave15-client-key-01");
    expect(logs.join("\n")).not.toContain("operation-token");
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
