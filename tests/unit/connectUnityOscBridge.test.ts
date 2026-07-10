import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectUnityOscBridgeImpl,
  connectUnityOscBridgeSchema,
} from "../../src/tools/layer2/connectUnityOscBridge.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectUnityOscBridgeImpl", () => {
  it("builds a Unity OSC bridge payload", async () => {
    let capturedScript = "";

    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown };
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "unity_osc_bridge",
          container_path: "/project1/unity_osc_bridge",
          nodes: { object_map: "/project1/unity_osc_bridge/object_map" },
          warnings: [],
        });
      }),
    );

    const args = connectUnityOscBridgeSchema.parse({
      unity_host: "10.0.0.92",
      namespace: "/unity/show",
      object_count: 4,
      event_count: 3,
      preview_mode: "ndi",
      active: true,
    });
    const result = await connectUnityOscBridgeImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.kind).toBe("unity_osc_bridge");
    expect(payload.metadata.preview_mode).toBe("ndi");
    expect(payload.nodes.find((node) => node.name === "object_map")?.table?.join(" ")).toContain(
      "/unity/show/object/4/transform",
    );
    expect(capturedScript).toContain("nodeX");
    expect(textOf(result)).toContain("Created Unity OSC bridge");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "unity_osc_bridge", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectUnityOscBridgeImpl(
      makeCtx(),
      connectUnityOscBridgeSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_unity_osc_bridge failed");
  });

  it("rejects invalid preview modes", () => {
    expect(() => connectUnityOscBridgeSchema.parse({ preview_mode: "webrtc" })).toThrow();
  });
});
