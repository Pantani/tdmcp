import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const createHokuyoLidarBusSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the Hokuyo scaffold."),
  name: z.string().default("hokuyo_lidar_bus").describe("Generated baseCOMP name."),
  interface_mode: z.enum(["network", "serial"]).default("network"),
  net_address: z.string().default("192.168.0.10"),
  serial_port: z.string().default("COM3"),
  scan_zones: z.coerce.number().int().min(1).max(128).default(8),
  start_step: z.coerce.number().int().min(0).max(4096).default(0),
  end_step: z.coerce.number().int().min(1).max(4096).default(1080),
  high_sensitivity: z.boolean().default(false),
  active: z.boolean().default(false),
});

type CreateHokuyoLidarBusArgs = z.infer<typeof createHokuyoLidarBusSchema>;

function zoneRows(args: CreateHokuyoLidarBusArgs): string[][] {
  const rows = [["zone", "start_norm", "end_norm", "channel_hint"]];
  for (let zone = 0; zone < args.scan_zones; zone += 1) {
    rows.push([
      String(zone + 1),
      (zone / args.scan_zones).toFixed(3),
      ((zone + 1) / args.scan_zones).toFixed(3),
      `presence_zone_${zone + 1}`,
    ]);
  }
  return rows;
}

export async function createHokuyoLidarBusImpl(ctx: ToolContext, args: CreateHokuyoLidarBusArgs) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "hokuyo_lidar_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        interface_mode: args.interface_mode,
        net_address: args.net_address,
        serial_port: args.serial_port,
        scan_zones: args.scan_zones,
        start_step: args.start_step,
        end_step: args.end_step,
        high_sensitivity: args.high_sensitivity,
        active: args.active,
      },
      warnings: [
        "Hokuyo scanner access is hardware-gated; verify network or serial permissions in TouchDesigner.",
        "Presence zones are a map scaffold only; tune thresholds against the real room before using them for show cues.",
      ],
      nodes: [
        {
          name: "hokuyo",
          optype: "hokuyoCHOP",
          x: 0,
          y: 120,
          params: {
            active: args.active ? 1 : 0,
            interface: args.interface_mode,
            netaddress: args.net_address,
            port: args.serial_port,
            startstep: args.start_step,
            endstep: args.end_step,
            highsensitivity: args.high_sensitivity ? 1 : 0,
          },
        },
        { name: "zone_map", optype: "tableDAT", x: 300, y: 120, table: zoneRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["interface_mode", args.interface_mode],
            ["net_address", args.net_address],
            ["serial_port", args.serial_port],
            ["scan_zones", String(args.scan_zones)],
            ["step_range", `${args.start_step}-${args.end_step}`],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: 120,
          text: "Use the Hokuyo CHOP output as a raw scanner bus, then derive smoothed occupancy channels from zone_map after live calibration.",
        },
      ],
    },
    "create_hokuyo_lidar_bus failed",
    (report) =>
      `Created Hokuyo LiDAR bus ${report.container_path}; zones ${args.scan_zones}; interface ${args.interface_mode}.`,
  );
}

export const registerCreateHokuyoLidarBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_hokuyo_lidar_bus",
    {
      title: "Create Hokuyo LiDAR bus",
      description:
        "Create a Hokuyo LiDAR scanner scaffold with hardware-gated CHOP setup, scan-zone maps, and calibration notes.",
      inputSchema: createHokuyoLidarBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createHokuyoLidarBusImpl(ctx, args),
  );
};
