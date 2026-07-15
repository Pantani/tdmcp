import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createMocapStreamBridgeImpl,
  createMocapStreamBridgeSchema,
} from "../../src/tools/layer2/createMocapStreamBridge.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("createMocapStreamBridgeImpl", () => {
  it("builds a mocap stream bridge payload", async () => {
    let capturedScript = "";

    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown };
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "mocap_stream_bridge",
          container_path: "/project1/mocap_stream_bridge",
          nodes: { rigid_body_table: "/project1/mocap_stream_bridge/rigid_body_table" },
          warnings: [],
        });
      }),
    );

    const args = createMocapStreamBridgeSchema.parse({
      source_mode: "websocket_json",
      skeleton_count: 2,
      rigid_body_count: 4,
      coordinate_space: "y_up",
      active: true,
    });
    const result = await createMocapStreamBridgeImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.kind).toBe("mocap_stream_bridge");
    expect(payload.metadata.source_mode).toBe("websocket_json");
    expect(payload.metadata.coordinate_space).toBe("y_up");
    expect(payload.nodes.map((node) => node.name)).toContain("mocap_websocket_in");
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created mocap stream bridge");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "mocap_stream_bridge", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await createMocapStreamBridgeImpl(
      makeCtx(),
      createMocapStreamBridgeSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("create_mocap_stream_bridge failed");
  });

  it("rejects out-of-range skeleton counts", () => {
    expect(() => createMocapStreamBridgeSchema.parse({ skeleton_count: 99 })).toThrow();
  });
});
