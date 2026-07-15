import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectParkingOccupancyBusSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the parking scaffold."),
  name: z.string().default("parking_occupancy_bus").describe("Generated baseCOMP name."),
  provider: z
    .enum(["camera_analytics", "iot_counter", "api_vendor", "manual"])
    .default("iot_counter"),
  lot_label: z.string().default("main_lot"),
  adapter_mode: z.enum(["rest_json", "websocket_json", "manual"]).default("rest_json"),
  adapter_url: z.string().default("http://127.0.0.1:9071/parking"),
  zone_count: z.coerce.number().int().min(1).max(128).default(6),
  capacity: z.coerce.number().int().min(1).max(250000).default(500),
  sensor_count: z.coerce.number().int().min(0).max(512).default(12),
  active: z.boolean().default(false),
});

type ConnectParkingOccupancyBusArgs = z.infer<typeof connectParkingOccupancyBusSchema>;

function sourceNode(args: ConnectParkingOccupancyBusArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "websocket_json") {
    return {
      name: "parking_ws_adapter",
      optype: "websocketDAT",
      x: 0,
      y: 120,
      params: { url: args.adapter_url, active: args.active ? 1 : 0 },
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_parking_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Paste aggregate occupancy rows into zone_occupancy.",
    };
  }
  return {
    name: "parking_client",
    optype: "webclientDAT",
    x: 0,
    y: 120,
    params: { url: args.adapter_url, active: args.active ? 1 : 0 },
  };
}

function zoneRows(args: ConnectParkingOccupancyBusArgs): string[][] {
  const rows = [["zone", "lot_label", "occupied", "capacity", "status"]];
  const baseCapacity = Math.floor(args.capacity / args.zone_count);
  for (let index = 1; index <= args.zone_count; index += 1) {
    const zoneCapacity =
      index === args.zone_count
        ? args.capacity - baseCapacity * (args.zone_count - 1)
        : baseCapacity;
    rows.push([`zone_${index}`, args.lot_label, "0", String(zoneCapacity), "open"]);
  }
  return rows;
}

function sensorRows(args: ConnectParkingOccupancyBusArgs): string[][] {
  const rows = [["sensor", "zone", "kind"]];
  if (args.sensor_count === 0) {
    rows.push(["none", "none", "aggregate_only"]);
    return rows;
  }
  for (let index = 1; index <= args.sensor_count; index += 1) {
    rows.push([`sensor_${index}`, `zone_${((index - 1) % args.zone_count) + 1}`, args.provider]);
  }
  return rows;
}

export async function connectParkingOccupancyBusImpl(
  ctx: ToolContext,
  args: ConnectParkingOccupancyBusArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "parking_occupancy_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        provider: args.provider,
        lot_label: args.lot_label,
        adapter_mode: args.adapter_mode,
        adapter_url: args.adapter_url,
        zone_count: args.zone_count,
        capacity: args.capacity,
        sensor_count: args.sensor_count,
        active: args.active,
      },
      warnings: [
        "Camera inference, license plates, vendor tokens, and raw sensor events are intentionally external to this scaffold.",
        "Use aggregate occupancy and signage state only; keep individual vehicle data out of TouchDesigner.",
      ],
      nodes: [
        sourceNode(args),
        { name: "zone_occupancy", optype: "tableDAT", x: 300, y: 120, table: zoneRows(args) },
        { name: "sensor_map", optype: "tableDAT", x: 600, y: 120, table: sensorRows(args) },
        {
          name: "signage_policy",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["lot_label", args.lot_label],
            ["allowed_detail", "aggregate_zone_status"],
            ["capacity", String(args.capacity)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Run parking analytics in an adapter that strips plates and raw camera/sensor records. TouchDesigner consumes zone-level occupancy for dashboards and signage.",
        },
      ],
    },
    "connect_parking_occupancy_bus failed",
    (report) =>
      `Created parking occupancy bus ${report.container_path}; zones ${args.zone_count}; capacity ${args.capacity}.`,
  );
}

export const registerConnectParkingOccupancyBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_parking_occupancy_bus",
    {
      title: "Connect parking occupancy bus",
      description:
        "Create a parking/queue occupancy scaffold with zone occupancy, sensor maps, signage policy, adapter source, and privacy safety notes.",
      inputSchema: connectParkingOccupancyBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectParkingOccupancyBusImpl(ctx, args),
  );
};
