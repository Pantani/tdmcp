import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectUdpTelemetryBridgeImpl,
  connectUdpTelemetryBridgeSchema,
} from "../../src/tools/layer2/connectUdpTelemetryBridge.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectUdpTelemetryBridgeImpl", () => {
  it("builds a UDP telemetry bridge scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "udp_telemetry_bridge",
          container_path: "/project1/udp_telemetry_bridge",
          nodes: { packet_map: "/project1/udp_telemetry_bridge/packet_map" },
          warnings: [],
        });
      }),
    );

    const args = connectUdpTelemetryBridgeSchema.parse({
      listen_port: 9100,
      remote_address: "10.0.0.9",
      remote_port: 9101,
      packet_count: 4,
    });
    const result = await connectUdpTelemetryBridgeImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.listen_port).toBe(9100);
    expect(payload.nodes.find((node) => node.name === "udp_in")?.optype).toBe("udpinDAT");
    expect(payload.nodes.find((node) => node.name === "udp_out")?.optype).toBe("udpoutDAT");
    expect(payload.nodes.find((node) => node.name === "packet_map")?.table?.join(" ")).toContain(
      "udp_field_4",
    );
    expect(payload.nodes.find((node) => node.name === "reply_map")?.table?.join(" ")).toContain(
      "10.0.0.9:9101",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created UDP telemetry bridge");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "udp_telemetry_bridge", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectUdpTelemetryBridgeImpl(
      makeCtx(),
      connectUdpTelemetryBridgeSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_udp_telemetry_bridge failed");
  });

  it("rejects invalid listen ports", () => {
    expect(() => connectUdpTelemetryBridgeSchema.parse({ listen_port: 0 })).toThrow();
  });
});
