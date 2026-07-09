import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectQueueLengthBusSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the queue scaffold."),
  name: z.string().default("queue_length_bus").describe("Generated baseCOMP name."),
  queue_label: z.string().default("main_queue"),
  adapter_mode: z.enum(["websocket_json", "http_json", "manual"]).default("websocket_json"),
  adapter_url: z.string().default("ws://127.0.0.1:9091/queue"),
  queue_count: z.coerce.number().int().min(1).max(64).default(4),
  sample_count: z.coerce.number().int().min(1).max(2048).default(24),
  alert_threshold_people: z.coerce.number().int().min(1).max(50000).default(75),
  active: z.boolean().default(false),
});

type ConnectQueueLengthBusArgs = z.infer<typeof connectQueueLengthBusSchema>;

function sourceNode(args: ConnectQueueLengthBusArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "http_json") {
    return {
      name: "queue_http_adapter",
      optype: "webclientDAT",
      x: 0,
      y: 120,
      params: { url: args.adapter_url, active: args.active ? 1 : 0 },
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_queue_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Paste queue metrics into queue_metrics.",
    };
  }
  return {
    name: "queue_ws_adapter",
    optype: "websocketDAT",
    x: 0,
    y: 120,
    params: { url: args.adapter_url, active: args.active ? 1 : 0 },
  };
}

function queueRows(args: ConnectQueueLengthBusArgs): string[][] {
  const rows = [["queue", "label", "people", "wait_minutes", "alert"]];
  for (let index = 1; index <= args.queue_count; index += 1) {
    rows.push([`queue_${index}`, args.queue_label, "0", "0", "false"]);
  }
  return rows;
}

function sampleRows(args: ConnectQueueLengthBusArgs): string[][] {
  const rows = [["sample", "queue", "people"]];
  for (let index = 1; index <= args.sample_count; index += 1) {
    rows.push([`sample_${index}`, `queue_${((index - 1) % args.queue_count) + 1}`, "0"]);
  }
  return rows;
}

export async function connectQueueLengthBusImpl(ctx: ToolContext, args: ConnectQueueLengthBusArgs) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "queue_length_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        queue_label: args.queue_label,
        adapter_mode: args.adapter_mode,
        adapter_url: args.adapter_url,
        queue_count: args.queue_count,
        sample_count: args.sample_count,
        alert_threshold_people: args.alert_threshold_people,
        active: args.active,
      },
      warnings: [
        "Queue estimation should be aggregate-only; keep raw video, device IDs, and person-level tracks out of TouchDesigner.",
        "Queue alerts are advisory display state, not evacuation or crowd-control authority.",
      ],
      nodes: [
        sourceNode(args),
        { name: "queue_metrics", optype: "tableDAT", x: 300, y: 120, table: queueRows(args) },
        { name: "sample_window", optype: "tableDAT", x: 600, y: 120, table: sampleRows(args) },
        {
          name: "alert_policy",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["queue_label", args.queue_label],
            ["alert_threshold_people", String(args.alert_threshold_people)],
            ["operator_required", "true"],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Normalize queue estimates in an adapter, then map queue_metrics to signage, dashboards, or show-safe ambience only.",
        },
      ],
    },
    "connect_queue_length_bus failed",
    (report) =>
      `Created queue-length bus ${report.container_path}; queues ${args.queue_count}; threshold ${args.alert_threshold_people}.`,
  );
}

export const registerConnectQueueLengthBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_queue_length_bus",
    {
      title: "Connect queue-length bus",
      description:
        "Create a queue-length scaffold with aggregate queue metrics, sample windows, adapter source, and alert policy notes.",
      inputSchema: connectQueueLengthBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectQueueLengthBusImpl(ctx, args),
  );
};
