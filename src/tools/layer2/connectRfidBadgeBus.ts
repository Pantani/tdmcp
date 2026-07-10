import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectRfidBadgeBusSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the RFID scaffold."),
  name: z.string().default("rfid_badge_bus").describe("Generated baseCOMP name."),
  venue_label: z.string().default("installation"),
  adapter_mode: z.enum(["websocket_json", "http_json", "manual"]).default("websocket_json"),
  adapter_url: z.string().default("ws://127.0.0.1:9083/rfid"),
  reader_count: z.coerce.number().int().min(1).max(128).default(4),
  badge_event_count: z.coerce.number().int().min(1).max(2048).default(24),
  privacy_level: z
    .enum(["aggregate_only", "pseudonymous", "approval_required"])
    .default("pseudonymous"),
  active: z.boolean().default(false),
});

type ConnectRfidBadgeBusArgs = z.infer<typeof connectRfidBadgeBusSchema>;

function sourceNode(args: ConnectRfidBadgeBusArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "http_json") {
    return {
      name: "rfid_http_adapter",
      optype: "webclientDAT",
      x: 0,
      y: 120,
      params: { url: args.adapter_url, active: args.active ? 1 : 0 },
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_rfid_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Paste sanitized RFID rows into badge_event_map.",
    };
  }
  return {
    name: "rfid_ws_adapter",
    optype: "websocketDAT",
    x: 0,
    y: 120,
    params: { url: args.adapter_url, active: args.active ? 1 : 0 },
  };
}

function readerRows(args: ConnectRfidBadgeBusArgs): string[][] {
  const rows = [["reader", "venue", "zone", "binding"]];
  for (let index = 1; index <= args.reader_count; index += 1) {
    rows.push([
      `reader_${index}`,
      args.venue_label,
      `zone_${((index - 1) % Math.max(args.reader_count, 1)) + 1}`,
      `rfid_reader_${index}`,
    ]);
  }
  return rows;
}

function eventRows(args: ConnectRfidBadgeBusArgs): string[][] {
  const rows = [["event", "reader", "badge_ref", "policy"]];
  for (let index = 1; index <= args.badge_event_count; index += 1) {
    rows.push([
      `badge_event_${index}`,
      `reader_${((index - 1) % args.reader_count) + 1}`,
      `visitor_ref_${index}`,
      args.privacy_level,
    ]);
  }
  return rows;
}

export async function connectRfidBadgeBusImpl(ctx: ToolContext, args: ConnectRfidBadgeBusArgs) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "rfid_badge_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        venue_label: args.venue_label,
        adapter_mode: args.adapter_mode,
        adapter_url: args.adapter_url,
        reader_count: args.reader_count,
        badge_event_count: args.badge_event_count,
        privacy_level: args.privacy_level,
        active: args.active,
      },
      warnings: [
        "Raw RFID badge IDs, access-control decisions, enrollment data, and reader credentials are intentionally external to this scaffold.",
        "Route RFID-driven show effects through consent, privacy, and operator approval policy before dispatch.",
      ],
      nodes: [
        sourceNode(args),
        { name: "reader_map", optype: "tableDAT", x: 300, y: 120, table: readerRows(args) },
        {
          name: "badge_event_map",
          optype: "tableDAT",
          x: 600,
          y: 120,
          table: eventRows(args),
        },
        {
          name: "privacy_policy",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["venue_label", args.venue_label],
            ["privacy_level", args.privacy_level],
            ["raw_badge_ids_in_td", "false"],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use an adapter for RFID reader SDKs, badge hashing, access policy, dedupe, and consent. TouchDesigner consumes only sanitized badge_event_map rows.",
        },
      ],
    },
    "connect_rfid_badge_bus failed",
    (report) =>
      `Created RFID badge bus ${report.container_path}; readers ${args.reader_count}; events ${args.badge_event_count}.`,
  );
}

export const registerConnectRfidBadgeBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_rfid_badge_bus",
    {
      title: "Connect RFID badge bus",
      description:
        "Create an RFID badge-reader scaffold with sanitized badge events, reader maps, privacy policy, adapter source, and access-control safety notes.",
      inputSchema: connectRfidBadgeBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectRfidBadgeBusImpl(ctx, args),
  );
};
