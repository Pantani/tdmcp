import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { requestPulse, websocketDatParams } from "./externalShowBridgeHelpers.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectDiscordInteractionBusSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the Discord scaffold."),
  name: z.string().default("discord_interaction_bus").describe("Generated baseCOMP name."),
  guild_label: z.string().default("show_guild"),
  channel_label: z.string().default("stage-chat"),
  adapter_mode: z.enum(["gateway_json", "webhook_json", "manual"]).default("gateway_json"),
  adapter_url: z.string().default("ws://127.0.0.1:9079/discord"),
  command_count: z.coerce.number().int().min(0).max(128).default(6),
  message_count: z.coerce.number().int().min(1).max(1024).default(16),
  approval_required: z.boolean().default(true),
  active: z.boolean().default(false),
});

type ConnectDiscordInteractionBusArgs = z.infer<typeof connectDiscordInteractionBusSchema>;

function sourceNode(args: ConnectDiscordInteractionBusArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "webhook_json") {
    return {
      name: "discord_webhook_client",
      optype: "webclientDAT",
      x: 0,
      y: 120,
      params: { url: args.adapter_url, active: args.active ? 1 : 0 },
      pulses: requestPulse(args.active),
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_discord_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Paste sanitized Discord rows into message_map and command_map.",
    };
  }
  return {
    name: "discord_gateway_adapter",
    optype: "websocketDAT",
    x: 0,
    y: 120,
    params: websocketDatParams(args.adapter_url, args.active),
  };
}

function commandRows(args: ConnectDiscordInteractionBusArgs): string[][] {
  const rows = [["command", "channel", "policy"]];
  if (args.command_count === 0) {
    rows.push(["none", args.channel_label, "messages_only"]);
    return rows;
  }
  for (let index = 1; index <= args.command_count; index += 1) {
    rows.push([
      `/show_${index}`,
      args.channel_label,
      args.approval_required ? "approval_required" : "adapter_gated",
    ]);
  }
  return rows;
}

function messageRows(args: ConnectDiscordInteractionBusArgs): string[][] {
  const rows = [["message", "guild", "channel", "policy"]];
  for (let index = 1; index <= args.message_count; index += 1) {
    rows.push([
      `message_${index}`,
      args.guild_label,
      args.channel_label,
      args.approval_required ? "moderated" : "display_only",
    ]);
  }
  return rows;
}

export async function connectDiscordInteractionBusImpl(
  ctx: ToolContext,
  args: ConnectDiscordInteractionBusArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "discord_interaction_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        guild_label: args.guild_label,
        channel_label: args.channel_label,
        adapter_mode: args.adapter_mode,
        adapter_url: args.adapter_url,
        command_count: args.command_count,
        message_count: args.message_count,
        approval_required: args.approval_required,
        active: args.active,
      },
      warnings: [
        "Discord bot tokens, interaction signatures, role lookups, raw user identifiers, and moderation are intentionally external to this scaffold.",
        "Slash commands and button interactions must stay approval-gated before affecting show systems.",
      ],
      nodes: [
        sourceNode(args),
        { name: "command_map", optype: "tableDAT", x: 300, y: 120, table: commandRows(args) },
        { name: "message_map", optype: "tableDAT", x: 600, y: 120, table: messageRows(args) },
        {
          name: "interaction_policy",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["guild_label", args.guild_label],
            ["channel_label", args.channel_label],
            ["approval_required", String(args.approval_required)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use an adapter for Discord Gateway/webhook auth, role checks, signatures, and moderation. TouchDesigner consumes sanitized command and message rows.",
        },
      ],
    },
    "connect_discord_interaction_bus failed",
    (report) =>
      `Created Discord interaction bus ${report.container_path}; commands ${args.command_count}; channel ${args.channel_label}.`,
  );
}

export const registerConnectDiscordInteractionBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_discord_interaction_bus",
    {
      title: "Connect Discord interaction bus",
      description:
        "Create a Discord interaction scaffold with command rows, message rows, approval policy, adapter source, and bot-token/signature safety notes.",
      inputSchema: connectDiscordInteractionBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectDiscordInteractionBusImpl(ctx, args),
  );
};
