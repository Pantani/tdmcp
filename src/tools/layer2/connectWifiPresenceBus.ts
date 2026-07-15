import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectWifiPresenceBusSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the Wi-Fi scaffold."),
  name: z.string().default("wifi_presence_bus").describe("Generated baseCOMP name."),
  site_label: z.string().default("venue_floor"),
  adapter_mode: z.enum(["websocket_json", "http_json", "manual"]).default("http_json"),
  adapter_url: z.string().default("http://127.0.0.1:9088/wifi-presence"),
  zone_count: z.coerce.number().int().min(1).max(256).default(6),
  dwell_bucket_count: z.coerce.number().int().min(1).max(64).default(4),
  aggregate_window_sec: z.coerce.number().int().min(5).max(86400).default(60),
  active: z.boolean().default(false),
});

type ConnectWifiPresenceBusArgs = z.infer<typeof connectWifiPresenceBusSchema>;

function sourceNode(args: ConnectWifiPresenceBusArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "websocket_json") {
    return {
      name: "wifi_ws_adapter",
      optype: "websocketDAT",
      x: 0,
      y: 120,
      params: { url: args.adapter_url, active: args.active ? 1 : 0 },
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_wifi_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Paste aggregate Wi-Fi presence rows into occupancy_map.",
    };
  }
  return {
    name: "wifi_http_adapter",
    optype: "webclientDAT",
    x: 0,
    y: 120,
    params: { url: args.adapter_url, active: args.active ? 1 : 0 },
  };
}

function occupancyRows(args: ConnectWifiPresenceBusArgs): string[][] {
  const rows = [["zone", "site", "occupancy_bucket", "window_sec"]];
  for (let index = 1; index <= args.zone_count; index += 1) {
    rows.push([
      `zone_${index}`,
      args.site_label,
      ["low", "medium", "high"][(index - 1) % 3] ?? "medium",
      String(args.aggregate_window_sec),
    ]);
  }
  return rows;
}

function dwellRows(args: ConnectWifiPresenceBusArgs): string[][] {
  const rows = [["bucket", "min_sec", "max_sec", "binding"]];
  for (let index = 1; index <= args.dwell_bucket_count; index += 1) {
    rows.push([
      `dwell_${index}`,
      String((index - 1) * args.aggregate_window_sec),
      String(index * args.aggregate_window_sec),
      `wifi_dwell_${index}`,
    ]);
  }
  return rows;
}

export async function connectWifiPresenceBusImpl(
  ctx: ToolContext,
  args: ConnectWifiPresenceBusArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "wifi_presence_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        site_label: args.site_label,
        adapter_mode: args.adapter_mode,
        adapter_url: args.adapter_url,
        zone_count: args.zone_count,
        dwell_bucket_count: args.dwell_bucket_count,
        aggregate_window_sec: args.aggregate_window_sec,
        active: args.active,
      },
      warnings: [
        "Raw probe requests, MAC addresses, device fingerprints, access-point credentials, and retention policy are intentionally external to this scaffold.",
        "Use aggregate counts only; avoid individual-level Wi-Fi presence inside TouchDesigner.",
      ],
      nodes: [
        sourceNode(args),
        {
          name: "occupancy_map",
          optype: "tableDAT",
          x: 300,
          y: 120,
          table: occupancyRows(args),
        },
        { name: "dwell_bucket_map", optype: "tableDAT", x: 600, y: 120, table: dwellRows(args) },
        {
          name: "privacy_policy",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["site_label", args.site_label],
            ["aggregate_window_sec", String(args.aggregate_window_sec)],
            ["raw_device_ids_in_td", "false"],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use an adapter for Wi-Fi controller/API ingestion, MAC hashing, aggregation, retention policy, and consent. TouchDesigner consumes occupancy_map rows.",
        },
      ],
    },
    "connect_wifi_presence_bus failed",
    (report) =>
      `Created Wi-Fi presence bus ${report.container_path}; zones ${args.zone_count}; dwell buckets ${args.dwell_bucket_count}.`,
  );
}

export const registerConnectWifiPresenceBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_wifi_presence_bus",
    {
      title: "Connect Wi-Fi presence bus",
      description:
        "Create a Wi-Fi presence scaffold with aggregate occupancy rows, dwell buckets, privacy policy, adapter source, and device-privacy notes.",
      inputSchema: connectWifiPresenceBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectWifiPresenceBusImpl(ctx, args),
  );
};
