import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const createBlacktraxTrackingBusSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the BlackTrax scaffold."),
  name: z.string().default("blacktrax_tracking_bus").describe("Generated baseCOMP name."),
  port: z.coerce.number().int().min(1).max(65535).default(24002),
  trackable_count: z.coerce.number().int().min(1).max(128).default(8),
  zone_count: z.coerce.number().int().min(1).max(64).default(4),
  active: z.boolean().default(false),
});

type CreateBlacktraxTrackingBusArgs = z.infer<typeof createBlacktraxTrackingBusSchema>;

function trackableRows(args: CreateBlacktraxTrackingBusArgs): string[][] {
  const rows = [["trackable", "channel_prefix", "role"]];
  for (let index = 0; index < args.trackable_count; index += 1) {
    rows.push([String(index + 1), `bt_${index + 1}_`, index === 0 ? "hero" : "tracked_object"]);
  }
  return rows;
}

function zoneRows(args: CreateBlacktraxTrackingBusArgs): string[][] {
  const rows = [["zone", "bounds_hint", "default_action"]];
  for (let index = 0; index < args.zone_count; index += 1) {
    rows.push([`zone_${index + 1}`, "stage_xyz", index === 0 ? "calibrate" : "map_to_cue"]);
  }
  return rows;
}

export async function createBlacktraxTrackingBusImpl(
  ctx: ToolContext,
  args: CreateBlacktraxTrackingBusArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "blacktrax_tracking_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        port: args.port,
        trackable_count: args.trackable_count,
        zone_count: args.zone_count,
        active: args.active,
      },
      warnings: [
        "BlackTrax CHOP requires TouchDesigner Pro and a live calibrated BlackTrax system.",
        "Do not bind tracking channels to show-critical cues until stage coordinates and latency are verified live.",
      ],
      nodes: [
        {
          name: "blacktrax_in",
          optype: "blacktraxCHOP",
          x: 0,
          y: 120,
          params: { active: args.active ? 1 : 0, port: args.port },
        },
        {
          name: "trackable_map",
          optype: "tableDAT",
          x: 300,
          y: 120,
          table: trackableRows(args),
        },
        { name: "zone_map", optype: "tableDAT", x: 600, y: 120, table: zoneRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["port", String(args.port)],
            ["trackable_count", String(args.trackable_count)],
            ["zone_count", String(args.zone_count)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Connect BlackTrax on the configured UDP port, confirm rigid-body IDs, then normalize trackable_map and zone_map before binding cues.",
        },
      ],
    },
    "create_blacktrax_tracking_bus failed",
    (report) =>
      `Created BlackTrax tracking bus ${report.container_path}; trackables ${args.trackable_count}; port ${args.port}.`,
  );
}

export const registerCreateBlacktraxTrackingBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_blacktrax_tracking_bus",
    {
      title: "Create BlackTrax tracking bus",
      description:
        "Create a BlackTrax tracking scaffold with receiver, trackable maps, zone maps, and calibration notes.",
      inputSchema: createBlacktraxTrackingBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createBlacktraxTrackingBusImpl(ctx, args),
  );
};
