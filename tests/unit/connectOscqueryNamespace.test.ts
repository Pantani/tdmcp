import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectOscqueryNamespaceImpl,
  connectOscqueryNamespaceSchema,
} from "../../src/tools/layer2/connectOscqueryNamespace.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectOscqueryNamespaceImpl", () => {
  it("builds an OSCQuery namespace scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "oscquery_namespace",
          container_path: "/project1/oscquery_namespace",
          nodes: { namespace_http: "/project1/oscquery_namespace/namespace_http" },
          warnings: [],
        });
      }),
    );

    const args = connectOscqueryNamespaceSchema.parse({
      service_host: "10.0.0.15",
      http_port: 5679,
      namespace_root: "/composition",
      action_count: 4,
      active: true,
    });
    const result = await connectOscqueryNamespaceImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.namespace_root).toBe("/composition");
    expect(payload.nodes.find((node) => node.name === "namespace_http")?.params?.url).toBe(
      "http://10.0.0.15:5679/composition",
    );
    expect(payload.nodes.find((node) => node.name === "action_map")?.table?.join(" ")).toContain(
      "/composition/control/4",
    );
    expect(capturedScript).toContain("nodeX");
    expect(textOf(result)).toContain("Created OSCQuery namespace scaffold");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "oscquery_namespace", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectOscqueryNamespaceImpl(
      makeCtx(),
      connectOscqueryNamespaceSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_oscquery_namespace failed");
  });

  it("rejects invalid action counts", () => {
    expect(() => connectOscqueryNamespaceSchema.parse({ action_count: 0 })).toThrow();
  });
});
