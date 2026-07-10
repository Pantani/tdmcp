import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectMaxMspBridgeImpl,
  connectMaxMspBridgeSchema,
} from "../../src/tools/layer2/connectMaxMspBridge.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectMaxMspBridgeImpl", () => {
  it("normalizes namespace and builds a Max/MSP OSC bridge payload", async () => {
    let capturedScript = "";

    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown };
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "max_msp_bridge",
          container_path: "/project1/max_msp_bridge",
          nodes: { channel_map: "/project1/max_msp_bridge/channel_map" },
          warnings: [],
        });
      }),
    );

    const args = connectMaxMspBridgeSchema.parse({
      max_host: "10.0.0.60",
      namespace: "show/max/",
      channel_count: 5,
      include_audio_features: true,
      active: true,
    });
    const result = await connectMaxMspBridgeImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.kind).toBe("max_msp_bridge");
    expect(payload.metadata.namespace).toBe("/show/max");
    expect(payload.metadata.channel_count).toBe(5);
    expect(payload.nodes.find((node) => node.name === "channel_map")?.table?.[1]?.[1]).toBe(
      "/show/max/param/1",
    );
    expect(capturedScript).toContain("nodeX");
    expect(textOf(result)).toContain("Created Max/MSP bridge");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "max_msp_bridge", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectMaxMspBridgeImpl(makeCtx(), connectMaxMspBridgeSchema.parse({}));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_max_msp_bridge failed");
  });

  it("rejects invalid channel counts", () => {
    expect(() => connectMaxMspBridgeSchema.parse({ channel_count: 0 })).toThrow();
  });
});
