import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectAisVesselBusSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the AIS scaffold."),
  name: z.string().default("ais_vessel_bus").describe("Generated baseCOMP name."),
  provider: z
    .enum(["ais_receiver", "marine_traffic_adapter", "aishub_adapter", "custom"])
    .default("ais_receiver"),
  waterway_label: z.string().default("harbor"),
  adapter_mode: z.enum(["rest_json", "websocket_json", "manual"]).default("websocket_json"),
  adapter_url: z.string().default("ws://127.0.0.1:9075/ais"),
  vessel_count: z.coerce.number().int().min(1).max(5000).default(24),
  zone_count: z.coerce.number().int().min(1).max(128).default(4),
  route_count: z.coerce.number().int().min(0).max(256).default(6),
  active: z.boolean().default(false),
});

type ConnectAisVesselBusArgs = z.infer<typeof connectAisVesselBusSchema>;

function sourceNode(args: ConnectAisVesselBusArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "rest_json") {
    return {
      name: "ais_client",
      optype: "webclientDAT",
      x: 0,
      y: 120,
      params: { url: args.adapter_url, active: args.active ? 1 : 0 },
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_ais_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Paste sanitized vessel rows into vessel_map.",
    };
  }
  return {
    name: "ais_ws_adapter",
    optype: "websocketDAT",
    x: 0,
    y: 120,
    params: { url: args.adapter_url, active: args.active ? 1 : 0 },
  };
}

function vesselRows(args: ConnectAisVesselBusArgs): string[][] {
  const rows = [["vessel", "waterway", "lat", "lng", "zone"]];
  for (let index = 1; index <= args.vessel_count; index += 1) {
    rows.push([
      `vessel_${index}`,
      args.waterway_label,
      "0",
      "0",
      `zone_${((index - 1) % args.zone_count) + 1}`,
    ]);
  }
  return rows;
}

function zoneRows(args: ConnectAisVesselBusArgs): string[][] {
  const rows = [["zone", "waterway", "policy"]];
  for (let index = 1; index <= args.zone_count; index += 1) {
    rows.push([`zone_${index}`, args.waterway_label, "sanitized_vessel_state"]);
  }
  return rows;
}

function routeRows(args: ConnectAisVesselBusArgs): string[][] {
  const rows = [["route", "waterway", "status"]];
  if (args.route_count === 0) {
    rows.push(["none", args.waterway_label, "zones_only"]);
    return rows;
  }
  for (let index = 1; index <= args.route_count; index += 1) {
    rows.push([`route_${index}`, args.waterway_label, "inferred_by_adapter"]);
  }
  return rows;
}

export async function connectAisVesselBusImpl(ctx: ToolContext, args: ConnectAisVesselBusArgs) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "ais_vessel_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        provider: args.provider,
        waterway_label: args.waterway_label,
        adapter_mode: args.adapter_mode,
        adapter_url: args.adapter_url,
        vessel_count: args.vessel_count,
        zone_count: args.zone_count,
        route_count: args.route_count,
        active: args.active,
      },
      warnings: [
        "AIS receiver auth, raw MMSI handling, vessel filtering, and route inference are intentionally external to this scaffold.",
        "Use sanitized vessel rows and obey provider/feed terms before public display.",
      ],
      nodes: [
        sourceNode(args),
        { name: "vessel_map", optype: "tableDAT", x: 300, y: 120, table: vesselRows(args) },
        { name: "zone_map", optype: "tableDAT", x: 600, y: 120, table: zoneRows(args) },
        { name: "route_hints", optype: "tableDAT", x: 300, y: -40, table: routeRows(args) },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Normalize and sanitize AIS vessel feeds in an adapter. TouchDesigner consumes vessel_map, zone_map, and optional route_hints rows.",
        },
      ],
    },
    "connect_ais_vessel_bus failed",
    (report) =>
      `Created AIS vessel bus ${report.container_path}; vessels ${args.vessel_count}; waterway ${args.waterway_label}.`,
  );
}

export const registerConnectAisVesselBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_ais_vessel_bus",
    {
      title: "Connect AIS vessel bus",
      description:
        "Create an AIS vessel scaffold with sanitized vessel rows, zone maps, route hints, adapter source, and receiver/privacy notes.",
      inputSchema: connectAisVesselBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectAisVesselBusImpl(ctx, args),
  );
};
