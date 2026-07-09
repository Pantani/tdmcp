import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectTwitchEventsubBusSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the Twitch scaffold."),
  name: z.string().default("twitch_eventsub_bus").describe("Generated baseCOMP name."),
  channel_login: z.string().default("show_channel"),
  adapter_mode: z.enum(["webhook_json", "websocket_json", "manual"]).default("websocket_json"),
  adapter_url: z.string().default("ws://127.0.0.1:9077/twitch"),
  event_count: z.coerce.number().int().min(1).max(512).default(12),
  reward_count: z.coerce.number().int().min(0).max(128).default(4),
  moderation_level: z.enum(["display_only", "filtered", "approval_required"]).default("filtered"),
  active: z.boolean().default(false),
});

type ConnectTwitchEventsubBusArgs = z.infer<typeof connectTwitchEventsubBusSchema>;

function sourceNode(args: ConnectTwitchEventsubBusArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "webhook_json") {
    return {
      name: "twitch_webhook_client",
      optype: "webclientDAT",
      x: 0,
      y: 120,
      params: { url: args.adapter_url, active: args.active ? 1 : 0 },
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_twitch_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Paste sanitized Twitch event rows into event_map.",
    };
  }
  return {
    name: "twitch_ws_adapter",
    optype: "websocketDAT",
    x: 0,
    y: 120,
    params: { url: args.adapter_url, active: args.active ? 1 : 0 },
  };
}

function eventRows(args: ConnectTwitchEventsubBusArgs): string[][] {
  const eventTypes = ["follow", "subscription", "chat", "raid", "channel_points"];
  const rows = [["event", "channel", "type", "policy"]];
  for (let index = 1; index <= args.event_count; index += 1) {
    rows.push([
      `event_${index}`,
      args.channel_login,
      eventTypes[(index - 1) % eventTypes.length] ?? "event",
      args.moderation_level,
    ]);
  }
  return rows;
}

function rewardRows(args: ConnectTwitchEventsubBusArgs): string[][] {
  const rows = [["reward", "channel", "binding"]];
  if (args.reward_count === 0) {
    rows.push(["none", args.channel_login, "events_only"]);
    return rows;
  }
  for (let index = 1; index <= args.reward_count; index += 1) {
    rows.push([`reward_${index}`, args.channel_login, `twitch_reward_${index}`]);
  }
  return rows;
}

export async function connectTwitchEventsubBusImpl(
  ctx: ToolContext,
  args: ConnectTwitchEventsubBusArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "twitch_eventsub_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        channel_login: args.channel_login,
        adapter_mode: args.adapter_mode,
        adapter_url: args.adapter_url,
        event_count: args.event_count,
        reward_count: args.reward_count,
        moderation_level: args.moderation_level,
        active: args.active,
      },
      warnings: [
        "Twitch OAuth, EventSub signature validation, raw user identifiers, badges, and moderation are intentionally external to this scaffold.",
        "Route audience-triggered actions through moderation and approval policy before affecting show systems.",
      ],
      nodes: [
        sourceNode(args),
        { name: "event_map", optype: "tableDAT", x: 300, y: 120, table: eventRows(args) },
        { name: "reward_map", optype: "tableDAT", x: 600, y: 120, table: rewardRows(args) },
        {
          name: "moderation_policy",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["channel_login", args.channel_login],
            ["moderation_level", args.moderation_level],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use an adapter for Twitch auth, EventSub signature checks, chat filtering, and reward normalization. TouchDesigner consumes sanitized event_map rows.",
        },
      ],
    },
    "connect_twitch_eventsub_bus failed",
    (report) =>
      `Created Twitch EventSub bus ${report.container_path}; events ${args.event_count}; channel ${args.channel_login}.`,
  );
}

export const registerConnectTwitchEventsubBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_twitch_eventsub_bus",
    {
      title: "Connect Twitch EventSub bus",
      description:
        "Create a Twitch EventSub/chat scaffold with sanitized event rows, reward maps, moderation policy, adapter source, and OAuth/webhook safety notes.",
      inputSchema: connectTwitchEventsubBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectTwitchEventsubBusImpl(ctx, args),
  );
};
