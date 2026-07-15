import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectTiktokLiveEventsBusSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the TikTok scaffold."),
  name: z.string().default("tiktok_live_events_bus").describe("Generated baseCOMP name."),
  creator_label: z.string().default("show_creator"),
  adapter_mode: z.enum(["websocket_json", "polling_json", "manual"]).default("websocket_json"),
  adapter_url: z.string().default("ws://127.0.0.1:9080/tiktok-live"),
  event_count: z.coerce.number().int().min(1).max(1024).default(16),
  gift_tier_count: z.coerce.number().int().min(0).max(128).default(6),
  moderation_level: z.enum(["display_only", "filtered", "approval_required"]).default("filtered"),
  active: z.boolean().default(false),
});

type ConnectTiktokLiveEventsBusArgs = z.infer<typeof connectTiktokLiveEventsBusSchema>;

function sourceNode(args: ConnectTiktokLiveEventsBusArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "polling_json") {
    return {
      name: "tiktok_poll_client",
      optype: "webclientDAT",
      x: 0,
      y: 120,
      params: { url: args.adapter_url, active: args.active ? 1 : 0 },
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_tiktok_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Paste sanitized TikTok Live event rows into live_event_map.",
    };
  }
  return {
    name: "tiktok_ws_adapter",
    optype: "websocketDAT",
    x: 0,
    y: 120,
    params: { url: args.adapter_url, active: args.active ? 1 : 0 },
  };
}

function eventRows(args: ConnectTiktokLiveEventsBusArgs): string[][] {
  const rows = [["event", "creator", "kind", "policy"]];
  const kinds = ["chat", "like", "gift", "follow", "share"];
  for (let index = 1; index <= args.event_count; index += 1) {
    rows.push([
      `event_${index}`,
      args.creator_label,
      kinds[(index - 1) % kinds.length] ?? "event",
      args.moderation_level,
    ]);
  }
  return rows;
}

function giftRows(args: ConnectTiktokLiveEventsBusArgs): string[][] {
  const rows = [["gift_tier", "creator", "binding"]];
  if (args.gift_tier_count === 0) {
    rows.push(["none", args.creator_label, "events_only"]);
    return rows;
  }
  for (let index = 1; index <= args.gift_tier_count; index += 1) {
    rows.push([`gift_tier_${index}`, args.creator_label, `tiktok_gift_${index}`]);
  }
  return rows;
}

export async function connectTiktokLiveEventsBusImpl(
  ctx: ToolContext,
  args: ConnectTiktokLiveEventsBusArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "tiktok_live_events_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        creator_label: args.creator_label,
        adapter_mode: args.adapter_mode,
        adapter_url: args.adapter_url,
        event_count: args.event_count,
        gift_tier_count: args.gift_tier_count,
        moderation_level: args.moderation_level,
        active: args.active,
      },
      warnings: [
        "Platform auth, client constraints, user identifiers, gift normalization, and moderation are intentionally external to this scaffold.",
        "Use sanitized aggregate live-event rows before binding audience activity to visuals or controls.",
      ],
      nodes: [
        sourceNode(args),
        {
          name: "live_event_map",
          optype: "tableDAT",
          x: 300,
          y: 120,
          table: eventRows(args),
        },
        { name: "gift_tiers", optype: "tableDAT", x: 600, y: 120, table: giftRows(args) },
        {
          name: "moderation_policy",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["creator_label", args.creator_label],
            ["moderation_level", args.moderation_level],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use an adapter for TikTok Live ingestion, gift normalization, user filtering, and moderation. TouchDesigner consumes sanitized live_event_map rows.",
        },
      ],
    },
    "connect_tiktok_live_events_bus failed",
    (report) =>
      `Created TikTok Live events bus ${report.container_path}; events ${args.event_count}; creator ${args.creator_label}.`,
  );
}

export const registerConnectTiktokLiveEventsBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_tiktok_live_events_bus",
    {
      title: "Connect TikTok Live events bus",
      description:
        "Create a TikTok Live-style event scaffold with sanitized event rows, gift tiers, moderation policy, adapter source, and auth/client safety notes.",
      inputSchema: connectTiktokLiveEventsBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectTiktokLiveEventsBusImpl(ctx, args),
  );
};
