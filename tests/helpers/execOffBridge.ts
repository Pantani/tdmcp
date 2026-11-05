import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import policy from "../fixtures/exec-off-policy.json" with { type: "json" };
import { olderBridgeNotFoundHandlers, TD_BASE, tdHandlers } from "./tdMock.js";

/**
 * An msw bridge that behaves like a CURRENT tdmcp bridge whose TouchDesigner
 * process runs with `TDMCP_BRIDGE_ALLOW_EXEC=0`.
 *
 * Refusals are a TypeScript port of the gates in
 * `td/modules/mcp/controllers/api_controller.py`. The port is held to the Python
 * source by `td/tests/test_exec_off_policy_parity.py`, which runs the shared
 * fixture `tests/fixtures/exec-off-policy.json` through the real router.
 *
 * What this mock cannot do: it does not cook anything. Responses only satisfy the
 * client's Zod envelopes, so a tool that "builds" here has proved that its request
 * sequence avoids the refused routes, not that the network it describes works in
 * TouchDesigner.
 */

export type ExecOffGate = keyof typeof policy.messages;

const ok = (data: unknown) => HttpResponse.json({ ok: true, data });

function decodedSeg(params: { seg?: string | readonly string[] }): string {
  const raw = params.seg;
  return decodeURIComponent(typeof raw === "string" ? raw : (raw?.[0] ?? ""));
}

/**
 * First-class routes that survive exec-off on a current bridge. tdMock answers
 * these with 404 ("older bridge") so legacy tests reach their exec fallbacks; here
 * they answer, so a fallback only runs where a real current bridge would run one.
 * `tests/fixtures/exec-off-policy.json#currentBridgeRoutes` lists them for the
 * Python parity test, which checks that the real router recognises each one.
 */
const currentBridgeHandlers = [
  http.post(`${TD_BASE}/api/connect`, async ({ request }) => {
    const body = (await request.clone().json()) as Record<string, unknown>;
    return ok({
      source_path: body.source_path,
      target_path: body.target_path,
      source_output: body.source_output ?? 0,
      actual_input: body.target_input ?? 0,
      connected: true,
    });
  }),
  http.post(`${TD_BASE}/api/disconnect`, async ({ request }) => {
    const body = (await request.clone().json()) as Record<string, unknown>;
    return ok({ to_path: body.to_path, removed: [], warnings: [] });
  }),
  http.get(`${TD_BASE}/api/nodes/search`, () =>
    ok({ results: [], matches: [], count: 0, truncated: false }),
  ),
  http.get(`${TD_BASE}/api/nodes/:seg/params`, ({ params }) =>
    ok({
      path: decodedSeg(params),
      type: "noiseTOP",
      name: "noise1",
      parameters: [],
      warnings: [],
    }),
  ),
  http.patch(`${TD_BASE}/api/nodes/:seg/params/:param/mode`, async ({ params, request }) => {
    const body = (await request.clone().json()) as Record<string, unknown>;
    return ok({
      path: decodedSeg(params),
      param: String(params.param),
      mode: String(body.mode ?? "constant"),
      readback_mode: String(body.mode ?? "constant"),
      readback_expr: "",
    });
  }),
  http.get(`${TD_BASE}/api/nodes/:seg/text`, ({ params }) =>
    ok({ path: decodedSeg(params), text: "", is_table: false, num_rows: 0, num_cols: 0 }),
  ),
  http.get(`${TD_BASE}/api/nodes/:seg/custom_params`, () => ok({ params: [], warnings: [] })),
  http.post(`${TD_BASE}/api/param_modes/batch`, () => ok({ items: [] })),
  http.get(`${TD_BASE}/api/logs`, () => ok({ lines: [], count: 0, available: true, warnings: [] })),
  http.get(`${TD_BASE}/api/system`, () =>
    ok({ gpu: { name: "mock" }, monitors: [], performMode: false }),
  ),
  http.get(`${TD_BASE}/api/optypes`, () => ok({ optypes: [], families: {}, count: 0 })),
  http.post(`${TD_BASE}/api/params/watch`, async ({ request }) => {
    const body = (await request.clone().json()) as Record<string, unknown>;
    return ok({ path: body.path, pars: null, watching: true });
  }),
  http.delete(`${TD_BASE}/api/params/watch`, ({ request }) =>
    ok({
      path: new URL(request.url).searchParams.get("path") ?? "",
      pars: null,
      watching: false,
    }),
  ),
  http.get(`${TD_BASE}/api/params/watch`, () => ok({ watches: [] })),
  http.post(`${TD_BASE}/api/duplicate`, async ({ request }) => {
    const body = (await request.clone().json()) as Record<string, unknown>;
    const source = String(body.source ?? "/project1/smoke");
    return ok({ source, copy: `${source}_copy`, parent: "/project1" });
  }),
  http.post(`${TD_BASE}/api/perform`, async ({ request }) => {
    const body = (await request.clone().json()) as Record<string, unknown>;
    return ok({
      enabled: body.enabled === true,
      was: false,
      stored: false,
      ui_perform_mode_set: true,
      project_perform_mode_set: true,
      warnings: [],
    });
  }),
  http.post(`${TD_BASE}/api/nodes/:seg/custom_params`, async ({ params }) =>
    ok({
      status: "applied",
      comp_path: decodedSeg(params),
      results: [],
      rollback: { attempted: false, succeeded: false },
      warnings: [],
      request_fingerprint: "exec-off-smoke",
    }),
  ),
  http.post(`${TD_BASE}/api/editor/insert`, async ({ request }) => {
    const body = (await request.clone().json()) as Record<string, unknown>;
    const type = String(body.type);
    return ok({
      status: "applied",
      idempotency_key: body.idempotency_key,
      context: {
        owner_path: "/project1",
        selected_path: "/project1/smoke",
        current_path: "/project1/smoke",
      },
      node: { path: "/project1/inserted1", type, name: "inserted1", nodeX: 0, nodeY: 0 },
      before: { edges: [] },
      after: { edges: [] },
      rollback: { attempted: false, succeeded: false },
      warnings: [],
    });
  }),
];

