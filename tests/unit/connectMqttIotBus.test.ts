import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectMqttIotBusImpl,
  connectMqttIotBusSchema,
} from "../../src/tools/layer2/connectMqttIotBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectMqttIotBusImpl", () => {
  it("builds an MQTT IoT bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "mqtt_iot_bus",
          container_path: "/project1/mqtt_iot_bus",
          nodes: { topic_map: "/project1/mqtt_iot_bus/topic_map" },
          warnings: [],
        });
      }),
    );

    const args = connectMqttIotBusSchema.parse({
      broker_host: "broker.local",
      topic_root: "venue/a",
      topic_count: 3,
      client_id: "td_show",
      qos: 1,
    });
    const result = await connectMqttIotBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.broker_host).toBe("broker.local");
    expect(payload.nodes.find((node) => node.name === "topic_map")?.table?.join(" ")).toContain(
      "venue/a/sensor/3",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created MQTT IoT bus scaffold");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "mqtt_iot_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectMqttIotBusImpl(makeCtx(), connectMqttIotBusSchema.parse({}));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_mqtt_iot_bus failed");
  });

  it("rejects invalid broker ports", () => {
    expect(() => connectMqttIotBusSchema.parse({ broker_port: 0 })).toThrow();
  });
});
