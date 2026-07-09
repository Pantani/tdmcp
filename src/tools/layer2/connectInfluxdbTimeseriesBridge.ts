import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const connectInfluxdbTimeseriesBridgeSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the InfluxDB scaffold."),
  name: z.string().default("influxdb_timeseries_bridge").describe("Generated baseCOMP name."),
  endpoint_url: z.string().default("http://127.0.0.1:8086"),
  bucket: z.string().default("show"),
  org: z.string().default("tdmcp"),
  adapter_mode: z.enum(["webclient_json", "websocket_json", "manual"]).default("webclient_json"),
  measurement_count: z.coerce.number().int().min(1).max(128).default(6),
  field_count: z.coerce.number().int().min(1).max(256).default(8),
  poll_seconds: z.coerce.number().min(0.25).max(3600).default(5),
  active: z.boolean().default(false),
});

type ConnectInfluxdbTimeseriesBridgeArgs = z.infer<typeof connectInfluxdbTimeseriesBridgeSchema>;

function measurementRows(args: ConnectInfluxdbTimeseriesBridgeArgs): string[][] {
  const rows = [["measurement", "tag_hint", "field_prefix"]];
  for (let index = 1; index <= args.measurement_count; index += 1) {
    rows.push([`measurement_${index}`, "venue|device|zone", `field_${index}`]);
  }
  return rows;
}

function fieldRows(args: ConnectInfluxdbTimeseriesBridgeArgs): string[][] {
  const rows = [["field", "type", "show_binding"]];
  for (let index = 1; index <= args.field_count; index += 1) {
    rows.push([`field_${index}`, "float", `timeseries_${index}`]);
  }
  return rows;
}

export async function connectInfluxdbTimeseriesBridgeImpl(
  ctx: ToolContext,
  args: ConnectInfluxdbTimeseriesBridgeArgs,
) {
  const clientType = args.adapter_mode === "websocket_json" ? "websocketDAT" : "webclientDAT";
  return runExternalShowScaffold(
    ctx,
    {
      kind: "influxdb_timeseries_bridge",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        endpoint_url: args.endpoint_url,
        bucket: args.bucket,
        org: args.org,
        adapter_mode: args.adapter_mode,
        measurement_count: args.measurement_count,
        field_count: args.field_count,
        poll_seconds: args.poll_seconds,
        active: args.active,
      },
      warnings: [
        "InfluxDB tokens and write/query permissions are intentionally not stored in generated tables.",
        "Retention policy, query cost, and live write safety must be validated in the external adapter.",
      ],
      nodes: [
        {
          name: "influx_adapter",
          optype: args.adapter_mode === "manual" ? "textDAT" : clientType,
          x: 0,
          y: 120,
          params:
            args.adapter_mode === "manual"
              ? undefined
              : { url: args.endpoint_url, active: args.active ? 1 : 0 },
          text:
            args.adapter_mode === "manual"
              ? "Manual mode selected. Paste Flux/line-protocol adapter results into field_map."
              : undefined,
        },
        {
          name: "measurement_map",
          optype: "tableDAT",
          x: 300,
          y: 120,
          table: measurementRows(args),
        },
        { name: "field_map", optype: "tableDAT", x: 600, y: 120, table: fieldRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["endpoint_url", args.endpoint_url],
            ["bucket", args.bucket],
            ["org", args.org],
            ["poll_seconds", String(args.poll_seconds)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use measurement_map and field_map as the TD-side contract. Keep auth headers, Flux queries, line protocol writes, and backfill logic in an adapter.",
        },
      ],
    },
    "connect_influxdb_timeseries_bridge failed",
    (report) =>
      `Created InfluxDB time-series bridge ${report.container_path}; measurements ${args.measurement_count}; fields ${args.field_count}.`,
  );
}

export const registerConnectInfluxdbTimeseriesBridge: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_influxdb_timeseries_bridge",
    {
      title: "Connect InfluxDB time-series bridge",
      description:
        "Create an InfluxDB telemetry scaffold with measurement maps, field maps, query/write adapter notes, and token-safety warnings.",
      inputSchema: connectInfluxdbTimeseriesBridgeSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectInfluxdbTimeseriesBridgeImpl(ctx, args),
  );
};
