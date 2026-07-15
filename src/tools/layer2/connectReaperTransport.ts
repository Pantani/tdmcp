import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const connectReaperTransportSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the REAPER scaffold."),
  name: z.string().default("reaper_transport").describe("Generated baseCOMP name."),
  reaper_host: z.string().default("127.0.0.1"),
  send_port: z.coerce.number().int().min(1).max(65535).default(8000),
  receive_port: z.coerce.number().int().min(1).max(65535).default(9000),
  project_name: z.string().default("show"),
  track_count: z.coerce.number().int().min(1).max(256).default(8),
  marker_count: z.coerce.number().int().min(0).max(512).default(8),
  include_record: z.boolean().default(false),
  active: z.boolean().default(false),
});

type ConnectReaperTransportArgs = z.infer<typeof connectReaperTransportSchema>;

function transportRows(args: ConnectReaperTransportArgs): string[][] {
  const rows = [["label", "address", "value_hint"]];
  rows.push(["play", "/play", "pulse"]);
  rows.push(["stop", "/stop", "pulse"]);
  rows.push(["pause", "/pause", "pulse"]);
  rows.push(["seek beats", "/time/str", "bars.beats"]);
  if (args.include_record) {
    rows.push(["record", "/record", "operator approved"]);
  }
  for (let marker = 1; marker <= args.marker_count; marker += 1) {
    rows.push([`marker ${marker}`, `/marker/${marker}`, "pulse"]);
  }
  return rows;
}

function trackRows(args: ConnectReaperTransportArgs): string[][] {
  const rows = [["track", "volume_address", "mute_address", "solo_address"]];
  for (let track = 1; track <= args.track_count; track += 1) {
    rows.push([
      `track_${track}`,
      `/track/${track}/volume`,
      `/track/${track}/mute`,
      `/track/${track}/solo`,
    ]);
  }
  return rows;
}

export async function connectReaperTransportImpl(
  ctx: ToolContext,
  args: ConnectReaperTransportArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "reaper_transport",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        reaper_host: args.reaper_host,
        send_port: args.send_port,
        receive_port: args.receive_port,
        project_name: args.project_name,
        track_count: args.track_count,
        marker_count: args.marker_count,
        include_record: args.include_record,
        active: args.active,
      },
      warnings: [
        "REAPER OSC must be configured manually; this scaffold does not validate REAPER live.",
        "Recording controls are templates and should remain operator-approved.",
      ],
      nodes: [
        {
          name: "osc_out",
          optype: "oscoutCHOP",
          x: 0,
          y: 120,
          params: {
            netaddress: args.reaper_host,
            port: args.send_port,
            active: args.active ? 1 : 0,
          },
        },
        {
          name: "osc_in",
          optype: "oscinCHOP",
          x: 0,
          y: -40,
          params: { port: args.receive_port, active: args.active ? 1 : 0 },
        },
        { name: "transport_map", optype: "tableDAT", x: 300, y: 120, table: transportRows(args) },
        { name: "track_map", optype: "tableDAT", x: 600, y: 120, table: trackRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["host", args.reaper_host],
            ["project_name", args.project_name],
            ["track_count", String(args.track_count)],
            ["marker_count", String(args.marker_count)],
            ["include_record", String(args.include_record)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Enable REAPER OSC control surface, align local/remote ports, then map transport_map and track_map to the configured pattern file.",
        },
      ],
    },
    "connect_reaper_transport failed",
    (report) =>
      `Created REAPER transport scaffold ${report.container_path}; tracks ${args.track_count}; markers ${args.marker_count}.`,
  );
}

export const registerConnectReaperTransport: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_reaper_transport",
    {
      title: "Connect REAPER transport",
      description:
        "Create a REAPER OSC transport, track, and marker bridge scaffold with operator-approved recording templates.",
      inputSchema: connectReaperTransportSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectReaperTransportImpl(ctx, args),
  );
};
