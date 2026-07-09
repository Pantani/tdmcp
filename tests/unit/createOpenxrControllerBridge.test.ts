import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createOpenxrControllerBridgeImpl,
  createOpenxrControllerBridgeSchema,
} from "../../src/tools/layer2/createOpenxrControllerBridge.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("createOpenxrControllerBridgeImpl", () => {
  it("builds an OpenXR controller bridge payload", async () => {
    let capturedScript = "";

    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown };
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "openxr_controller_bridge",
          container_path: "/project1/openxr_controller_bridge",
          nodes: { pose_map: "/project1/openxr_controller_bridge/pose_map" },
          warnings: [],
        });
      }),
    );

    const args = createOpenxrControllerBridgeSchema.parse({
      source_mode: "websocket_json",
      controller_count: 2,
      coordinate_space: "steamvr",
      active: true,
    });
    const result = await createOpenxrControllerBridgeImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.kind).toBe("openxr_controller_bridge");
    expect(payload.metadata.source_mode).toBe("websocket_json");
    expect(payload.metadata.coordinate_space).toBe("steamvr");
    expect(payload.nodes.map((node) => node.name)).toContain("openxr_websocket_in");
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created OpenXR controller bridge");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "openxr_controller_bridge", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await createOpenxrControllerBridgeImpl(
      makeCtx(),
      createOpenxrControllerBridgeSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("create_openxr_controller_bridge failed");
  });

  it("rejects invalid controller counts", () => {
    expect(() => createOpenxrControllerBridgeSchema.parse({ controller_count: 0 })).toThrow();
  });
});
