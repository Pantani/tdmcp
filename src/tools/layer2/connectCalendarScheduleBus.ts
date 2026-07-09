import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectCalendarScheduleBusSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the calendar scaffold."),
  name: z.string().default("calendar_schedule_bus").describe("Generated baseCOMP name."),
  provider: z.enum(["ics", "google_calendar", "outlook", "caldav"]).default("ics"),
  calendar_ref: z.string().default("venue-show-calendar"),
  timezone: z.string().default("UTC"),
  adapter_mode: z.enum(["ics_feed", "webhook_json", "manual"]).default("ics_feed"),
  adapter_url: z.string().default("http://127.0.0.1:9066/calendar.ics"),
  event_count: z.coerce.number().int().min(1).max(512).default(16),
  reminder_count: z.coerce.number().int().min(0).max(128).default(4),
  active: z.boolean().default(false),
});

type ConnectCalendarScheduleBusArgs = z.infer<typeof connectCalendarScheduleBusSchema>;

function sourceNode(args: ConnectCalendarScheduleBusArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "webhook_json") {
    return {
      name: "calendar_ws_adapter",
      optype: "websocketDAT",
      x: 0,
      y: 120,
      params: { url: args.adapter_url, active: args.active ? 1 : 0 },
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_calendar_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Paste normalized event rows into event_schedule.",
    };
  }
  return {
    name: "calendar_feed_client",
    optype: "webclientDAT",
    x: 0,
    y: 120,
    params: { url: args.adapter_url, active: args.active ? 1 : 0 },
  };
}

function eventRows(args: ConnectCalendarScheduleBusArgs): string[][] {
  const rows = [["event_id", "calendar_ref", "start_time", "duration_min", "state"]];
  for (let index = 1; index <= args.event_count; index += 1) {
    rows.push([
      `event_${String(index).padStart(3, "0")}`,
      args.calendar_ref,
      `T+${index * 15}m`,
      "15",
      index === 1 ? "next" : "scheduled",
    ]);
  }
  return rows;
}

function reminderRows(args: ConnectCalendarScheduleBusArgs): string[][] {
  const rows = [["reminder", "offset_min", "target"]];
  if (args.reminder_count === 0) {
    rows.push(["none", "0", "schedule_only"]);
    return rows;
  }
  for (let index = 1; index <= args.reminder_count; index += 1) {
    rows.push([`reminder_${index}`, String(index * 5), `event_${String(index).padStart(3, "0")}`]);
  }
  return rows;
}

export async function connectCalendarScheduleBusImpl(
  ctx: ToolContext,
  args: ConnectCalendarScheduleBusArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "calendar_schedule_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        provider: args.provider,
        calendar_ref: args.calendar_ref,
        timezone: args.timezone,
        adapter_mode: args.adapter_mode,
        adapter_url: args.adapter_url,
        event_count: args.event_count,
        reminder_count: args.reminder_count,
        active: args.active,
      },
      warnings: [
        "Calendar OAuth, CalDAV credentials, recurrence expansion, and invite metadata are intentionally external to this scaffold.",
        "Use normalized schedule rows for visuals and operator dashboards; do not expose private attendee fields in TouchDesigner.",
      ],
      nodes: [
        sourceNode(args),
        { name: "event_schedule", optype: "tableDAT", x: 300, y: 120, table: eventRows(args) },
        { name: "reminder_map", optype: "tableDAT", x: 600, y: 120, table: reminderRows(args) },
        {
          name: "blackout_windows",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["window", "policy"],
            ["setup", "ignore_public_visual_triggers"],
            ["strike", "operator_only"],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use an external adapter for calendar auth, recurrence expansion, timezone normalization, and private-field filtering. TouchDesigner consumes stable event rows.",
        },
      ],
    },
    "connect_calendar_schedule_bus failed",
    (report) =>
      `Created calendar schedule bus ${report.container_path}; events ${args.event_count}; provider ${args.provider}.`,
  );
}

export const registerConnectCalendarScheduleBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_calendar_schedule_bus",
    {
      title: "Connect calendar schedule bus",
      description:
        "Create a venue calendar scaffold with event rows, reminder maps, blackout windows, adapter source, and credential/privacy safety notes.",
      inputSchema: connectCalendarScheduleBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectCalendarScheduleBusImpl(ctx, args),
  );
};
