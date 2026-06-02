import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";

export const TD_BASE = "http://127.0.0.1:9980";

const ok = (data: unknown) => HttpResponse.json({ ok: true, data });

/**
 * Default 404 for the v0.6.0 first-class endpoints (connect/disconnect, param-mode,
 * DAT-text, logs). The rewired tools try these FIRST and, on a 404 (→ TdApiError),
 * fall back to the legacy `/api/exec` path that the existing tests already mock.
 * Returning 404 here keeps every legacy test exercising its original exec path with
 * no per-test changes; tests that want to assert the endpoint path override these.
 */
const notFound = () =>
  HttpResponse.json(
    { ok: false, error: { message: "endpoint not supported (older bridge)" } },
    { status: 404 },
  );

function seg(params: { seg?: string | readonly string[] }): string {
  const raw = params.seg;
  if (raw === undefined) return "";
  return decodeURIComponent(Array.isArray(raw) ? (raw[0] ?? "") : String(raw));
}

/** Default happy-path handlers mirroring the TD bridge REST contract. */
export const tdHandlers = [
  http.get(`${TD_BASE}/api/info`, () =>
    ok({
      td_version: "2023.12000",
      python_version: "3.11.1",
      bridge_version: "0.3.0",
      build: "2023.12000",
    }),
  ),

  http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
    const body = (await request.json()) as { parent_path: string; type: string; name?: string };
    const name = body.name ?? `${body.type.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}1`;
    return ok({ path: `${body.parent_path}/${name}`, type: body.type, name });
  }),

  http.get(`${TD_BASE}/api/nodes`, ({ request }) => {
    const parent = new URL(request.url).searchParams.get("parent") ?? "/project1";
    return ok({
      nodes: [
        { path: `${parent}/noise1`, type: "noiseTOP", name: "noise1" },
        { path: `${parent}/null1`, type: "nullTOP", name: "null1" },
      ],
    });
  }),

  http.get(`${TD_BASE}/api/nodes/:seg/errors`, ({ params }) =>
    ok({ errors: [], _path: seg(params) }),
  ),

  // v0.6.0 first-class endpoints — default to 404 so the rewired tools fall back to
  // the legacy /api/exec path (which the existing tests mock). Tests asserting the
  // endpoint path override these per-test.
  http.get(`${TD_BASE}/api/nodes/:seg/params`, notFound),
  http.patch(`${TD_BASE}/api/nodes/:seg/params/:param/mode`, notFound),
  http.get(`${TD_BASE}/api/nodes/:seg/text`, notFound),
  http.put(`${TD_BASE}/api/nodes/:seg/text`, notFound),
  http.post(`${TD_BASE}/api/connect`, notFound),
  http.post(`${TD_BASE}/api/disconnect`, notFound),
  http.get(`${TD_BASE}/api/logs`, notFound),
  http.post(`${TD_BASE}/api/transport`, notFound),
  http.get(`${TD_BASE}/api/system`, notFound),

  http.post(`${TD_BASE}/api/nodes/:seg/method`, () => ok({ result: "ok" })),

  http.get(`${TD_BASE}/api/nodes/:seg`, ({ params }) =>
    ok({
      path: seg(params),
      type: "noiseTOP",
      name: "noise1",
      parameters: { period: 1, amplitude: 1 },
      inputs: [],
      outputs: [],
    }),
  ),

  http.patch(`${TD_BASE}/api/nodes/:seg`, async ({ params, request }) => {
    const body = (await request.json()) as { parameters: Record<string, unknown> };
    return ok({
      path: seg(params),
      type: "noiseTOP",
      name: "noise1",
      parameters: body.parameters,
    });
  }),

  http.delete(`${TD_BASE}/api/nodes/:seg`, ({ params }) => ok({ deleted: seg(params) })),

  http.post(`${TD_BASE}/api/exec`, () => ok({ result: null, stdout: "" })),

  http.get(`${TD_BASE}/api/preview/:seg`, ({ params, request }) => {
    const url = new URL(request.url);
    return ok({
      path: seg(params),
      width: Number(url.searchParams.get("width") ?? 640),
      height: Number(url.searchParams.get("height") ?? 360),
      format: "png",
      base64:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    });
  }),

  http.post(`${TD_BASE}/api/batch`, async ({ request }) => {
    const body = (await request.json()) as { operations: Array<{ action: string }> };
    return ok({ results: body.operations.map((op) => ({ action: op.action, ok: true })) });
  }),

  http.get(`${TD_BASE}/api/network/:seg/errors`, () => ok({ errors: [] })),
  http.get(`${TD_BASE}/api/network/:seg/topology`, ({ params }) =>
    ok({
      nodes: [{ path: `${seg(params)}/noise1`, type: "noiseTOP", name: "noise1" }],
      connections: [],
    }),
  ),
  http.get(`${TD_BASE}/api/network/:seg/performance`, () =>
    ok({ nodes: [{ path: "/project1/noise1", cook_time_ms: 0.5 }], total_cook_time_ms: 0.5 }),
  ),
];

export function makeTdServer() {
  return setupServer(...tdHandlers);
}

/** A handler that simulates TD being offline (network failure) for `/api/info`. */
export const offlineInfoHandler = http.get(`${TD_BASE}/api/info`, () => HttpResponse.error());
