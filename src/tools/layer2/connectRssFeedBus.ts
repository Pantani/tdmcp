import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectRssFeedBusSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the RSS scaffold."),
  name: z.string().default("rss_feed_bus").describe("Generated baseCOMP name."),
  feed_label: z.string().default("editorial_feed"),
  adapter_mode: z.enum(["rss_atom", "webhook_json", "manual"]).default("rss_atom"),
  adapter_url: z.string().default("http://127.0.0.1:9082/feed.xml"),
  item_count: z.coerce.number().int().min(1).max(1024).default(24),
  category_count: z.coerce.number().int().min(1).max(128).default(6),
  refresh_interval_sec: z.coerce.number().int().min(5).max(86400).default(300),
  active: z.boolean().default(false),
});

type ConnectRssFeedBusArgs = z.infer<typeof connectRssFeedBusSchema>;

function sourceNode(args: ConnectRssFeedBusArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "webhook_json") {
    return {
      name: "rss_webhook_adapter",
      optype: "websocketDAT",
      x: 0,
      y: 120,
      params: { url: args.adapter_url, active: args.active ? 1 : 0 },
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_rss_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Paste sanitized feed rows into item_map.",
    };
  }
  return {
    name: "rss_feed_client",
    optype: "webclientDAT",
    x: 0,
    y: 120,
    params: { url: args.adapter_url, active: args.active ? 1 : 0 },
  };
}

function itemRows(args: ConnectRssFeedBusArgs): string[][] {
  const rows = [["item", "feed", "category", "display_policy"]];
  for (let index = 1; index <= args.item_count; index += 1) {
    rows.push([
      `item_${index}`,
      args.feed_label,
      `category_${((index - 1) % args.category_count) + 1}`,
      "sanitized_excerpt",
    ]);
  }
  return rows;
}

function categoryRows(args: ConnectRssFeedBusArgs): string[][] {
  const rows = [["category", "feed", "binding"]];
  for (let index = 1; index <= args.category_count; index += 1) {
    rows.push([`category_${index}`, args.feed_label, `rss_category_${index}`]);
  }
  return rows;
}

export async function connectRssFeedBusImpl(ctx: ToolContext, args: ConnectRssFeedBusArgs) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "rss_feed_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        feed_label: args.feed_label,
        adapter_mode: args.adapter_mode,
        adapter_url: args.adapter_url,
        item_count: args.item_count,
        category_count: args.category_count,
        refresh_interval_sec: args.refresh_interval_sec,
        active: args.active,
      },
      warnings: [
        "Feed fetching, HTML sanitization, media extraction, copyright filtering, and deduplication are intentionally external to this scaffold.",
        "Display only sanitized headlines/excerpts and respect source attribution and copyright constraints.",
      ],
      nodes: [
        sourceNode(args),
        { name: "item_map", optype: "tableDAT", x: 300, y: 120, table: itemRows(args) },
        { name: "category_map", optype: "tableDAT", x: 600, y: 120, table: categoryRows(args) },
        {
          name: "refresh_policy",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["feed_label", args.feed_label],
            ["refresh_interval_sec", String(args.refresh_interval_sec)],
            ["display_policy", "sanitized_excerpt"],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use an adapter for RSS/Atom fetch, HTML cleanup, media extraction, dedupe, copyright filtering, and attribution. TouchDesigner consumes item_map rows.",
        },
      ],
    },
    "connect_rss_feed_bus failed",
    (report) =>
      `Created RSS feed bus ${report.container_path}; items ${args.item_count}; feed ${args.feed_label}.`,
  );
}

export const registerConnectRssFeedBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_rss_feed_bus",
    {
      title: "Connect RSS feed bus",
      description:
        "Create an RSS/Atom/editorial feed scaffold with sanitized item rows, category maps, refresh policy, adapter source, and copyright/sanitization notes.",
      inputSchema: connectRssFeedBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectRssFeedBusImpl(ctx, args),
  );
};
