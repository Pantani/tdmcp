import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectKafkaEventBusSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the Kafka scaffold."),
  name: z.string().default("kafka_event_bus").describe("Generated baseCOMP name."),
  broker: z.string().default("127.0.0.1:9092").describe("Kafka/Redpanda broker hint."),
  adapter_mode: z.enum(["websocket_json", "udp_json", "manual"]).default("websocket_json"),
  server_url: z.string().default("ws://127.0.0.1:9050").describe("External adapter URL."),
  topic_root: z.string().default("tdmcp.show").describe("Topic prefix for show events."),
  topic_count: z.coerce.number().int().min(1).max(128).default(8),
  consumer_group: z.string().default("tdmcp-touchdesigner"),
  schema_format: z.enum(["json", "avro", "protobuf"]).default("json"),
  active: z.boolean().default(false),
});

type ConnectKafkaEventBusArgs = z.infer<typeof connectKafkaEventBusSchema>;

function sourceNode(args: ConnectKafkaEventBusArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "udp_json") {
    return {
      name: "kafka_udp_adapter",
      optype: "udpinDAT",
      x: 0,
      y: 120,
      params: { port: 9050, active: args.active ? 1 : 0 },
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_adapter_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Use an external Kafka adapter to write normalized events into topic_map.",
    };
  }
  return {
    name: "kafka_ws_adapter",
    optype: "websocketDAT",
    x: 0,
    y: 120,
    params: { url: args.server_url, active: args.active ? 1 : 0 },
  };
}

function topicRows(args: ConnectKafkaEventBusArgs): string[][] {
  const rows = [["label", "topic", "direction", "payload_schema"]];
  rows.push(["heartbeat", `${args.topic_root}.heartbeat`, "consume", args.schema_format]);
  for (let index = 1; index <= args.topic_count; index += 1) {
    rows.push([
      `event_${index}`,
      `${args.topic_root}.event.${index}`,
      "consume",
      args.schema_format,
    ]);
  }
  rows.push(["operator_event", `${args.topic_root}.operator.event`, "produce", "approved_json"]);
  return rows;
}

export async function connectKafkaEventBusImpl(ctx: ToolContext, args: ConnectKafkaEventBusArgs) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "kafka_event_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        broker: args.broker,
        adapter_mode: args.adapter_mode,
        server_url: args.server_url,
        topic_root: args.topic_root,
        topic_count: args.topic_count,
        consumer_group: args.consumer_group,
        schema_format: args.schema_format,
        active: args.active,
      },
      warnings: [
        "Kafka credentials, TLS/SASL config, schema registry access, and broker protocol handling are intentionally external to this scaffold.",
        "Producer routes should be policy-gated before affecting show-control systems.",
      ],
      nodes: [
        sourceNode(args),
        { name: "topic_map", optype: "tableDAT", x: 300, y: 120, table: topicRows(args) },
        {
          name: "schema_map",
          optype: "tableDAT",
          x: 600,
          y: 120,
          table: [
            ["field", "value"],
            ["schema_format", args.schema_format],
            ["consumer_group", args.consumer_group],
            ["broker", args.broker],
          ],
        },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["adapter_mode", args.adapter_mode],
            ["server_url", args.server_url],
            ["topic_count", String(args.topic_count)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Run Kafka protocol, auth, offsets, and schema decoding in an external adapter. TouchDesigner should receive stable JSON/table events only.",
        },
      ],
    },
    "connect_kafka_event_bus failed",
    (report) =>
      `Created Kafka event bus ${report.container_path}; topics ${args.topic_count}; schema ${args.schema_format}.`,
  );
}

export const registerConnectKafkaEventBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_kafka_event_bus",
    {
      title: "Connect Kafka event bus",
      description:
        "Create a Kafka/Redpanda event-bus scaffold with adapter ingest, topic maps, schema hints, consumer group metadata, and policy-gated producer notes.",
      inputSchema: connectKafkaEventBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectKafkaEventBusImpl(ctx, args),
  );
};
