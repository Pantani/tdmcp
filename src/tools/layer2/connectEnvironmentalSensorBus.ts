import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectEnvironmentalSensorBusSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for environment sensors."),
  name: z.string().default("environmental_sensor_bus").describe("Generated baseCOMP name."),
  sensor_profile: z
    .enum(["co2_temp_humidity", "air_quality", "mixed", "manual"])
    .default("co2_temp_humidity"),
  adapter_mode: z.enum(["websocket_json", "http_json", "mqtt_json", "manual"]).default("http_json"),
  adapter_url: z.string().default("http://127.0.0.1:9093/environment"),
  zone_count: z.coerce.number().int().min(1).max(128).default(6),
  sensor_count: z.coerce.number().int().min(1).max(512).default(12),
  active: z.boolean().default(false),
});

type ConnectEnvironmentalSensorBusArgs = z.infer<typeof connectEnvironmentalSensorBusSchema>;

function sourceNode(args: ConnectEnvironmentalSensorBusArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "websocket_json") {
    return {
      name: "environment_ws_adapter",
      optype: "websocketDAT",
      x: 0,
      y: 120,
      params: { url: args.adapter_url, active: args.active ? 1 : 0 },
    };
  }
  if (args.adapter_mode === "mqtt_json") {
    return {
      name: "environment_mqtt_adapter",
      optype: "mqttclientDAT",
      x: 0,
      y: 120,
      params: { address: args.adapter_url, active: args.active ? 1 : 0 },
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_environment_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Paste normalized readings into environment_readings.",
    };
  }
  return {
    name: "environment_http_adapter",
    optype: "webclientDAT",
    x: 0,
    y: 120,
    params: { url: args.adapter_url, active: args.active ? 1 : 0 },
  };
}

function sensorRows(args: ConnectEnvironmentalSensorBusArgs): string[][] {
  const rows = [["sensor", "zone", "profile", "unit_hint"]];
  for (let index = 1; index <= args.sensor_count; index += 1) {
    rows.push([
      `sensor_${index}`,
      `zone_${((index - 1) % args.zone_count) + 1}`,
      args.sensor_profile,
      "normalized",
    ]);
  }
  return rows;
}

function readingRows(args: ConnectEnvironmentalSensorBusArgs): string[][] {
  const rows = [["zone", "co2_ppm", "temp_c", "humidity_pct", "pm25", "status"]];
  for (let index = 1; index <= args.zone_count; index += 1) {
    rows.push([`zone_${index}`, "0", "0", "0", "0", "unknown"]);
  }
  return rows;
}

export async function connectEnvironmentalSensorBusImpl(
  ctx: ToolContext,
  args: ConnectEnvironmentalSensorBusArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "environmental_sensor_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        sensor_profile: args.sensor_profile,
        adapter_mode: args.adapter_mode,
        adapter_url: args.adapter_url,
        zone_count: args.zone_count,
        sensor_count: args.sensor_count,
        active: args.active,
      },
      warnings: [
        "Environmental readings are advisory show inputs, not life-safety or code-compliance measurements.",
        "Building automation credentials and HVAC control decisions stay outside TouchDesigner.",
      ],
      nodes: [
        sourceNode(args),
        { name: "sensor_map", optype: "tableDAT", x: 300, y: 120, table: sensorRows(args) },
        {
          name: "environment_readings",
          optype: "tableDAT",
          x: 600,
          y: 120,
          table: readingRows(args),
        },
        {
          name: "comfort_policy",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["sensor_profile", args.sensor_profile],
            ["hvac_control_in_td", "false"],
            ["life_safety_claim", "false"],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Normalize CO2, temperature, humidity, and air-quality data in an adapter. Use readings for ambience, dashboards, and noncritical cues only.",
        },
      ],
    },
    "connect_environmental_sensor_bus failed",
    (report) =>
      `Created environmental sensor bus ${report.container_path}; sensors ${args.sensor_count}; zones ${args.zone_count}.`,
  );
}

export const registerConnectEnvironmentalSensorBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_environmental_sensor_bus",
    {
      title: "Connect environmental sensor bus",
      description:
        "Create an environmental sensor scaffold with normalized readings, sensor maps, adapter source, and building-control safety notes.",
      inputSchema: connectEnvironmentalSensorBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectEnvironmentalSensorBusImpl(ctx, args),
  );
};
