import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const createMocapStreamBridgeSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the mocap scaffold."),
  name: z.string().default("mocap_stream_bridge").describe("Generated baseCOMP name."),
  source_mode: z.enum(["osc", "websocket_json", "tcp_json", "vrpn", "sample"]).default("osc"),
  receive_port: z.coerce.number().int().min(1).max(65535).default(9002),
  server_url: z.string().default("ws://127.0.0.1:9002"),
  skeleton_count: z.coerce.number().int().min(0).max(32).default(1),
  rigid_body_count: z.coerce.number().int().min(0).max(128).default(0),
  coordinate_space: z.enum(["y_up", "z_up", "touchdesigner"]).default("touchdesigner"),
  active: z.boolean().default(false),
});

type CreateMocapStreamBridgeArgs = z.infer<typeof createMocapStreamBridgeSchema>;

function jointRows(args: CreateMocapStreamBridgeArgs): string[][] {
  const rows = [["source", "entity", "channels", "coordinate_space"]];
  for (let i = 1; i <= args.skeleton_count; i += 1) {
    rows.push([
      args.source_mode,
      `skeleton_${i}`,
      "tx ty tz rx ry rz confidence",
      args.coordinate_space,
    ]);
  }
  for (let i = 1; i <= args.rigid_body_count; i += 1) {
    rows.push([args.source_mode, `rigid_body_${i}`, "tx ty tz qx qy qz qw", args.coordinate_space]);
  }
  if (rows.length === 1) {
    rows.push([
      args.source_mode,
      "sample_body",
      "tx ty tz rx ry rz confidence",
      args.coordinate_space,
    ]);
  }
  return rows;
}

function sourceNode(args: CreateMocapStreamBridgeArgs): ExternalShowNodeSpec {
  if (args.source_mode === "osc") {
    return {
      name: "mocap_osc_in",
      optype: "oscinCHOP",
      x: 0,
      y: 120,
      params: { port: args.receive_port, active: args.active ? 1 : 0 },
    };
  }
  if (args.source_mode === "websocket_json") {
    return {
      name: "mocap_websocket_in",
      optype: "websocketDAT",
      x: 0,
      y: 120,
      params: { url: args.server_url, active: args.active ? 1 : 0 },
    };
  }
  return {
    name: "mocap_source_notes",
    optype: "textDAT",
    x: 0,
    y: 120,
    text: `${args.source_mode} source selected. Use an external adapter to write mocap frames into rigid_body_table or joint_channels.`,
  };
}

export async function createMocapStreamBridgeImpl(
  ctx: ToolContext,
  args: CreateMocapStreamBridgeArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "mocap_stream_bridge",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        source_mode: args.source_mode,
        receive_port: args.receive_port,
        server_url: args.server_url,
        skeleton_count: args.skeleton_count,
        rigid_body_count: args.rigid_body_count,
        coordinate_space: args.coordinate_space,
        active: args.active,
      },
      warnings: [
        "Live OptiTrack/Rokoko/Axis Studio/VRPN SDK validation is not performed by this scaffold.",
        "Coordinate handedness and unit scale must be confirmed against the mocap source before show use.",
      ],
      nodes: [
        sourceNode(args),
        { name: "joint_channels", optype: "nullCHOP", x: 300, y: 120 },
        { name: "rigid_body_table", optype: "tableDAT", x: 300, y: -40, table: jointRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 600,
          y: 120,
          table: [
            ["field", "value"],
            ["source_mode", args.source_mode],
            ["coordinate_space", args.coordinate_space],
            ["skeleton_count", String(args.skeleton_count)],
            ["rigid_body_count", String(args.rigid_body_count)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Normalize live mocap into joint_channels and rigid_body_table. Use one stable row/channel naming convention before binding visuals.",
        },
      ],
    },
    "create_mocap_stream_bridge failed",
    (report) =>
      `Created mocap stream bridge ${report.container_path}; source ${args.source_mode}; skeletons ${args.skeleton_count}; rigid bodies ${args.rigid_body_count}.`,
  );
}

export const registerCreateMocapStreamBridge: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_mocap_stream_bridge",
    {
      title: "Create mocap stream bridge",
      description:
        "Create a generic OptiTrack/Rokoko/Axis Studio/VRPN-style mocap bus scaffold with joint and rigid-body mapping surfaces.",
      inputSchema: createMocapStreamBridgeSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createMocapStreamBridgeImpl(ctx, args),
  );
};
