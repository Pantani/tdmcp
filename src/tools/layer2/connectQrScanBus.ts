import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { websocketDatParams } from "./externalShowBridgeHelpers.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectQrScanBusSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the QR scaffold."),
  name: z.string().default("qr_scan_bus").describe("Generated baseCOMP name."),
  campaign_label: z.string().default("visitor_scan"),
  adapter_mode: z.enum(["websocket_json", "http_json", "manual"]).default("http_json"),
  adapter_url: z.string().default("http://127.0.0.1:9087/qr-scans"),
  scan_event_count: z.coerce.number().int().min(1).max(4096).default(24),
  route_count: z.coerce.number().int().min(1).max(256).default(6),
  sanitization_level: z
    .enum(["route_only", "pseudonymous", "approval_required"])
    .default("route_only"),
  active: z.boolean().default(false),
});

type ConnectQrScanBusArgs = z.infer<typeof connectQrScanBusSchema>;

function sourceNode(args: ConnectQrScanBusArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "websocket_json") {
    return {
      name: "qr_ws_adapter",
      optype: "websocketDAT",
      x: 0,
      y: 120,
      params: websocketDatParams(args.adapter_url, args.active),
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_qr_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Paste sanitized QR scan rows into scan_event_map.",
    };
  }
  return {
    name: "qr_http_adapter",
    optype: "webclientDAT",
    x: 0,
    y: 120,
    params: { url: args.adapter_url, active: args.active ? 1 : 0 },
  };
}

function scanRows(args: ConnectQrScanBusArgs): string[][] {
  const rows = [["scan", "campaign", "route", "sanitization"]];
  for (let index = 1; index <= args.scan_event_count; index += 1) {
    rows.push([
      `scan_${index}`,
      args.campaign_label,
      `route_${((index - 1) % args.route_count) + 1}`,
      args.sanitization_level,
    ]);
  }
  return rows;
}

function routeRows(args: ConnectQrScanBusArgs): string[][] {
  const rows = [["route", "campaign", "binding"]];
  for (let index = 1; index <= args.route_count; index += 1) {
    rows.push([`route_${index}`, args.campaign_label, `qr_route_${index}`]);
  }
  return rows;
}

export async function connectQrScanBusImpl(ctx: ToolContext, args: ConnectQrScanBusArgs) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "qr_scan_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        campaign_label: args.campaign_label,
        adapter_mode: args.adapter_mode,
        adapter_url: args.adapter_url,
        scan_event_count: args.scan_event_count,
        route_count: args.route_count,
        sanitization_level: args.sanitization_level,
        active: args.active,
      },
      warnings: [
        "Raw QR payloads, URLs, tokens, campaign secrets, and user identifiers are intentionally external to this scaffold.",
        "Resolve and sanitize QR payloads in the adapter before routing any scan to visuals or show control.",
      ],
      nodes: [
        sourceNode(args),
        { name: "scan_event_map", optype: "tableDAT", x: 300, y: 120, table: scanRows(args) },
        { name: "route_map", optype: "tableDAT", x: 600, y: 120, table: routeRows(args) },
        {
          name: "sanitization_policy",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["campaign_label", args.campaign_label],
            ["sanitization_level", args.sanitization_level],
            ["raw_qr_payloads_in_td", "false"],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use an adapter for QR validation, token resolution, URL allowlisting, scan dedupe, and consent. TouchDesigner consumes scan_event_map rows.",
        },
      ],
    },
    "connect_qr_scan_bus failed",
    (report) =>
      `Created QR scan bus ${report.container_path}; scans ${args.scan_event_count}; routes ${args.route_count}.`,
  );
}

export const registerConnectQrScanBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_qr_scan_bus",
    {
      title: "Connect QR scan bus",
      description:
        "Create a QR scan scaffold with sanitized scan events, route maps, sanitization policy, adapter source, and token/URL safety notes.",
      inputSchema: connectQrScanBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectQrScanBusImpl(ctx, args),
  );
};
