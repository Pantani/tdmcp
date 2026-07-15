import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectDoorAccessBusSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the door scaffold."),
  name: z.string().default("door_access_bus").describe("Generated baseCOMP name."),
  venue_label: z.string().default("venue"),
  adapter_mode: z.enum(["websocket_json", "http_json", "manual"]).default("websocket_json"),
  adapter_url: z.string().default("ws://127.0.0.1:9092/door-access"),
  door_count: z.coerce.number().int().min(1).max(256).default(8),
  event_count: z.coerce.number().int().min(1).max(2048).default(32),
  policy_mode: z.enum(["monitor_only", "approval_required", "manual"]).default("monitor_only"),
  active: z.boolean().default(false),
});

type ConnectDoorAccessBusArgs = z.infer<typeof connectDoorAccessBusSchema>;

function sourceNode(args: ConnectDoorAccessBusArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "http_json") {
    return {
      name: "door_http_adapter",
      optype: "webclientDAT",
      x: 0,
      y: 120,
      params: { url: args.adapter_url, active: args.active ? 1 : 0 },
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_door_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Paste sanitized door events into door_events.",
    };
  }
  return {
    name: "door_ws_adapter",
    optype: "websocketDAT",
    x: 0,
    y: 120,
    params: { url: args.adapter_url, active: args.active ? 1 : 0 },
  };
}

function doorRows(args: ConnectDoorAccessBusArgs): string[][] {
  const rows = [["door", "venue", "zone", "state"]];
  for (let index = 1; index <= args.door_count; index += 1) {
    rows.push([`door_${index}`, args.venue_label, `zone_${index}`, "unknown"]);
  }
  return rows;
}

function eventRows(args: ConnectDoorAccessBusArgs): string[][] {
  const rows = [["event", "door", "kind", "policy"]];
  for (let index = 1; index <= args.event_count; index += 1) {
    rows.push([
      `door_event_${index}`,
      `door_${((index - 1) % args.door_count) + 1}`,
      "state",
      args.policy_mode,
    ]);
  }
  return rows;
}

export async function connectDoorAccessBusImpl(ctx: ToolContext, args: ConnectDoorAccessBusArgs) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "door_access_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        venue_label: args.venue_label,
        adapter_mode: args.adapter_mode,
        adapter_url: args.adapter_url,
        door_count: args.door_count,
        event_count: args.event_count,
        policy_mode: args.policy_mode,
        active: args.active,
      },
      warnings: [
        "Credentials, badge IDs, unlock commands, and access-control decisions are intentionally external to this scaffold.",
        "Door events in TouchDesigner are monitor/display cues only; never use this scaffold to actuate locks.",
      ],
      nodes: [
        sourceNode(args),
        { name: "door_map", optype: "tableDAT", x: 300, y: 120, table: doorRows(args) },
        { name: "door_events", optype: "tableDAT", x: 600, y: 120, table: eventRows(args) },
        {
          name: "access_policy",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["venue_label", args.venue_label],
            ["policy_mode", args.policy_mode],
            ["lock_control_in_td", "false"],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use an access-system adapter that emits sanitized door state. TouchDesigner may visualize state but must not authorize entry or control locks.",
        },
      ],
    },
    "connect_door_access_bus failed",
    (report) =>
      `Created door-access bus ${report.container_path}; doors ${args.door_count}; events ${args.event_count}.`,
  );
}

export const registerConnectDoorAccessBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_door_access_bus",
    {
      title: "Connect door-access bus",
      description:
        "Create a door-access monitoring scaffold with sanitized door events, door maps, adapter source, and lock-control safety notes.",
      inputSchema: connectDoorAccessBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectDoorAccessBusImpl(ctx, args),
  );
};
