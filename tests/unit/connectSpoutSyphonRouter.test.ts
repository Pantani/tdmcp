import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectSpoutSyphonRouterImpl,
  connectSpoutSyphonRouterSchema,
} from "../../src/tools/layer2/connectSpoutSyphonRouter.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectSpoutSyphonRouterImpl", () => {
  it("builds a Syphon/Spout router scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "spout_syphon_router",
          container_path: "/project1/spout_syphon_router",
          nodes: { route_map: "/project1/spout_syphon_router/route_map" },
          warnings: [],
        });
      }),
    );

    const args = connectSpoutSyphonRouterSchema.parse({
      source_name: "Resolume Main",
      output_name: "TD Processed",
      route_count: 3,
      active: true,
    });
    const result = await connectSpoutSyphonRouterImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.kind).toBe("spout_syphon_router");
    expect(payload.metadata.source_name).toBe("Resolume Main");
    expect(payload.nodes.find((node) => node.name === "route_map")?.table?.join(" ")).toContain(
      "TD Processed_3",
    );
    expect(capturedScript).toContain("nodeX");
    expect(textOf(result)).toContain("Created Syphon/Spout router");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "spout_syphon_router", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectSpoutSyphonRouterImpl(
      makeCtx(),
      connectSpoutSyphonRouterSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_spout_syphon_router failed");
  });

  it("rejects invalid route counts", () => {
    expect(() => connectSpoutSyphonRouterSchema.parse({ route_count: 0 })).toThrow();
  });
});
