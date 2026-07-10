import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const connectUdpTelemetryBridgeSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP for the UDP telemetry scaffold."),
  name: z.string().default("udp_telemetry_bridge").describe("Generated baseCOMP name."),
  listen_port: z.coerce.number().int().min(1).max(65535).default(9000),
  remote_address: z.string().default("127.0.0.1"),
  remote_port: z.coerce.number().int().min(1).max(65535).default(9001),
  packet_count: z.coerce.number().int().min(1).max(128).default(8),
  active: z.boolean().default(false),
});

type ConnectUdpTelemetryBridgeArgs = z.infer<typeof connectUdpTelemetryBridgeSchema>;

function packetRows(args: ConnectUdpTelemetryBridgeArgs): string[][] {
  const rows = [["packet", "field", "channel_hint"]];
  for (let index = 0; index < args.packet_count; index += 1) {
    rows.push([`packet_${index + 1}`, `field_${index + 1}`, `udp_field_${index + 1}`]);
  }
  return rows;
}

function replyRows(args: ConnectUdpTelemetryBridgeArgs): string[][] {
  return [
    ["reply", "remote", "purpose"],
    ["ack", `${args.remote_address}:${args.remote_port}`, "heartbeat"],
    ["state", `${args.remote_address}:${args.remote_port}`, "operator-visible status"],
  ];
}

export async function connectUdpTelemetryBridgeImpl(
  ctx: ToolContext,
  args: ConnectUdpTelemetryBridgeArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "udp_telemetry_bridge",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        listen_port: args.listen_port,
        remote_address: args.remote_address,
        remote_port: args.remote_port,
        packet_count: args.packet_count,
        active: args.active,
      },
      warnings: [
        "UDP is unauthenticated and unordered; use trusted networks and sequence numbers for show-critical telemetry.",
        "Do not treat UDP replies as delivery guarantees; keep visual state tolerant of dropped packets.",
      ],
      nodes: [
        {
          name: "udp_in",
          optype: "udpinDAT",
          x: 0,
          y: 120,
          params: { active: args.active ? 1 : 0, port: args.listen_port },
        },
        {
          name: "udp_out",
          optype: "udpoutDAT",
          x: 0,
          y: -40,
          params: {
            active: args.active ? 1 : 0,
            netaddress: args.remote_address,
            port: args.remote_port,
          },
        },
        { name: "packet_map", optype: "tableDAT", x: 300, y: 120, table: packetRows(args) },
        { name: "reply_map", optype: "tableDAT", x: 600, y: 120, table: replyRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["listen_port", String(args.listen_port)],
            ["remote_address", args.remote_address],
            ["remote_port", String(args.remote_port)],
            ["packet_count", String(args.packet_count)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Parse udp_in packets through packet_map, expose only sanitized channels, and use udp_out replies for diagnostics rather than guaranteed control.",
        },
      ],
    },
    "connect_udp_telemetry_bridge failed",
    (report) =>
      `Created UDP telemetry bridge ${report.container_path}; listen ${args.listen_port}; remote ${args.remote_address}:${args.remote_port}.`,
  );
}

export const registerConnectUdpTelemetryBridge: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_udp_telemetry_bridge",
    {
      title: "Connect UDP telemetry bridge",
      description:
        "Create a UDP In/Out DAT scaffold for telemetry packets, replies, status maps, and diagnostics.",
      inputSchema: connectUdpTelemetryBridgeSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectUdpTelemetryBridgeImpl(ctx, args),
  );
};
