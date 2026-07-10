import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectMapTileOverlaySchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the map scaffold."),
  name: z.string().default("map_tile_overlay").describe("Generated baseCOMP name."),
  provider: z
    .enum(["mapbox", "maptiler", "openstreetmap", "custom_tiles"])
    .default("openstreetmap"),
  style_id: z.string().default("standard"),
  tile_url_template: z.string().default("https://tile.openstreetmap.org/{z}/{x}/{y}.png"),
  center_lat: z.coerce.number().min(-90).max(90).default(0),
  center_lng: z.coerce.number().min(-180).max(180).default(0),
  zoom_level: z.coerce.number().int().min(0).max(22).default(12),
  layer_count: z.coerce.number().int().min(1).max(64).default(4),
  attribution_required: z.boolean().default(true),
  active: z.boolean().default(false),
});

type ConnectMapTileOverlayArgs = z.infer<typeof connectMapTileOverlaySchema>;

function sourceNode(args: ConnectMapTileOverlayArgs): ExternalShowNodeSpec {
  if (args.provider === "custom_tiles") {
    return {
      name: "custom_tile_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Custom tile mode selected. Use an adapter to resolve and cache tile imagery before feeding TouchDesigner.",
    };
  }
  return {
    name: "tile_manifest_client",
    optype: "webclientDAT",
    x: 0,
    y: 120,
    params: { url: args.tile_url_template, active: 0 },
  };
}

function layerRows(args: ConnectMapTileOverlayArgs): string[][] {
  const rows = [["layer", "provider", "style_id", "visibility"]];
  for (let index = 1; index <= args.layer_count; index += 1) {
    rows.push([`layer_${index}`, args.provider, args.style_id, index === 1 ? "base" : "overlay"]);
  }
  return rows;
}

export async function connectMapTileOverlayImpl(ctx: ToolContext, args: ConnectMapTileOverlayArgs) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "map_tile_overlay",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        provider: args.provider,
        style_id: args.style_id,
        tile_url_template: args.tile_url_template,
        center_lat: args.center_lat,
        center_lng: args.center_lng,
        zoom_level: args.zoom_level,
        layer_count: args.layer_count,
        attribution_required: args.attribution_required,
        active: args.active,
      },
      warnings: [
        "Map provider tokens, tile cache rules, stitching, and rate limits are intentionally external to this scaffold.",
        "Display provider attribution whenever required by the selected tile source.",
      ],
      nodes: [
        sourceNode(args),
        { name: "tile_layer_map", optype: "tableDAT", x: 300, y: 120, table: layerRows(args) },
        {
          name: "viewport",
          optype: "tableDAT",
          x: 600,
          y: 120,
          table: [
            ["field", "value"],
            ["center_lat", String(args.center_lat)],
            ["center_lng", String(args.center_lng)],
            ["zoom_level", String(args.zoom_level)],
          ],
        },
        {
          name: "attribution",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["provider", args.provider],
            ["required", String(args.attribution_required)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use an adapter to fetch, cache, stitch, and attribute map tiles. TouchDesigner consumes stable layer rows and local/media-ready tile outputs.",
        },
      ],
    },
    "connect_map_tile_overlay failed",
    (report) =>
      `Created map tile overlay ${report.container_path}; layers ${args.layer_count}; provider ${args.provider}.`,
  );
}

export const registerConnectMapTileOverlay: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_map_tile_overlay",
    {
      title: "Connect map tile overlay",
      description:
        "Create a map-tile overlay scaffold with tile layer maps, viewport metadata, attribution rows, adapter source, and token/cache safety notes.",
      inputSchema: connectMapTileOverlaySchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectMapTileOverlayImpl(ctx, args),
  );
};
