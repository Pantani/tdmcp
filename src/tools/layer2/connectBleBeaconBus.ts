import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { websocketDatParams } from "./externalShowBridgeHelpers.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectBleBeaconBusSchema = z
  .object({
    parent_path: z.string().default("/project1").describe("Parent COMP for the BLE scaffold."),
    name: z.string().default("ble_beacon_bus").describe("Generated baseCOMP name."),
    site_label: z.string().default("gallery_floor"),
    adapter_mode: z.enum(["websocket_json", "http_json", "manual"]).default("websocket_json"),
    adapter_url: z.string().default("ws://127.0.0.1:9085/ble"),
    scanner_count: z.coerce.number().int().min(1).max(128).default(4),
    beacon_count: z.coerce.number().int().min(1).max(2048).default(16),
    zone_count: z.coerce.number().int().min(1).max(256).default(6),
    smoothing_window_sec: z.coerce.number().int().min(1).max(3600).default(15),
    active: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (value.adapter_mode === "websocket_json" && !/^wss?:\/\//i.test(value.adapter_url)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["adapter_url"],
        message: "adapter_url must start with ws:// or wss:// when adapter_mode is websocket_json.",
      });
    }
    if (value.adapter_mode === "http_json" && !/^https?:\/\//i.test(value.adapter_url)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["adapter_url"],
        message: "adapter_url must start with http:// or https:// when adapter_mode is http_json.",
      });
    }
  });

type ConnectBleBeaconBusArgs = z.infer<typeof connectBleBeaconBusSchema>;

function sourceNode(args: ConnectBleBeaconBusArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "http_json") {
    return {
      name: "ble_http_adapter",
      optype: "webclientDAT",
      x: 0,
      y: 120,
      params: { url: args.adapter_url, active: args.active ? 1 : 0 },
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_ble_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Paste sanitized BLE proximity rows into beacon_map.",
    };
  }
  return {
    name: "ble_ws_adapter",
    optype: "websocketDAT",
    x: 0,
    y: 120,
    params: websocketDatParams(args.adapter_url, args.active),
  };
}

function beaconRows(args: ConnectBleBeaconBusArgs): string[][] {
  const rows = [["beacon", "scanner", "zone", "rssi_bucket"]];
  for (let index = 1; index <= args.beacon_count; index += 1) {
    rows.push([
      `beacon_${index}`,
      `scanner_${((index - 1) % args.scanner_count) + 1}`,
      `zone_${((index - 1) % args.zone_count) + 1}`,
      ["near", "mid", "far"][(index - 1) % 3] ?? "mid",
    ]);
  }
  return rows;
}

function zoneRows(args: ConnectBleBeaconBusArgs): string[][] {
  const rows = [["zone", "site", "binding"]];
  for (let index = 1; index <= args.zone_count; index += 1) {
    rows.push([`zone_${index}`, args.site_label, `ble_zone_${index}`]);
  }
  return rows;
}

export async function connectBleBeaconBusImpl(ctx: ToolContext, args: ConnectBleBeaconBusArgs) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "ble_beacon_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        site_label: args.site_label,
        adapter_mode: args.adapter_mode,
        adapter_url: args.adapter_url,
        scanner_count: args.scanner_count,
        beacon_count: args.beacon_count,
        zone_count: args.zone_count,
        smoothing_window_sec: args.smoothing_window_sec,
        active: args.active,
      },
      warnings: [
        "Raw BLE MAC addresses, device fingerprints, calibration records, and consent logic are intentionally external to this scaffold.",
        "BLE proximity is noisy; use smoothed/aggregate buckets from the adapter for show control.",
      ],
      nodes: [
        sourceNode(args),
        { name: "beacon_map", optype: "tableDAT", x: 300, y: 120, table: beaconRows(args) },
        { name: "zone_map", optype: "tableDAT", x: 600, y: 120, table: zoneRows(args) },
        {
          name: "smoothing_policy",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["site_label", args.site_label],
            ["smoothing_window_sec", String(args.smoothing_window_sec)],
            ["raw_device_ids_in_td", "false"],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use an adapter for BLE scanning, RSSI smoothing, MAC hashing, dedupe, and consent. TouchDesigner consumes beacon_map and zone_map rows.",
        },
      ],
    },
    "connect_ble_beacon_bus failed",
    (report) =>
      `Created BLE beacon bus ${report.container_path}; beacons ${args.beacon_count}; zones ${args.zone_count}.`,
  );
}

export const registerConnectBleBeaconBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_ble_beacon_bus",
    {
      title: "Connect BLE beacon bus",
      description:
        "Create a BLE beacon proximity scaffold with sanitized beacon rows, zone maps, smoothing policy, adapter source, and device-privacy notes.",
      inputSchema: connectBleBeaconBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectBleBeaconBusImpl(ctx, args),
  );
};
