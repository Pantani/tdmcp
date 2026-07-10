import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createNdiRouterMatrixImpl,
  createNdiRouterMatrixSchema,
} from "../../src/tools/layer2/createNdiRouterMatrix.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("createNdiRouterMatrixImpl", () => {
  it("builds an NDI router matrix payload", async () => {
    let capturedScript = "";

    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "ndi_router_matrix",
          container_path: "/project1/ndi_router_matrix",
          nodes: { route_matrix: "/project1/ndi_router_matrix/route_matrix" },
          warnings: [],
        });
      }),
    );

    const args = createNdiRouterMatrixSchema.parse({
      source_count: 5,
      output_count: 3,
      include_preview: true,
      active: true,
    });
    const result = await createNdiRouterMatrixImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.kind).toBe("ndi_router_matrix");
    expect(payload.metadata.source_count).toBe(5);
    expect(payload.metadata.output_count).toBe(3);
    expect(payload.nodes.find((node) => node.name === "preview_receiver")?.optype).toBe("ndiinTOP");
    expect(capturedScript).toContain("nodeX");
    expect(textOf(result)).toContain("Created NDI router matrix");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "ndi_router_matrix", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await createNdiRouterMatrixImpl(
      makeCtx(),
      createNdiRouterMatrixSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("create_ndi_router_matrix failed");
  });

  it("rejects invalid output counts", () => {
    expect(() => createNdiRouterMatrixSchema.parse({ output_count: 0 })).toThrow();
  });
});
