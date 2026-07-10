import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectKafkaEventBusImpl,
  connectKafkaEventBusSchema,
} from "../../src/tools/layer2/connectKafkaEventBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectKafkaEventBusImpl", () => {
  it("builds a Kafka event bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "kafka_event_bus",
          container_path: "/project1/kafka_event_bus",
          nodes: { topic_map: "/project1/kafka_event_bus/topic_map" },
          warnings: [],
        });
      }),
    );

    const args = connectKafkaEventBusSchema.parse({
      broker: "redpanda.local:9092",
      topic_root: "venue.show",
      topic_count: 3,
      schema_format: "avro",
    });
    const result = await connectKafkaEventBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.broker).toBe("redpanda.local:9092");
    expect(payload.nodes.find((node) => node.name === "kafka_ws_adapter")?.optype).toBe(
      "websocketDAT",
    );
    expect(payload.nodes.find((node) => node.name === "topic_map")?.table?.join(" ")).toContain(
      "venue.show.event.3",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created Kafka event bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "kafka_event_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectKafkaEventBusImpl(makeCtx(), connectKafkaEventBusSchema.parse({}));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_kafka_event_bus failed");
  });

  it("rejects invalid topic counts", () => {
    expect(() => connectKafkaEventBusSchema.parse({ topic_count: 0 })).toThrow();
  });
});
