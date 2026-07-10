import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectGtfsTransitFeedSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the GTFS scaffold."),
  name: z.string().default("gtfs_transit_feed").describe("Generated baseCOMP name."),
  agency_label: z.string().default("local_transit"),
  feed_mode: z.enum(["gtfs_realtime", "static_gtfs_snapshot", "manual"]).default("gtfs_realtime"),
  adapter_url: z.string().default("http://127.0.0.1:9070/gtfs"),
  route_count: z.coerce.number().int().min(1).max(512).default(8),
  stop_count: z.coerce.number().int().min(1).max(2048).default(12),
  prediction_count: z.coerce.number().int().min(1).max(1024).default(16),
  active: z.boolean().default(false),
});

type ConnectGtfsTransitFeedArgs = z.infer<typeof connectGtfsTransitFeedSchema>;

function sourceNode(args: ConnectGtfsTransitFeedArgs): ExternalShowNodeSpec {
  if (args.feed_mode === "manual") {
    return {
      name: "manual_gtfs_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Paste normalized route, stop, and arrival rows into the tables.",
    };
  }
  return {
    name: args.feed_mode === "gtfs_realtime" ? "gtfs_realtime_client" : "gtfs_static_client",
    optype: "webclientDAT",
    x: 0,
    y: 120,
    params: { url: args.adapter_url, active: args.active ? 1 : 0 },
  };
}

function routeRows(args: ConnectGtfsTransitFeedArgs): string[][] {
  const rows = [["route_id", "agency", "label", "kind"]];
  for (let index = 1; index <= args.route_count; index += 1) {
    rows.push([`route_${index}`, args.agency_label, `Route ${index}`, index % 2 ? "bus" : "rail"]);
  }
  return rows;
}

function stopRows(args: ConnectGtfsTransitFeedArgs): string[][] {
  const rows = [["stop_id", "route_hint", "display_name"]];
  for (let index = 1; index <= args.stop_count; index += 1) {
    rows.push([`stop_${index}`, `route_${((index - 1) % args.route_count) + 1}`, `Stop ${index}`]);
  }
  return rows;
}

function predictionRows(args: ConnectGtfsTransitFeedArgs): string[][] {
  const rows = [["prediction", "stop_id", "route_id", "eta_min"]];
  for (let index = 1; index <= args.prediction_count; index += 1) {
    rows.push([
      `arrival_${index}`,
      `stop_${((index - 1) % args.stop_count) + 1}`,
      `route_${((index - 1) % args.route_count) + 1}`,
      String(index * 3),
    ]);
  }
  return rows;
}

export async function connectGtfsTransitFeedImpl(
  ctx: ToolContext,
  args: ConnectGtfsTransitFeedArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "gtfs_transit_feed",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        agency_label: args.agency_label,
        feed_mode: args.feed_mode,
        adapter_url: args.adapter_url,
        route_count: args.route_count,
        stop_count: args.stop_count,
        prediction_count: args.prediction_count,
        active: args.active,
      },
      warnings: [
        "GTFS-Realtime protobuf decoding, static-feed joins, feed credentials, and service-alert normalization are intentionally external to this scaffold.",
        "Arrival rows should be treated as advisory public information, not as a control source.",
      ],
      nodes: [
        sourceNode(args),
        { name: "route_map", optype: "tableDAT", x: 300, y: 120, table: routeRows(args) },
        { name: "stop_map", optype: "tableDAT", x: 600, y: 120, table: stopRows(args) },
        {
          name: "arrival_predictions",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: predictionRows(args),
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use an adapter to decode GTFS-Realtime, join static routes/stops, and normalize service alerts. TouchDesigner consumes arrival rows for lobby displays or reactive visuals.",
        },
      ],
    },
    "connect_gtfs_transit_feed failed",
    (report) =>
      `Created GTFS transit feed ${report.container_path}; routes ${args.route_count}; stops ${args.stop_count}.`,
  );
}

export const registerConnectGtfsTransitFeed: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_gtfs_transit_feed",
    {
      title: "Connect GTFS transit feed",
      description:
        "Create a GTFS static/realtime transit scaffold with route maps, stop maps, arrival predictions, adapter source, and public-data notes.",
      inputSchema: connectGtfsTransitFeedSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectGtfsTransitFeedImpl(ctx, args),
  );
};
