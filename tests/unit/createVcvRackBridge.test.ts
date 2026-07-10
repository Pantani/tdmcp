import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createVcvRackBridgeImpl,
  createVcvRackBridgeSchema,
} from "../../src/tools/layer2/createVcvRackBridge.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("createVcvRackBridgeImpl", () => {
  it("builds a VCV Rack modulation bridge payload", async () => {
    let capturedScript = "";

    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown };
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "vcv_rack_bridge",
          container_path: "/project1/vcv_rack_bridge",
          nodes: { channel_map: "/project1/vcv_rack_bridge/channel_map" },
          warnings: [],
        });
      }),
    );

    const args = createVcvRackBridgeSchema.parse({
      mode: "midi",
      midi_device: "IAC Driver",
      channel_count: 12,
      bipolar: false,
      active: true,
    });
    const result = await createVcvRackBridgeImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.kind).toBe("vcv_rack_bridge");
    expect(payload.metadata.mode).toBe("midi");
    expect(payload.metadata.midi_device).toBe("IAC Driver");
    expect(payload.metadata.channel_count).toBe(12);
    expect(payload.nodes.map((node) => node.name)).toContain("channel_map");
    expect(capturedScript).toContain("nodeX");
    expect(textOf(result)).toContain("Created VCV Rack bridge");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "vcv_rack_bridge", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await createVcvRackBridgeImpl(makeCtx(), createVcvRackBridgeSchema.parse({}));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("create_vcv_rack_bridge failed");
  });

  it("rejects too many channels", () => {
    expect(() => createVcvRackBridgeSchema.parse({ channel_count: 128 })).toThrow();
  });
});
