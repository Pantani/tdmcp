import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectRedisPubsubBusSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the Redis scaffold."),
  name: z.string().default("redis_pubsub_bus").describe("Generated baseCOMP name."),
  redis_host: z.string().default("127.0.0.1"),
  redis_port: z.coerce.number().int().min(1).max(65535).default(6379),
  adapter_mode: z.enum(["websocket_json", "udp_json", "manual"]).default("websocket_json"),
  server_url: z.string().default("ws://127.0.0.1:9051"),
  channel_root: z.string().default("tdmcp:show"),
  channel_count: z.coerce.number().int().min(1).max(128).default(8),
  database_index: z.coerce.number().int().min(0).max(15).default(0),
  stream_mode: z.enum(["pubsub", "streams", "both"]).default("pubsub"),
  active: z.boolean().default(false),
});

type ConnectRedisPubsubBusArgs = z.infer<typeof connectRedisPubsubBusSchema>;

function sourceNode(args: ConnectRedisPubsubBusArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "udp_json") {
    return {
      name: "redis_udp_adapter",
      optype: "udpinDAT",
      x: 0,
      y: 120,
      params: { port: 9051, active: args.active ? 1 : 0 },
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_adapter_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Use an external Redis adapter to write channels/streams into channel_map.",
    };
  }
  return {
    name: "redis_ws_adapter",
    optype: "websocketDAT",
    x: 0,
    y: 120,
    params: { url: args.server_url, active: args.active ? 1 : 0 },
  };
}

function channelRows(args: ConnectRedisPubsubBusArgs): string[][] {
  const rows = [["label", "channel_or_stream", "mode", "payload_hint"]];
  for (let index = 1; index <= args.channel_count; index += 1) {
    rows.push([
      `channel_${index}`,
      `${args.channel_root}:${index}`,
      args.stream_mode,
      "json|number|string",
    ]);
  }
  return rows;
}

export async function connectRedisPubsubBusImpl(ctx: ToolContext, args: ConnectRedisPubsubBusArgs) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "redis_pubsub_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        redis_host: args.redis_host,
        redis_port: args.redis_port,
        adapter_mode: args.adapter_mode,
        server_url: args.server_url,
        channel_root: args.channel_root,
        channel_count: args.channel_count,
        database_index: args.database_index,
        stream_mode: args.stream_mode,
        active: args.active,
      },
      warnings: [
        "Redis credentials and direct key operations are intentionally not stored or executed by this scaffold.",
        "Avoid write/delete keyspace operations from show visuals unless a deployment policy explicitly allows them.",
      ],
      nodes: [
        sourceNode(args),
        { name: "channel_map", optype: "tableDAT", x: 300, y: 120, table: channelRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 600,
          y: 120,
          table: [
            ["field", "value"],
            ["redis", `${args.redis_host}:${args.redis_port}`],
            ["database_index", String(args.database_index)],
            ["stream_mode", args.stream_mode],
            ["active", String(args.active)],
          ],
        },
        {
          name: "safety_policy",
          optype: "textDAT",
          x: 300,
          y: -40,
          text: "Default policy: subscribe/read normalized messages only. Keep authentication, reconnection, backpressure, and writes in the external adapter.",
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Map Redis Pub/Sub channels or Streams into stable channel_map rows before binding visuals or show state.",
        },
      ],
    },
    "connect_redis_pubsub_bus failed",
    (report) =>
      `Created Redis Pub/Sub bus ${report.container_path}; channels ${args.channel_count}; mode ${args.stream_mode}.`,
  );
}

export const registerConnectRedisPubsubBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_redis_pubsub_bus",
    {
      title: "Connect Redis Pub/Sub bus",
      description:
        "Create a Redis Pub/Sub/Streams scaffold with adapter ingest, channel maps, keyspace safety notes, and read-first operations policy.",
      inputSchema: connectRedisPubsubBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectRedisPubsubBusImpl(ctx, args),
  );
};
