import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectGeojsonFeatureBusSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the GeoJSON scaffold."),
  name: z.string().default("geojson_feature_bus").describe("Generated baseCOMP name."),
  source_label: z.string().default("geojson_source"),
  adapter_mode: z.enum(["file_watch", "webclient_json", "manual"]).default("webclient_json"),
  adapter_url: z.string().default("http://127.0.0.1:9072/features.geojson"),
  geometry_mode: z.enum(["points", "lines", "polygons", "mixed"]).default("mixed"),
  feature_count: z.coerce.number().int().min(1).max(5000).default(64),
  property_count: z.coerce.number().int().min(1).max(128).default(8),
  style_rule_count: z.coerce.number().int().min(1).max(128).default(6),
  active: z.boolean().default(false),
});

type ConnectGeojsonFeatureBusArgs = z.infer<typeof connectGeojsonFeatureBusSchema>;

const normalizedGeometries = ["point", "line", "polygon"] as const;
type NormalizedGeometry = (typeof normalizedGeometries)[number];

function normalizedGeometry(
  mode: ConnectGeojsonFeatureBusArgs["geometry_mode"],
  index: number,
): NormalizedGeometry {
  if (mode === "mixed") return normalizedGeometries[index % normalizedGeometries.length] ?? "point";
  return (
    {
      points: "point",
      lines: "line",
      polygons: "polygon",
    } as const
  )[mode];
}

function sourceNode(args: ConnectGeojsonFeatureBusArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "file_watch") {
    return {
      name: "geojson_file_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "File-watch mode selected. Use an adapter to watch, simplify, and normalize GeoJSON into feature_map rows.",
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_geojson_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Paste normalized feature rows into feature_map.",
    };
  }
  return {
    name: "geojson_client",
    optype: "webclientDAT",
    x: 0,
    y: 120,
    params: { url: args.adapter_url, active: args.active ? 1 : 0 },
  };
}

function featureRows(args: ConnectGeojsonFeatureBusArgs): string[][] {
  const rows = [["feature_id", "source", "geometry", "label", "style"]];
  for (let index = 1; index <= args.feature_count; index += 1) {
    rows.push([
      `feature_${index}`,
      args.source_label,
      normalizedGeometry(args.geometry_mode, index - 1),
      `Feature ${index}`,
      `style_${((index - 1) % args.style_rule_count) + 1}`,
    ]);
  }
  return rows;
}

function propertyRows(args: ConnectGeojsonFeatureBusArgs): string[][] {
  const rows = [["property", "role", "privacy"]];
  for (let index = 1; index <= args.property_count; index += 1) {
    rows.push([`property_${index}`, index <= 2 ? "label" : "custom", "sanitized"]);
  }
  return rows;
}

function styleRows(args: ConnectGeojsonFeatureBusArgs): string[][] {
  const rows = [["style", "geometry", "binding"]];
  for (let index = 1; index <= args.style_rule_count; index += 1) {
    rows.push([
      `style_${index}`,
      normalizedGeometry(args.geometry_mode, index - 1),
      `geo_style_${index}`,
    ]);
  }
  return rows;
}

export async function connectGeojsonFeatureBusImpl(
  ctx: ToolContext,
  args: ConnectGeojsonFeatureBusArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "geojson_feature_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        source_label: args.source_label,
        adapter_mode: args.adapter_mode,
        adapter_url: args.adapter_url,
        geometry_mode: args.geometry_mode,
        feature_count: args.feature_count,
        property_count: args.property_count,
        style_rule_count: args.style_rule_count,
        active: args.active,
      },
      warnings: [
        "Projection conversion, topology simplification, large-file paging, and sensitive property filtering are intentionally external to this scaffold.",
        "Use sanitized feature rows before binding data to labels, maps, or public displays.",
      ],
      nodes: [
        sourceNode(args),
        { name: "feature_map", optype: "tableDAT", x: 300, y: 120, table: featureRows(args) },
        { name: "property_map", optype: "tableDAT", x: 600, y: 120, table: propertyRows(args) },
        { name: "style_rules", optype: "tableDAT", x: 300, y: -40, table: styleRows(args) },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Normalize GeoJSON in an adapter: reproject, simplify, filter properties, and emit stable feature rows for TouchDesigner.",
        },
      ],
    },
    "connect_geojson_feature_bus failed",
    (report) =>
      `Created GeoJSON feature bus ${report.container_path}; features ${args.feature_count}; geometry ${args.geometry_mode}.`,
  );
}

export const registerConnectGeojsonFeatureBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_geojson_feature_bus",
    {
      title: "Connect GeoJSON feature bus",
      description:
        "Create a GeoJSON feature scaffold with feature rows, property maps, style rules, adapter source, and projection/privacy notes.",
      inputSchema: connectGeojsonFeatureBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectGeojsonFeatureBusImpl(ctx, args),
  );
};
