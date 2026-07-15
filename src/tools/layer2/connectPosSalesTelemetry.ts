import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectPosSalesTelemetrySchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the POS scaffold."),
  name: z.string().default("pos_sales_telemetry").describe("Generated baseCOMP name."),
  provider: z.enum(["square", "stripe_terminal", "toast", "custom"]).default("square"),
  store_label: z.string().default("venue_bar"),
  adapter_mode: z.enum(["rest_json", "webhook_json", "manual"]).default("rest_json"),
  adapter_url: z.string().default("http://127.0.0.1:9068/pos"),
  aggregation_window: z.enum(["1m", "5m", "15m", "1h"]).default("5m"),
  metric_count: z.coerce.number().int().min(1).max(128).default(8),
  revenue_bucket_count: z.coerce.number().int().min(1).max(64).default(6),
  active: z.boolean().default(false),
});

type ConnectPosSalesTelemetryArgs = z.infer<typeof connectPosSalesTelemetrySchema>;

function sourceNode(args: ConnectPosSalesTelemetryArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "webhook_json") {
    return {
      name: "pos_ws_adapter",
      optype: "websocketDAT",
      x: 0,
      y: 120,
      params: { url: args.adapter_url, active: args.active ? 1 : 0 },
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_pos_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Paste aggregate POS rows into sales_metrics.",
    };
  }
  return {
    name: "pos_client",
    optype: "webclientDAT",
    x: 0,
    y: 120,
    params: { url: args.adapter_url, active: args.active ? 1 : 0 },
  };
}

function metricRows(args: ConnectPosSalesTelemetryArgs): string[][] {
  const rows = [["metric", "store_label", "window", "value", "privacy"]];
  for (let index = 1; index <= args.metric_count; index += 1) {
    rows.push([
      `metric_${index}`,
      args.store_label,
      args.aggregation_window,
      "0",
      "aggregate_only",
    ]);
  }
  return rows;
}

function bucketRows(args: ConnectPosSalesTelemetryArgs): string[][] {
  const rows = [["bucket", "min", "max", "count"]];
  for (let index = 1; index <= args.revenue_bucket_count; index += 1) {
    rows.push([`bucket_${index}`, String((index - 1) * 25), String(index * 25), "0"]);
  }
  return rows;
}

export async function connectPosSalesTelemetryImpl(
  ctx: ToolContext,
  args: ConnectPosSalesTelemetryArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "pos_sales_telemetry",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        provider: args.provider,
        store_label: args.store_label,
        adapter_mode: args.adapter_mode,
        adapter_url: args.adapter_url,
        aggregation_window: args.aggregation_window,
        metric_count: args.metric_count,
        revenue_bucket_count: args.revenue_bucket_count,
        active: args.active,
      },
      warnings: [
        "Payment credentials, card data, customer identifiers, and transaction-level records are intentionally external to this scaffold.",
        "Use only aggregate metrics or coarse buckets in TouchDesigner; keep PCI scope outside the show network.",
      ],
      nodes: [
        sourceNode(args),
        { name: "sales_metrics", optype: "tableDAT", x: 300, y: 120, table: metricRows(args) },
        {
          name: "revenue_buckets",
          optype: "tableDAT",
          x: 600,
          y: 120,
          table: bucketRows(args),
        },
        {
          name: "privacy_policy",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["store_label", args.store_label],
            ["aggregation_window", args.aggregation_window],
            ["allowed_detail", "aggregate_only"],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Run POS integrations in an adapter that strips card, customer, and transaction identifiers. TouchDesigner consumes only aggregate sales telemetry.",
        },
      ],
    },
    "connect_pos_sales_telemetry failed",
    (report) =>
      `Created POS sales telemetry ${report.container_path}; metrics ${args.metric_count}; provider ${args.provider}.`,
  );
}

export const registerConnectPosSalesTelemetry: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_pos_sales_telemetry",
    {
      title: "Connect POS sales telemetry",
      description:
        "Create a POS aggregate-telemetry scaffold with sales metrics, revenue buckets, privacy policy, adapter source, and PCI/PII safety notes.",
      inputSchema: connectPosSalesTelemetrySchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectPosSalesTelemetryImpl(ctx, args),
  );
};
