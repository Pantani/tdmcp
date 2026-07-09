import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const connectMadmapperSurfaceSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the MadMapper scaffold."),
  name: z.string().default("madmapper_surface").describe("Generated baseCOMP name."),
  madmapper_host: z.string().default("127.0.0.1").describe("MadMapper OSC host."),
  send_port: z.coerce.number().int().min(1).max(65535).default(8010),
  receive_port: z.coerce.number().int().min(1).max(65535).default(8011),
  surface_count: z.coerce.number().int().min(1).max(64).default(4),
  media_count: z.coerce.number().int().min(1).max(64).default(4),
  source_top_path: z
    .string()
    .optional()
    .describe("Optional TD TOP intended for projection handoff."),
  handoff_mode: z.enum(["none", "syphon_spout", "ndi"]).default("syphon_spout"),
  active: z.boolean().default(false),
});

type ConnectMadmapperSurfaceArgs = z.infer<typeof connectMadmapperSurfaceSchema>;

function surfaceRows(args: ConnectMadmapperSurfaceArgs): string[][] {
  const rows = [["label", "address", "value_hint"]];
  for (let surface = 1; surface <= args.surface_count; surface += 1) {
    rows.push([`surface ${surface} opacity`, `/surfaces/${surface}/opacity`, "0..1"]);
    rows.push([`surface ${surface} visible`, `/surfaces/${surface}/visible`, "0/1"]);
  }
  for (let media = 1; media <= args.media_count; media += 1) {
    rows.push([`media ${media} play`, `/medias/${media}/play`, "pulse"]);
    rows.push([`media ${media} speed`, `/medias/${media}/speed`, "0..2"]);
  }
  return rows;
}

export async function connectMadmapperSurfaceImpl(
  ctx: ToolContext,
  args: ConnectMadmapperSurfaceArgs,
) {
  const sourceNote = args.source_top_path
    ? `Source TOP ${args.source_top_path}; publish manually via ${args.handoff_mode}.`
    : "No source_top_path provided; use this scaffold for OSC control only.";

  return runExternalShowScaffold(
    ctx,
    {
      kind: "madmapper_surface",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        madmapper_host: args.madmapper_host,
        send_port: args.send_port,
        receive_port: args.receive_port,
        surface_count: args.surface_count,
        media_count: args.media_count,
        source_top_path: args.source_top_path ?? null,
        handoff_mode: args.handoff_mode,
        active: args.active,
      },
      warnings: [
        "MadMapper OSC address sets vary by project/version; validate against your live OSC module.",
        "Syphon/Spout/NDI publishing is documented here but not live-validated by this scaffold.",
      ],
      nodes: [
        {
          name: "osc_out",
          optype: "oscoutCHOP",
          x: 0,
          y: 120,
          params: {
            netaddress: args.madmapper_host,
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
        { name: "surface_map", optype: "tableDAT", x: 300, y: 120, table: surfaceRows(args) },
        {
          name: "source_handoff",
          optype: "textDAT",
          x: 600,
          y: 120,
          text: `${sourceNote}\nMadMapper commonly receives Syphon/Spout on desktop hosts; confirm the exact input route in the target machine.`,
        },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["host", args.madmapper_host],
            ["send_port", String(args.send_port)],
            ["receive_port", String(args.receive_port)],
            ["handoff_mode", args.handoff_mode],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Enable OSC Control in MadMapper and map the generated addresses to surfaces/media. Keep projection output disabled until the projector path is verified.",
        },
      ],
    },
    "connect_madmapper_surface failed",
    (report) =>
      `Created MadMapper OSC scaffold ${report.container_path}; surface map ${report.nodes?.surface_map}; handoff ${args.handoff_mode}.`,
  );
}

export const registerConnectMadmapperSurface: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_madmapper_surface",
    {
      title: "Connect MadMapper surface",
      description:
        "Create a MadMapper OSC surface/media control scaffold with source handoff notes for Syphon/Spout or NDI.",
      inputSchema: connectMadmapperSurfaceSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectMadmapperSurfaceImpl(ctx, args),
  );
};
