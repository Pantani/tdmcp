import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectNfcTapBusSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the NFC scaffold."),
  name: z.string().default("nfc_tap_bus").describe("Generated baseCOMP name."),
  installation_label: z.string().default("interactive_installation"),
  adapter_mode: z.enum(["websocket_json", "http_json", "manual"]).default("websocket_json"),
  adapter_url: z.string().default("ws://127.0.0.1:9084/nfc"),
  station_count: z.coerce.number().int().min(1).max(128).default(6),
  tap_event_count: z.coerce.number().int().min(1).max(2048).default(24),
  consent_mode: z
    .enum(["opt_in_required", "pseudonymous", "aggregate_only"])
    .default("opt_in_required"),
  active: z.boolean().default(false),
});

type ConnectNfcTapBusArgs = z.infer<typeof connectNfcTapBusSchema>;

function sourceNode(args: ConnectNfcTapBusArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "http_json") {
    return {
      name: "nfc_http_adapter",
      optype: "webclientDAT",
      x: 0,
      y: 120,
      params: { url: args.adapter_url, active: args.active ? 1 : 0 },
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_nfc_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Paste sanitized NFC tap rows into tap_event_map.",
    };
  }
  return {
    name: "nfc_ws_adapter",
    optype: "websocketDAT",
    x: 0,
    y: 120,
    params: { url: args.adapter_url, active: args.active ? 1 : 0 },
  };
}

function stationRows(args: ConnectNfcTapBusArgs): string[][] {
  const rows = [["station", "installation", "interaction", "binding"]];
  for (let index = 1; index <= args.station_count; index += 1) {
    rows.push([
      `station_${index}`,
      args.installation_label,
      `tap_surface_${index}`,
      `nfc_station_${index}`,
    ]);
  }
  return rows;
}

function tapRows(args: ConnectNfcTapBusArgs): string[][] {
  const rows = [["tap", "station", "visitor_ref", "consent_mode"]];
  for (let index = 1; index <= args.tap_event_count; index += 1) {
    rows.push([
      `tap_${index}`,
      `station_${((index - 1) % args.station_count) + 1}`,
      `visitor_ref_${index}`,
      args.consent_mode,
    ]);
  }
  return rows;
}

export async function connectNfcTapBusImpl(ctx: ToolContext, args: ConnectNfcTapBusArgs) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "nfc_tap_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        installation_label: args.installation_label,
        adapter_mode: args.adapter_mode,
        adapter_url: args.adapter_url,
        station_count: args.station_count,
        tap_event_count: args.tap_event_count,
        consent_mode: args.consent_mode,
        active: args.active,
      },
      warnings: [
        "Raw NFC tag IDs, card serials, wallet data, and reader credentials are intentionally external to this scaffold.",
        "Do not trigger personalized visuals unless the adapter has already enforced consent and purpose limits.",
      ],
      nodes: [
        sourceNode(args),
        { name: "station_map", optype: "tableDAT", x: 300, y: 120, table: stationRows(args) },
        { name: "tap_event_map", optype: "tableDAT", x: 600, y: 120, table: tapRows(args) },
        {
          name: "consent_policy",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["installation_label", args.installation_label],
            ["consent_mode", args.consent_mode],
            ["raw_tag_ids_in_td", "false"],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use an adapter for NFC reader SDKs, tag hashing, tap dedupe, consent checks, and payload routing. TouchDesigner consumes tap_event_map rows.",
        },
      ],
    },
    "connect_nfc_tap_bus failed",
    (report) =>
      `Created NFC tap bus ${report.container_path}; stations ${args.station_count}; taps ${args.tap_event_count}.`,
  );
}

export const registerConnectNfcTapBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_nfc_tap_bus",
    {
      title: "Connect NFC tap bus",
      description:
        "Create an NFC tap scaffold with sanitized tap events, station maps, consent policy, adapter source, and tag-privacy notes.",
      inputSchema: connectNfcTapBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectNfcTapBusImpl(ctx, args),
  );
};
