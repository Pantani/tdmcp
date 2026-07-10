import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectAdsbAircraftBusSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the ADS-B scaffold."),
  name: z.string().default("adsb_aircraft_bus").describe("Generated baseCOMP name."),
  provider: z.enum(["dump1090", "tar1090", "opensky_adapter", "custom"]).default("dump1090"),
  airspace_label: z.string().default("venue_airspace"),
  adapter_mode: z.enum(["rest_json", "websocket_json", "manual"]).default("rest_json"),
  adapter_url: z.string().default("http://127.0.0.1:9074/aircraft"),
  aircraft_count: z.coerce.number().int().min(1).max(5000).default(32),
  altitude_band_count: z.coerce.number().int().min(1).max(64).default(6),
  track_history_count: z.coerce.number().int().min(1).max(2048).default(24),
  active: z.boolean().default(false),
});

type ConnectAdsbAircraftBusArgs = z.infer<typeof connectAdsbAircraftBusSchema>;

function sourceNode(args: ConnectAdsbAircraftBusArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "websocket_json") {
    return {
      name: "adsb_ws_adapter",
      optype: "websocketDAT",
      x: 0,
      y: 120,
      params: { url: args.adapter_url, active: args.active ? 1 : 0 },
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_adsb_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Paste sanitized aircraft rows into aircraft_map.",
    };
  }
  return {
    name: "adsb_client",
    optype: "webclientDAT",
    x: 0,
    y: 120,
    params: { url: args.adapter_url, active: args.active ? 1 : 0 },
  };
}

function aircraftRows(args: ConnectAdsbAircraftBusArgs): string[][] {
  const rows = [["aircraft", "airspace", "lat", "lng", "altitude_band"]];
  for (let index = 1; index <= args.aircraft_count; index += 1) {
    rows.push([
      `aircraft_${index}`,
      args.airspace_label,
      "0",
      "0",
      `band_${((index - 1) % args.altitude_band_count) + 1}`,
    ]);
  }
  return rows;
}

function altitudeRows(args: ConnectAdsbAircraftBusArgs): string[][] {
  const rows = [["band", "min_ft", "max_ft"]];
  for (let index = 1; index <= args.altitude_band_count; index += 1) {
    rows.push([`band_${index}`, String((index - 1) * 5000), String(index * 5000)]);
  }
  return rows;
}

export async function connectAdsbAircraftBusImpl(
  ctx: ToolContext,
  args: ConnectAdsbAircraftBusArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "adsb_aircraft_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        provider: args.provider,
        airspace_label: args.airspace_label,
        adapter_mode: args.adapter_mode,
        adapter_url: args.adapter_url,
        aircraft_count: args.aircraft_count,
        altitude_band_count: args.altitude_band_count,
        track_history_count: args.track_history_count,
        active: args.active,
      },
      warnings: [
        "Receiver credentials, feed terms, raw identifiers, deduplication, and range filters are intentionally external to this scaffold.",
        "Use sanitized aircraft rows for ambient or public display; honor local feed terms and privacy constraints.",
      ],
      nodes: [
        sourceNode(args),
        { name: "aircraft_map", optype: "tableDAT", x: 300, y: 120, table: aircraftRows(args) },
        { name: "altitude_bands", optype: "tableDAT", x: 600, y: 120, table: altitudeRows(args) },
        {
          name: "track_history",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["airspace_label", args.airspace_label],
            ["track_history_count", String(args.track_history_count)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use an adapter to decode, filter, deduplicate, and anonymize aircraft feeds. TouchDesigner consumes sanitized aircraft_map rows and altitude bands.",
        },
      ],
    },
    "connect_adsb_aircraft_bus failed",
    (report) =>
      `Created ADS-B aircraft bus ${report.container_path}; aircraft ${args.aircraft_count}; provider ${args.provider}.`,
  );
}

export const registerConnectAdsbAircraftBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_adsb_aircraft_bus",
    {
      title: "Connect ADS-B aircraft bus",
      description:
        "Create an ADS-B aircraft scaffold with sanitized aircraft rows, altitude bands, track history metadata, adapter source, and feed/privacy notes.",
      inputSchema: connectAdsbAircraftBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectAdsbAircraftBusImpl(ctx, args),
  );
};
