import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const createLivoxLidarBusSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the Livox scaffold."),
  name: z.string().default("livox_lidar_bus").describe("Generated baseCOMP name."),
  adapter_mode: z.enum(["udp_json", "websocket_json", "file_replay"]).default("udp_json"),
  device_address: z.string().default("192.168.1.50").describe("Livox device or adapter host."),
  receive_port: z.coerce.number().int().min(1).max(65535).default(56000),
  server_url: z.string().default("ws://127.0.0.1:56000"),
  point_rate_hint: z.coerce.number().int().min(1).max(10000000).default(240000),
  zone_count: z.coerce.number().int().min(1).max(64).default(8),
  active: z.boolean().default(false),
});

type CreateLivoxLidarBusArgs = z.infer<typeof createLivoxLidarBusSchema>;

function sourceNode(args: CreateLivoxLidarBusArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "websocket_json") {
    return {
      name: "livox_ws",
      optype: "websocketDAT",
      x: 0,
      y: 120,
      params: { url: args.server_url, active: args.active ? 1 : 0 },
    };
  }
  if (args.adapter_mode === "file_replay") {
    return {
      name: "replay_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "File replay selected. Point frames should be replayed by an external adapter into point_stream.",
    };
  }
  return {
    name: "livox_udp",
    optype: "udpinDAT",
    x: 0,
    y: 120,
    params: { port: args.receive_port, active: args.active ? 1 : 0 },
  };
}

function zoneRows(args: CreateLivoxLidarBusArgs): string[][] {
  const rows = [["zone", "bounds_hint", "output_channel"]];
  for (let index = 1; index <= args.zone_count; index += 1) {
    rows.push([`zone_${index}`, "x_min x_max y_min y_max z_min z_max", `livox_zone_${index}`]);
  }
  return rows;
}

function streamRows(args: CreateLivoxLidarBusArgs): string[][] {
  return [
    ["field", "value"],
    ["adapter_mode", args.adapter_mode],
    ["device_address", args.device_address],
    ["receive_port", String(args.receive_port)],
    ["server_url", args.server_url],
    ["point_rate_hint", String(args.point_rate_hint)],
    ["active", String(args.active)],
  ];
}

export async function createLivoxLidarBusImpl(ctx: ToolContext, args: CreateLivoxLidarBusArgs) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "livox_lidar_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        adapter_mode: args.adapter_mode,
        device_address: args.device_address,
        receive_port: args.receive_port,
        server_url: args.server_url,
        point_rate_hint: args.point_rate_hint,
        zone_count: args.zone_count,
        active: args.active,
      },
      warnings: [
        "Livox SDK/device discovery is not performed by this scaffold; use an external adapter for normalized point frames.",
        "Audience interaction zones and sensor orientation must be calibrated live before triggering show systems.",
      ],
      nodes: [
        sourceNode(args),
        { name: "point_stream", optype: "tableDAT", x: 300, y: 120, table: streamRows(args) },
        { name: "zone_map", optype: "tableDAT", x: 600, y: 120, table: zoneRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["device_address", args.device_address],
            ["zone_count", String(args.zone_count)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Normalize Livox point packets into point_stream rows before zone_map processing. Keep exclusion zones conservative until the venue scan is verified.",
        },
      ],
    },
    "create_livox_lidar_bus failed",
    (report) =>
      `Created Livox LiDAR bus ${report.container_path}; mode ${args.adapter_mode}; zones ${args.zone_count}.`,
  );
}

export const registerCreateLivoxLidarBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_livox_lidar_bus",
    {
      title: "Create Livox LiDAR bus",
      description:
        "Create a Livox LiDAR adapter scaffold with UDP/WebSocket/file-replay ingest, point-stream schema, zone maps, and calibration notes.",
      inputSchema: createLivoxLidarBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createLivoxLidarBusImpl(ctx, args),
  );
};
