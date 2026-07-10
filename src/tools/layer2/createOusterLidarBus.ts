import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const createOusterLidarBusSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP for the Ouster LiDAR scaffold."),
  name: z.string().default("ouster_lidar_bus").describe("Generated baseCOMP name."),
  device_address: z.string().default("192.168.1.1"),
  lidar_port: z.coerce.number().int().min(1).max(65535).default(7502),
  imu_port: z.coerce.number().int().min(1).max(65535).default(7503),
  ring_count: z.coerce.number().int().min(16).max(128).default(64),
  zone_count: z.coerce.number().int().min(1).max(64).default(6),
  active: z.boolean().default(false),
});

type CreateOusterLidarBusArgs = z.infer<typeof createOusterLidarBusSchema>;

function rangeRows(args: CreateOusterLidarBusArgs): string[][] {
  const rows = [["range", "ring_span", "purpose"]];
  const segmentSize = Math.max(1, Math.floor(args.ring_count / 4));
  for (let index = 0; index < 4; index += 1) {
    const start = index * segmentSize;
    const end =
      index === 3 ? args.ring_count - 1 : Math.min(args.ring_count - 1, start + segmentSize - 1);
    rows.push([`band_${index + 1}`, `${start}-${end}`, index === 0 ? "floor" : "volume"]);
  }
  return rows;
}

function zoneRows(args: CreateOusterLidarBusArgs): string[][] {
  const rows = [["zone", "bounds_hint", "output_channel"]];
  for (let index = 0; index < args.zone_count; index += 1) {
    rows.push([`zone_${index + 1}`, "x/y/z/min/max", `lidar_zone_${index + 1}`]);
  }
  return rows;
}

export async function createOusterLidarBusImpl(ctx: ToolContext, args: CreateOusterLidarBusArgs) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "ouster_lidar_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        device_address: args.device_address,
        lidar_port: args.lidar_port,
        imu_port: args.imu_port,
        ring_count: args.ring_count,
        zone_count: args.zone_count,
        active: args.active,
      },
      warnings: [
        "Ouster TOP requires a compatible TouchDesigner build and reachable sensor network configuration.",
        "Verify sensor orientation, floor plane, and exclusion zones live before using LiDAR data for audience interaction.",
      ],
      nodes: [
        {
          name: "ouster_top",
          optype: "ousterTOP",
          x: 0,
          y: 120,
          params: {
            active: args.active ? 1 : 0,
            deviceaddress: args.device_address,
            lidarport: args.lidar_port,
            imuport: args.imu_port,
          },
        },
        { name: "range_select", optype: "ousterselectTOP", x: 300, y: 120 },
        { name: "lidar_out", optype: "nullTOP", x: 600, y: 120 },
        { name: "range_map", optype: "tableDAT", x: 300, y: -40, table: rangeRows(args) },
        { name: "zone_map", optype: "tableDAT", x: 600, y: -40, table: zoneRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -200,
          table: [
            ["field", "value"],
            ["device_address", args.device_address],
            ["lidar_port", String(args.lidar_port)],
            ["imu_port", String(args.imu_port)],
            ["ring_count", String(args.ring_count)],
            ["zone_count", String(args.zone_count)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -200,
          text: "Patch range_select and range_map into downstream LiDAR zoning only after live sensor orientation, network ports, and exclusion zones are verified.",
        },
      ],
      connections: [
        { from: "ouster_top", to: "range_select" },
        { from: "range_select", to: "lidar_out" },
      ],
    },
    "create_ouster_lidar_bus failed",
    (report) =>
      `Created Ouster LiDAR bus ${report.container_path}; device ${args.device_address}; zones ${args.zone_count}.`,
  );
}

export const registerCreateOusterLidarBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_ouster_lidar_bus",
    {
      title: "Create Ouster LiDAR bus",
      description:
        "Create an Ouster LiDAR scaffold with Ouster TOP, range selection, zone maps, and calibration notes.",
      inputSchema: createOusterLidarBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createOusterLidarBusImpl(ctx, args),
  );
};
