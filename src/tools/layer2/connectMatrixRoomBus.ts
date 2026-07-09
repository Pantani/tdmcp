import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectMatrixRoomBusSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the Matrix scaffold."),
  name: z.string().default("matrix_room_bus").describe("Generated baseCOMP name."),
  homeserver_label: z.string().default("matrix"),
  room_alias: z.string().default("#show:example.org"),
  adapter_mode: z.enum(["sync_json", "websocket_json", "manual"]).default("sync_json"),
  adapter_url: z.string().default("http://127.0.0.1:9081/matrix"),
  room_event_count: z.coerce.number().int().min(1).max(1024).default(16),
  reaction_count: z.coerce.number().int().min(0).max(128).default(6),
  approval_required: z.boolean().default(true),
  active: z.boolean().default(false),
});

type ConnectMatrixRoomBusArgs = z.infer<typeof connectMatrixRoomBusSchema>;

function sourceNode(args: ConnectMatrixRoomBusArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "websocket_json") {
    return {
      name: "matrix_ws_adapter",
      optype: "websocketDAT",
      x: 0,
      y: 120,
      params: { url: args.adapter_url, active: args.active ? 1 : 0 },
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_matrix_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Paste sanitized Matrix room rows into room_event_map.",
    };
  }
  return {
    name: "matrix_sync_client",
    optype: "webclientDAT",
    x: 0,
    y: 120,
    params: { url: args.adapter_url, active: args.active ? 1 : 0 },
  };
}

function eventRows(args: ConnectMatrixRoomBusArgs): string[][] {
  const rows = [["event", "room_alias", "kind", "policy"]];
  const kinds = ["message", "reaction", "topic", "command"];
  for (let index = 1; index <= args.room_event_count; index += 1) {
    rows.push([
      `event_${index}`,
      args.room_alias,
      kinds[(index - 1) % kinds.length] ?? "message",
      args.approval_required ? "approval_required" : "display_only",
    ]);
  }
  return rows;
}

function reactionRows(args: ConnectMatrixRoomBusArgs): string[][] {
  const rows = [["reaction", "room_alias", "binding"]];
  if (args.reaction_count === 0) {
    rows.push(["none", args.room_alias, "events_only"]);
    return rows;
  }
  for (let index = 1; index <= args.reaction_count; index += 1) {
    rows.push([`reaction_${index}`, args.room_alias, `matrix_reaction_${index}`]);
  }
  return rows;
}

export async function connectMatrixRoomBusImpl(ctx: ToolContext, args: ConnectMatrixRoomBusArgs) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "matrix_room_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        homeserver_label: args.homeserver_label,
        room_alias: args.room_alias,
        adapter_mode: args.adapter_mode,
        adapter_url: args.adapter_url,
        room_event_count: args.room_event_count,
        reaction_count: args.reaction_count,
        approval_required: args.approval_required,
        active: args.active,
      },
      warnings: [
        "Matrix access tokens, encrypted room handling, device verification, raw sender IDs, and moderation are intentionally external to this scaffold.",
        "Operator commands from Matrix should remain approval-gated before affecting show systems.",
      ],
      nodes: [
        sourceNode(args),
        {
          name: "room_event_map",
          optype: "tableDAT",
          x: 300,
          y: 120,
          table: eventRows(args),
        },
        { name: "reaction_map", optype: "tableDAT", x: 600, y: 120, table: reactionRows(args) },
        {
          name: "room_policy",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["homeserver_label", args.homeserver_label],
            ["room_alias", args.room_alias],
            ["approval_required", String(args.approval_required)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use a Matrix adapter for access tokens, sync pagination, encryption, sender filtering, and moderation. TouchDesigner consumes sanitized room_event_map rows.",
        },
      ],
    },
    "connect_matrix_room_bus failed",
    (report) =>
      `Created Matrix room bus ${report.container_path}; events ${args.room_event_count}; room ${args.room_alias}.`,
  );
}

export const registerConnectMatrixRoomBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_matrix_room_bus",
    {
      title: "Connect Matrix room bus",
      description:
        "Create a Matrix room scaffold with sanitized room events, reaction maps, approval policy, adapter source, and token/encryption safety notes.",
      inputSchema: connectMatrixRoomBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectMatrixRoomBusImpl(ctx, args),
  );
};
