import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const connectCasparcgServerSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the CasparCG scaffold."),
  name: z.string().default("casparcg_server").describe("Generated baseCOMP name."),
  caspar_host: z.string().default("127.0.0.1"),
  amcp_port: z.coerce.number().int().min(1).max(65535).default(5250),
  channel_count: z.coerce.number().int().min(1).max(16).default(1),
  layer_count: z.coerce.number().int().min(1).max(64).default(4),
  media_root_hint: z.string().default("media/"),
  active: z.boolean().default(false),
});

type ConnectCasparcgServerArgs = z.infer<typeof connectCasparcgServerSchema>;

function commandRows(args: ConnectCasparcgServerArgs): string[][] {
  const rows = [["label", "amcp_command", "value_hint"]];
  for (let channel = 1; channel <= args.channel_count; channel += 1) {
    for (let layer = 1; layer <= args.layer_count; layer += 1) {
      rows.push([
        `channel ${channel} layer ${layer} loadbg`,
        `LOADBG ${channel}-${layer} {clip} MIX 12`,
        args.media_root_hint,
      ]);
      rows.push([`channel ${channel} layer ${layer} play`, `PLAY ${channel}-${layer}`, "pulse"]);
      rows.push([`channel ${channel} layer ${layer} stop`, `STOP ${channel}-${layer}`, "pulse"]);
      rows.push([`channel ${channel} layer ${layer} clear`, `CLEAR ${channel}-${layer}`, "pulse"]);
    }
  }
  return rows;
}

export async function connectCasparcgServerImpl(ctx: ToolContext, args: ConnectCasparcgServerArgs) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "casparcg_server",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        caspar_host: args.caspar_host,
        amcp_port: args.amcp_port,
        channel_count: args.channel_count,
        layer_count: args.layer_count,
        media_root_hint: args.media_root_hint,
        active: args.active,
      },
      warnings: [
        "This scaffold does not validate CasparCG server availability or media file existence.",
        "AMCP commands should be rehearsed against the target channel/layer layout before broadcast.",
      ],
      nodes: [
        {
          name: "tcp_client",
          optype: "tcpipDAT",
          x: 0,
          y: 120,
          params: {
            address: args.caspar_host,
            port: args.amcp_port,
            active: args.active ? 1 : 0,
          },
        },
        { name: "command_map", optype: "tableDAT", x: 300, y: 120, table: commandRows(args) },
        {
          name: "media_manifest",
          optype: "tableDAT",
          x: 600,
          y: 120,
          table: [
            ["clip", "path_hint", "validated"],
            ["example_clip", args.media_root_hint, "false"],
          ],
        },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["host", args.caspar_host],
            ["amcp_port", String(args.amcp_port)],
            ["channel_count", String(args.channel_count)],
            ["layer_count", String(args.layer_count)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use command_map as AMCP templates for CasparCG. Confirm channel/layer layout, media folder, and server version before sending commands on air.",
        },
      ],
    },
    "connect_casparcg_server failed",
    (report) =>
      `Created CasparCG server scaffold ${report.container_path}; AMCP ${args.caspar_host}:${args.amcp_port}; command map ${report.nodes?.command_map}.`,
  );
}

export const registerConnectCasparcgServer: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_casparcg_server",
    {
      title: "Connect CasparCG server",
      description:
        "Create a CasparCG AMCP/playout scaffold with channel/layer command templates and media manifest notes.",
      inputSchema: connectCasparcgServerSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectCasparcgServerImpl(ctx, args),
  );
};
