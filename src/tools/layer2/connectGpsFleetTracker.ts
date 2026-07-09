import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectGpsFleetTrackerSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the GPS scaffold."),
  name: z.string().default("gps_fleet_tracker").describe("Generated baseCOMP name."),
  provider: z.enum(["traccar", "owntracks", "mqtt_gps", "custom"]).default("traccar"),
  fleet_label: z.string().default("venue_fleet"),
  adapter_mode: z.enum(["websocket_json", "mqtt_json", "manual"]).default("websocket_json"),
  adapter_url: z.string().default("ws://127.0.0.1:9073/gps"),
  tracked_asset_count: z.coerce.number().int().min(1).max(2048).default(12),
  geofence_count: z.coerce.number().int().min(0).max(256).default(4),
  update_rate_hz: z.coerce.number().min(0.01).max(120).default(1),
  active: z.boolean().default(false),
});

type ConnectGpsFleetTrackerArgs = z.infer<typeof connectGpsFleetTrackerSchema>;

function sourceNode(args: ConnectGpsFleetTrackerArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "mqtt_json") {
    return {
      name: "gps_mqtt_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "MQTT mode selected. Use an adapter to authenticate, decode, and sanitize GPS messages before writing asset_positions.",
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_gps_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Paste sanitized asset positions into asset_positions.",
    };
  }
  return {
    name: "gps_ws_adapter",
    optype: "websocketDAT",
    x: 0,
    y: 120,
    params: { url: args.adapter_url, active: args.active ? 1 : 0 },
  };
}

function assetRows(args: ConnectGpsFleetTrackerArgs): string[][] {
  const rows = [["asset", "fleet", "lat", "lng", "state"]];
  for (let index = 1; index <= args.tracked_asset_count; index += 1) {
    rows.push([`asset_${index}`, args.fleet_label, "0", "0", index === 1 ? "lead" : "tracked"]);
  }
  return rows;
}

function geofenceRows(args: ConnectGpsFleetTrackerArgs): string[][] {
  const rows = [["geofence", "fleet", "policy"]];
  if (args.geofence_count === 0) {
    rows.push(["none", args.fleet_label, "track_only"]);
    return rows;
  }
  for (let index = 1; index <= args.geofence_count; index += 1) {
    rows.push([`geofence_${index}`, args.fleet_label, "aggregate_state_only"]);
  }
  return rows;
}

export async function connectGpsFleetTrackerImpl(
  ctx: ToolContext,
  args: ConnectGpsFleetTrackerArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "gps_fleet_tracker",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        provider: args.provider,
        fleet_label: args.fleet_label,
        adapter_mode: args.adapter_mode,
        adapter_url: args.adapter_url,
        tracked_asset_count: args.tracked_asset_count,
        geofence_count: args.geofence_count,
        update_rate_hz: args.update_rate_hz,
        active: args.active,
      },
      warnings: [
        "Device credentials, raw personally identifiable tracks, smoothing, and map matching are intentionally external to this scaffold.",
        "Use sanitized positions and aggregate geofence state before displaying fleet data publicly.",
      ],
      nodes: [
        sourceNode(args),
        {
          name: "asset_positions",
          optype: "tableDAT",
          x: 300,
          y: 120,
          table: assetRows(args),
        },
        { name: "geofence_map", optype: "tableDAT", x: 600, y: 120, table: geofenceRows(args) },
        {
          name: "privacy_policy",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["fleet_label", args.fleet_label],
            ["allowed_detail", "sanitized_position_or_aggregate"],
            ["update_rate_hz", String(args.update_rate_hz)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Run GPS auth, smoothing, map matching, and privacy filtering in an adapter. TouchDesigner consumes sanitized asset positions and aggregate geofence state.",
        },
      ],
    },
    "connect_gps_fleet_tracker failed",
    (report) =>
      `Created GPS fleet tracker ${report.container_path}; assets ${args.tracked_asset_count}; provider ${args.provider}.`,
  );
}

export const registerConnectGpsFleetTracker: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_gps_fleet_tracker",
    {
      title: "Connect GPS fleet tracker",
      description:
        "Create a GPS/fleet tracking scaffold with sanitized asset rows, geofence maps, privacy policy, adapter source, and credential/privacy notes.",
      inputSchema: connectGpsFleetTrackerSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectGpsFleetTrackerImpl(ctx, args),
  );
};
