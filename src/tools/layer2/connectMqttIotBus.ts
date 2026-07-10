import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const connectMqttIotBusSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the MQTT scaffold."),
  name: z.string().default("mqtt_iot_bus").describe("Generated baseCOMP name."),
  broker_host: z.string().default("127.0.0.1").describe("MQTT broker host."),
  broker_port: z.coerce.number().int().min(1).max(65535).default(1883),
  topic_root: z.string().default("tdmcp/show").describe("Root MQTT topic for show data."),
  topic_count: z.coerce.number().int().min(1).max(128).default(8),
  client_id: z.string().default("tdmcp_touchdesigner"),
  qos: z.coerce.number().int().min(0).max(2).default(0),
  active: z.boolean().default(false),
});

type ConnectMqttIotBusArgs = z.infer<typeof connectMqttIotBusSchema>;

function topicRows(args: ConnectMqttIotBusArgs): string[][] {
  const root = args.topic_root.replace(/\/$/, "");
  const rows = [["label", "topic", "payload_hint"]];
  rows.push(["heartbeat", `${root}/heartbeat`, "json"]);
  for (let index = 1; index <= args.topic_count; index += 1) {
    rows.push([`sensor_${index}`, `${root}/sensor/${index}`, "number|json"]);
  }
  rows.push(["operator_command", `${root}/operator/command`, "approved json"]);
  return rows;
}

export async function connectMqttIotBusImpl(ctx: ToolContext, args: ConnectMqttIotBusArgs) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "mqtt_iot_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        broker_host: args.broker_host,
        broker_port: args.broker_port,
        topic_root: args.topic_root,
        topic_count: args.topic_count,
        client_id: args.client_id,
        qos: args.qos,
        active: args.active,
      },
      warnings: [
        "MQTT credentials are intentionally not stored in this scaffold; configure secrets in TouchDesigner or environment-specific callbacks.",
        "Operator command topics should be policy-gated before they affect physical show systems.",
      ],
      nodes: [
        {
          name: "mqtt",
          optype: "mqttclientDAT",
          x: 0,
          y: 120,
          params: {
            netaddress: args.broker_host,
            port: args.broker_port,
            userid: args.client_id,
            active: args.active ? 1 : 0,
          },
        },
        { name: "topic_map", optype: "tableDAT", x: 300, y: 120, table: topicRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["broker", `${args.broker_host}:${args.broker_port}`],
            ["topic_root", args.topic_root],
            ["topic_count", String(args.topic_count)],
            ["client_id", args.client_id],
            ["qos", String(args.qos)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: 120,
          text: "Use the MQTT Client DAT callbacks to parse topic_map payloads into normalized CHOP/DAT channels. Keep broker credentials outside generated tables.",
        },
      ],
    },
    "connect_mqtt_iot_bus failed",
    (report) =>
      `Created MQTT IoT bus scaffold ${report.container_path}; broker ${args.broker_host}:${args.broker_port}; topics ${args.topic_count}.`,
  );
}

export const registerConnectMqttIotBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_mqtt_iot_bus",
    {
      title: "Connect MQTT IoT bus",
      description:
        "Create an MQTT Client DAT bus scaffold for IoT sensors, installation telemetry, and policy-gated operator commands.",
      inputSchema: connectMqttIotBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectMqttIotBusImpl(ctx, args),
  );
};
