import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectYoutubeLiveChatBusSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the YouTube scaffold."),
  name: z.string().default("youtube_live_chat_bus").describe("Generated baseCOMP name."),
  channel_id: z.string().default("youtube_channel"),
  live_chat_id: z.string().default("live_chat"),
  adapter_mode: z.enum(["polling_json", "websocket_json", "manual"]).default("polling_json"),
  adapter_url: z.string().default("http://127.0.0.1:9078/youtube-chat"),
  message_count: z.coerce.number().int().min(1).max(1024).default(24),
  super_chat_tier_count: z.coerce.number().int().min(0).max(32).default(5),
  moderation_level: z.enum(["display_only", "filtered", "approval_required"]).default("filtered"),
  active: z.boolean().default(false),
});

type ConnectYoutubeLiveChatBusArgs = z.infer<typeof connectYoutubeLiveChatBusSchema>;

function sourceNode(args: ConnectYoutubeLiveChatBusArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "websocket_json") {
    return {
      name: "youtube_ws_adapter",
      optype: "websocketDAT",
      x: 0,
      y: 120,
      params: { url: args.adapter_url, active: args.active ? 1 : 0 },
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_youtube_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Paste sanitized YouTube chat rows into message_map.",
    };
  }
  return {
    name: "youtube_chat_client",
    optype: "webclientDAT",
    x: 0,
    y: 120,
    params: { url: args.adapter_url, active: args.active ? 1 : 0 },
  };
}

function messageRows(args: ConnectYoutubeLiveChatBusArgs): string[][] {
  const rows = [["message", "channel_id", "kind", "policy"]];
  const kinds = ["text", "member", "super_chat", "poll"];
  for (let index = 1; index <= args.message_count; index += 1) {
    rows.push([
      `message_${index}`,
      args.channel_id,
      kinds[(index - 1) % kinds.length] ?? "text",
      args.moderation_level,
    ]);
  }
  return rows;
}

function tierRows(args: ConnectYoutubeLiveChatBusArgs): string[][] {
  const rows = [["tier", "binding", "policy"]];
  if (args.super_chat_tier_count === 0) {
    rows.push(["none", "chat_only", args.moderation_level]);
    return rows;
  }
  for (let index = 1; index <= args.super_chat_tier_count; index += 1) {
    rows.push([`tier_${index}`, `youtube_super_chat_${index}`, args.moderation_level]);
  }
  return rows;
}

export async function connectYoutubeLiveChatBusImpl(
  ctx: ToolContext,
  args: ConnectYoutubeLiveChatBusArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "youtube_live_chat_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        channel_id: args.channel_id,
        live_chat_id: args.live_chat_id,
        adapter_mode: args.adapter_mode,
        adapter_url: args.adapter_url,
        message_count: args.message_count,
        super_chat_tier_count: args.super_chat_tier_count,
        moderation_level: args.moderation_level,
        active: args.active,
      },
      warnings: [
        "YouTube API keys/OAuth, quota management, author details, and moderation decisions are intentionally external to this scaffold.",
        "Chat-derived actions should be filtered and approval-gated before affecting show-control systems.",
      ],
      nodes: [
        sourceNode(args),
        { name: "message_map", optype: "tableDAT", x: 300, y: 120, table: messageRows(args) },
        { name: "super_chat_tiers", optype: "tableDAT", x: 600, y: 120, table: tierRows(args) },
        {
          name: "moderation_policy",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["channel_id", args.channel_id],
            ["live_chat_id", args.live_chat_id],
            ["moderation_level", args.moderation_level],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use an adapter for YouTube auth, polling quota, author filtering, and moderation. TouchDesigner consumes sanitized message_map rows.",
        },
      ],
    },
    "connect_youtube_live_chat_bus failed",
    (report) =>
      `Created YouTube Live Chat bus ${report.container_path}; messages ${args.message_count}; channel ${args.channel_id}.`,
  );
}

export const registerConnectYoutubeLiveChatBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_youtube_live_chat_bus",
    {
      title: "Connect YouTube Live Chat bus",
      description:
        "Create a YouTube Live Chat scaffold with sanitized message rows, Super Chat tiers, moderation policy, adapter source, and API/quota safety notes.",
      inputSchema: connectYoutubeLiveChatBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectYoutubeLiveChatBusImpl(ctx, args),
  );
};
