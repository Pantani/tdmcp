import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectTicketingCheckinBusSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the ticketing scaffold."),
  name: z.string().default("ticketing_checkin_bus").describe("Generated baseCOMP name."),
  provider: z.enum(["eventbrite", "dice", "shotgun", "custom"]).default("eventbrite"),
  event_id: z.string().default("venue_event"),
  venue_zone: z.string().default("front_gate"),
  adapter_mode: z.enum(["rest_json", "webhook_json", "manual"]).default("rest_json"),
  adapter_url: z.string().default("http://127.0.0.1:9067/ticketing"),
  expected_capacity: z.coerce.number().int().min(1).max(250000).default(1200),
  ticket_tier_count: z.coerce.number().int().min(1).max(64).default(4),
  gate_count: z.coerce.number().int().min(1).max(64).default(3),
  active: z.boolean().default(false),
});

type ConnectTicketingCheckinBusArgs = z.infer<typeof connectTicketingCheckinBusSchema>;

function sourceNode(args: ConnectTicketingCheckinBusArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "webhook_json") {
    return {
      name: "ticketing_ws_adapter",
      optype: "websocketDAT",
      x: 0,
      y: 120,
      params: { url: args.adapter_url, active: args.active ? 1 : 0 },
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_checkin_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Paste aggregate gate counts into checkin_map.",
    };
  }
  return {
    name: "ticketing_client",
    optype: "webclientDAT",
    x: 0,
    y: 120,
    params: { url: args.adapter_url, active: args.active ? 1 : 0 },
  };
}

function checkinRows(args: ConnectTicketingCheckinBusArgs): string[][] {
  const rows = [["gate", "venue_zone", "checked_in", "capacity", "status"]];
  const baseCapacity = Math.floor(args.expected_capacity / args.gate_count);
  for (let index = 1; index <= args.gate_count; index += 1) {
    const capacity =
      index === args.gate_count
        ? args.expected_capacity - baseCapacity * (args.gate_count - 1)
        : baseCapacity;
    rows.push([`gate_${index}`, args.venue_zone, "0", String(capacity), "standby"]);
  }
  return rows;
}

function tierRows(args: ConnectTicketingCheckinBusArgs): string[][] {
  const rows = [["tier", "event_id", "allocation", "privacy"]];
  for (let index = 1; index <= args.ticket_tier_count; index += 1) {
    rows.push([`tier_${index}`, args.event_id, "aggregate_only", "no_pii"]);
  }
  return rows;
}

export async function connectTicketingCheckinBusImpl(
  ctx: ToolContext,
  args: ConnectTicketingCheckinBusArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "ticketing_checkin_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        provider: args.provider,
        event_id: args.event_id,
        venue_zone: args.venue_zone,
        adapter_mode: args.adapter_mode,
        adapter_url: args.adapter_url,
        expected_capacity: args.expected_capacity,
        ticket_tier_count: args.ticket_tier_count,
        gate_count: args.gate_count,
        active: args.active,
      },
      warnings: [
        "Ticketing API tokens, raw attendee PII, QR/barcode secrets, and individual check-in rows are intentionally external to this scaffold.",
        "TouchDesigner should consume aggregate counts and gate status only.",
      ],
      nodes: [
        sourceNode(args),
        { name: "checkin_map", optype: "tableDAT", x: 300, y: 120, table: checkinRows(args) },
        { name: "tier_map", optype: "tableDAT", x: 600, y: 120, table: tierRows(args) },
        {
          name: "gate_status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["event_id", args.event_id],
            ["venue_zone", args.venue_zone],
            ["expected_capacity", String(args.expected_capacity)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Keep ticket secrets and attendee identifiers in the adapter. Feed TouchDesigner aggregate gate counts, capacity percentages, and status rows only.",
        },
      ],
    },
    "connect_ticketing_checkin_bus failed",
    (report) =>
      `Created ticketing check-in bus ${report.container_path}; capacity ${args.expected_capacity}; gates ${args.gate_count}.`,
  );
}

export const registerConnectTicketingCheckinBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_ticketing_checkin_bus",
    {
      title: "Connect ticketing check-in bus",
      description:
        "Create a ticketing/check-in scaffold with aggregate gate counts, ticket-tier maps, gate status, adapter source, and PII/token safety notes.",
      inputSchema: connectTicketingCheckinBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectTicketingCheckinBusImpl(ctx, args),
  );
};