/** tdMock's happy-path handlers minus its "older bridge" 404s. */
const coreHandlers = tdHandlers.filter((handler) => !olderBridgeNotFoundHandlers.includes(handler));

export interface BridgeCall {
  method: string;
  path: string;
  /** Set when the policy refused this call. */
  gate?: ExecOffGate;
  /** The refused `/api/exec` script, kept to tell placement from real work. */
  script?: string;
  /** No handler answered: the tool's outcome says nothing about exec policy. */
  mockGap?: boolean;
}

const refuse = (gate: ExecOffGate, detail?: string) =>
  HttpResponse.json(
    {
      ok: false,
      error: {
        code: "bridge_error",
        message: detail ?? policy.messages[gate],
      },
    },
    { status: 403 },
  );

function normalizedIdentifier(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]/g, "") : "";
}

function isCodeParameter(name: string, type: string): boolean {
  const n = normalizedIdentifier(name);
  return (
    policy.codeParameterNames.includes(n) ||
    n.endsWith("expr") ||
    /^ext\d+object$/.test(n) ||
    policy.codeParameterPrefixes.some((prefix) => n.startsWith(prefix)) ||
    (policy.typeSpecificCodeParameters as Record<string, string[]>)[type]?.includes(n) === true
  );
}

/** Port of `_generic_node_code_sources`; the parity test holds it to the Python. */
export function genericNodeCodeSources(
  typeName: unknown,
  parameters?: Record<string, unknown> | null,
): string[] {
  const type = normalizedIdentifier(typeName);
  const sources: string[] = [];
  if (policy.executableOperatorFragments.some((fragment) => type.includes(fragment))) {
    sources.push(`operator type ${String(typeName)}`);
  }
  for (const name of Object.keys(parameters ?? {})) {
    const datFile =
      type.endsWith("dat") && policy.datFileParameterNames.includes(normalizedIdentifier(name));
    if (isCodeParameter(name, type) || datFile) sources.push(`parameter ${name}`);
  }
  return [...new Set(sources)];
}

/** Port of `_custom_params_contains_caller_code`. */
export function customParamsContainCallerCode(body: unknown): boolean {
  const operations = (body as { operations?: unknown } | null)?.operations;
  if (!Array.isArray(operations)) return false;
  return operations.some((operation) => {
    if (operation?.action !== "edit_parameter") return false;
    const fields = operation.fields;
    if (fields === null || typeof fields !== "object") return false;
    const mode = String(fields.mode ?? "")
      .trim()
      .toUpperCase();
    return (
      mode === "EXPRESSION" ||
      mode === "BIND" ||
      "expression" in fields ||
      "bind_expression" in fields
    );
  });
}

function genericRefusal(gate: ExecOffGate, action: string, sources: string[]) {
  return refuse(
    gate,
    `Forbidden: ${action} with ${sources.join(", ")} is disabled (TDMCP_BRIDGE_ALLOW_EXEC=0).`,
  );
}

type BatchOperation = {
  action?: string;
  type?: unknown;
  name?: string;
  parent_path?: string;
  path?: string;
  parameters?: Record<string, unknown>;
};

