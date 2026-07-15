import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectXsensMvnMocapSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the Xsens scaffold."),
  name: z.string().default("xsens_mvn_mocap").describe("Generated baseCOMP name."),
  source_mode: z.enum(["mvn_osc", "mvn_udp_json", "mvn_tcp_json", "sample"]).default("mvn_osc"),
  receive_port: z.coerce.number().int().min(1).max(65535).default(9763),
  server_host: z.string().default("127.0.0.1"),
  actor_count: z.coerce.number().int().min(1).max(32).default(1),
  segment_count: z.coerce.number().int().min(1).max(128).default(23),
  coordinate_space: z.enum(["mvn_y_up", "z_up", "touchdesigner"]).default("mvn_y_up"),
  active: z.boolean().default(false),
});

type ConnectXsensMvnMocapArgs = z.infer<typeof connectXsensMvnMocapSchema>;

function sourceNode(args: ConnectXsensMvnMocapArgs): ExternalShowNodeSpec {
  if (args.source_mode === "mvn_udp_json") {
    return {
      name: "xsens_udp",
      optype: "udpinDAT",
      x: 0,
      y: 120,
      params: { port: args.receive_port, active: args.active ? 1 : 0 },
    };
  }
  if (args.source_mode === "mvn_tcp_json") {
    return {
      name: "xsens_tcp",
      optype: "tcpipDAT",
      x: 0,
      y: 120,
      params: {
        netaddress: args.server_host,
        port: args.receive_port,
        active: args.active ? 1 : 0,
      },
    };
  }
  if (args.source_mode === "sample") {
    return {
      name: "sample_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Sample mode selected. Fill segment_map with recorded MVN labels before binding channels.",
    };
  }
  return {
    name: "xsens_osc",
    optype: "oscinDAT",
    x: 0,
    y: 120,
    params: { port: args.receive_port, active: args.active ? 1 : 0 },
  };
}

function segmentRows(args: ConnectXsensMvnMocapArgs): string[][] {
  const rows = [["actor", "segment", "channels", "coordinate_space"]];
  for (let actor = 1; actor <= args.actor_count; actor += 1) {
    for (let segment = 1; segment <= args.segment_count; segment += 1) {
      rows.push([
        `actor_${actor}`,
        `segment_${segment}`,
        "tx ty tz qx qy qz qw confidence",
        args.coordinate_space,
      ]);
    }
  }
  return rows;
}

export async function connectXsensMvnMocapImpl(ctx: ToolContext, args: ConnectXsensMvnMocapArgs) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "xsens_mvn_mocap",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        source_mode: args.source_mode,
        receive_port: args.receive_port,
        server_host: args.server_host,
        actor_count: args.actor_count,
        segment_count: args.segment_count,
        coordinate_space: args.coordinate_space,
        active: args.active,
      },
      warnings: [
        "Xsens MVN stream configuration and suit calibration are not validated by this scaffold.",
        "Coordinate handedness, body scale, and actor IDs must be confirmed before driving visuals or physical systems.",
      ],
      nodes: [
        sourceNode(args),
        { name: "segment_map", optype: "tableDAT", x: 300, y: 120, table: segmentRows(args) },
        {
          name: "normalized_skeleton",
          optype: "tableDAT",
          x: 600,
          y: 120,
          table: [
            ["field", "value"],
            ["actors", String(args.actor_count)],
            ["segments_per_actor", String(args.segment_count)],
            ["coordinate_space", args.coordinate_space],
          ],
        },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["source_mode", args.source_mode],
            ["receive_port", String(args.receive_port)],
            ["server_host", args.server_host],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Parse MVN frames into segment_map with stable actor/segment naming. Normalize units and handedness before binding skeleton-driven visuals.",
        },
      ],
    },
    "connect_xsens_mvn_mocap failed",
    (report) =>
      `Created Xsens MVN mocap scaffold ${report.container_path}; actors ${args.actor_count}; segments ${args.segment_count}.`,
  );
}

export const registerConnectXsensMvnMocap: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_xsens_mvn_mocap",
    {
      title: "Connect Xsens MVN mocap",
      description:
        "Create an Xsens MVN mocap scaffold with OSC/UDP/TCP ingest, actor/segment mapping, normalized skeleton tables, and coordinate-space notes.",
      inputSchema: connectXsensMvnMocapSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectXsensMvnMocapImpl(ctx, args),
  );
};
