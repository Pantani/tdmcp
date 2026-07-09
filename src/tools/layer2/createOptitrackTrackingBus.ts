import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const createOptitrackTrackingBusSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the OptiTrack scaffold."),
  name: z.string().default("optitrack_tracking_bus").describe("Generated baseCOMP name."),
  server_address: z.string().default("127.0.0.1"),
  command_port: z.coerce.number().int().min(1).max(65535).default(1510),
  data_port: z.coerce.number().int().min(1).max(65535).default(1511),
  rigid_body_count: z.coerce.number().int().min(1).max(128).default(4),
  marker_count: z.coerce.number().int().min(0).max(512).default(16),
  active: z.boolean().default(false),
});

type CreateOptitrackTrackingBusArgs = z.infer<typeof createOptitrackTrackingBusSchema>;

function rigidBodyRows(args: CreateOptitrackTrackingBusArgs): string[][] {
  const rows = [["rigid_body", "channel_prefix", "role"]];
  for (let index = 0; index < args.rigid_body_count; index += 1) {
    rows.push([`body_${index + 1}`, `optitrack_body${index + 1}_`, index === 0 ? "hero" : "prop"]);
  }
  return rows;
}

function markerRows(args: CreateOptitrackTrackingBusArgs): string[][] {
  const rows = [["marker", "channel_prefix", "use"]];
  for (let index = 0; index < args.marker_count; index += 1) {
    rows.push([
      `marker_${index + 1}`,
      `marker${index + 1}_`,
      index < 4 ? "calibration" : "tracking",
    ]);
  }
  return rows;
}

export async function createOptitrackTrackingBusImpl(
  ctx: ToolContext,
  args: CreateOptitrackTrackingBusArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "optitrack_tracking_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        server_address: args.server_address,
        command_port: args.command_port,
        data_port: args.data_port,
        rigid_body_count: args.rigid_body_count,
        marker_count: args.marker_count,
        active: args.active,
      },
      warnings: [
        "OptiTrack In CHOP is Windows-only and depends on a reachable Motive/NatNet server.",
        "Verify coordinate origin, units, skeleton IDs, and latency before binding mocap to show cues.",
      ],
      nodes: [
        {
          name: "optitrack_in",
          optype: "optitrackinCHOP",
          x: 0,
          y: 120,
          params: {
            active: args.active ? 1 : 0,
            serveraddress: args.server_address,
            commandport: args.command_port,
            dataport: args.data_port,
          },
        },
        {
          name: "rigid_body_map",
          optype: "tableDAT",
          x: 300,
          y: 120,
          table: rigidBodyRows(args),
        },
        { name: "marker_map", optype: "tableDAT", x: 600, y: 120, table: markerRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["server_address", args.server_address],
            ["command_port", String(args.command_port)],
            ["data_port", String(args.data_port)],
            ["rigid_body_count", String(args.rigid_body_count)],
            ["marker_count", String(args.marker_count)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Connect Motive/NatNet to optitrack_in, confirm body IDs and marker stability, then normalize rigid_body_map before using tracking as show control.",
        },
      ],
    },
    "create_optitrack_tracking_bus failed",
    (report) =>
      `Created OptiTrack tracking bus ${report.container_path}; rigid bodies ${args.rigid_body_count}; server ${args.server_address}.`,
  );
}

export const registerCreateOptitrackTrackingBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_optitrack_tracking_bus",
    {
      title: "Create OptiTrack tracking bus",
      description:
        "Create an OptiTrack/NatNet tracking scaffold with receiver, rigid-body maps, marker maps, and calibration notes.",
      inputSchema: createOptitrackTrackingBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createOptitrackTrackingBusImpl(ctx, args),
  );
};