export function makeExecOffBridge() {
  let calls: BridgeCall[] = [];
  const nodeTypes = new Map<string, string>();
  const record = (call: BridgeCall) => calls.push(call);

  function batchRefusal(operations: unknown) {
    if (!Array.isArray(operations)) return undefined;
    const known = new Map(nodeTypes);
    for (const op of operations as BatchOperation[]) {
      if (op?.action === "create") {
        const sources = genericNodeCodeSources(op.type, op.parameters);
        if (sources.length > 0) return { action: "generic node creation", sources };
        if (op.name && op.parent_path) {
          known.set(`${op.parent_path.replace(/\/$/, "")}/${op.name}`, String(op.type));
        }
      } else if (op?.action === "update" && op.path) {
        const sources = genericNodeCodeSources(known.get(op.path) ?? "", op.parameters);
        if (sources.length > 0) return { action: "generic parameter update", sources };
      }
    }
    return undefined;
  }

  /** Returns a refusal for gated calls, or undefined to let the call through. */
  async function gate(request: Request, path: string): Promise<Response | undefined> {
    const method = request.method;
    const body: Record<string, unknown> =
      method === "GET" || method === "DELETE"
        ? {}
        : ((await request
            .clone()
            .json()
            .catch(() => ({}))) as Record<string, unknown>);

    const deny = (name: ExecOffGate, response: Response, script?: string) => {
      record({ method, path, gate: name, ...(script !== undefined ? { script } : {}) });
      return response;
    };

    if (method === "POST" && path === "/api/exec") {
      return deny("exec", refuse("exec"), typeof body.script === "string" ? body.script : "");
    }
    if (method === "POST" && /^\/api\/nodes\/.+\/method$/.test(path)) {
      return deny("method", refuse("method"));
    }
    if (method === "POST" && path === "/api/nodes") {
      const sources = genericNodeCodeSources(
        body.type,
        body.parameters as Record<string, unknown> | undefined,
      );
      if (sources.length > 0) {
        return deny("node_code", genericRefusal("node_code", "generic node creation", sources));
      }
      const name = typeof body.name === "string" ? body.name : undefined;
      if (name) nodeTypes.set(`${String(body.parent_path)}/${name}`, String(body.type));
      return undefined;
    }
    if (method === "POST" && path === "/api/editor/insert") {
      const sources = genericNodeCodeSources(
        body.type,
        body.parameters as Record<string, unknown> | undefined,
      );
      if (sources.length > 0) {
        return deny("node_code", genericRefusal("node_code", "editor node insertion", sources));
      }
      return undefined;
    }
    if (method === "POST" && path === "/api/batch") {
      const refusal = batchRefusal(body.operations);
      if (refusal) {
        return deny("node_code", genericRefusal("node_code", refusal.action, refusal.sources));
      }
      return undefined;
    }
    if (method === "PATCH" && /^\/api\/nodes\/.+\/params\/[^/]+\/mode$/.test(path)) {
      const mode = String(body.mode ?? "expression")
        .trim()
        .toLowerCase();
      if (mode === "" || mode === "expression" || mode === "bind" || "expr" in body) {
        return deny("param_mode", refuse("param_mode"));
      }
      return undefined;
    }
    if (method === "PUT" && /^\/api\/nodes\/.+\/text$/.test(path)) {
      return deny("dat_text", refuse("dat_text"));
    }
    if (method === "POST" && /^\/api\/nodes\/.+\/custom_params$/.test(path)) {
      if (customParamsContainCallerCode(body))
        return deny("custom_params", refuse("custom_params"));
      return undefined;
    }
    if (method === "PATCH" && /^\/api\/nodes\/[^/]+$/.test(path)) {
      const nodePath = decodeURIComponent(path.slice("/api/nodes/".length));
      const sources = genericNodeCodeSources(
        nodeTypes.get(`/${nodePath.replace(/^\//, "")}`) ?? "",
        body.parameters as Record<string, unknown> | undefined,
      );
      if (sources.length > 0) {
        return deny("node_code", genericRefusal("node_code", "generic parameter update", sources));
      }
      return undefined;
    }
    return undefined;
  }

  const gateHandler = http.all(`${TD_BASE}/*`, async ({ request }) => {
    const path = new URL(request.url).pathname;
    const refused = await gate(request, path);
    if (refused) return refused;
    record({ method: request.method, path });
    return undefined;
  });

  /**
   * Served last: a route neither the policy nor the mock knows. It must never look
   * like a missing endpoint (404), or a tool would fall back to exec and be
   * misreported as exec-dependent because of a hole in this mock.
   */
  const unknownRoute = http.all(`${TD_BASE}/*`, ({ request }) => {
    const path = new URL(request.url).pathname;
    const call = calls.findLast((c) => c.path === path && c.method === request.method);
    if (call) call.mockGap = true;
    return HttpResponse.json(
      {
        ok: false,
        error: { code: "mock_gap", message: `exec-off mock: no handler for ${path}` },
      },
      { status: 501 },
    );
  });

  const server = setupServer(gateHandler, ...currentBridgeHandlers, ...coreHandlers, unknownRoute);

  return {
    server,
    takeCalls(): BridgeCall[] {
      const taken = calls;
      calls = [];
      nodeTypes.clear();
      return taken;
    },
  };
}
