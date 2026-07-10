import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectPrometheusMetricsPanelSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the Prometheus scaffold."),
  name: z.string().default("prometheus_metrics_panel").describe("Generated baseCOMP name."),
  endpoint_url: z.string().default("http://127.0.0.1:9090"),
  job_name: z.string().default("tdmcp-show"),
  adapter_mode: z
    .enum(["webclient_promql", "websocket_json", "manual"])
    .default("webclient_promql"),
  metric_count: z.coerce.number().int().min(1).max(256).default(12),
  alert_count: z.coerce.number().int().min(0).max(128).default(4),
  scrape_interval_seconds: z.coerce.number().min(1).max(3600).default(15),
  active: z.boolean().default(false),
});

type ConnectPrometheusMetricsPanelArgs = z.infer<typeof connectPrometheusMetricsPanelSchema>;

function sourceNode(args: ConnectPrometheusMetricsPanelArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "websocket_json") {
    return {
      name: "prometheus_ws_adapter",
      optype: "websocketDAT",
      x: 0,
      y: 120,
      params: { url: args.endpoint_url, active: args.active ? 1 : 0 },
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_prometheus_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Paste normalized Prometheus query results into metric_map.",
    };
  }
  return {
    name: "promql_client",
    optype: "webclientDAT",
    x: 0,
    y: 120,
    params: { url: args.endpoint_url, active: args.active ? 1 : 0 },
  };
}

function metricRows(args: ConnectPrometheusMetricsPanelArgs): string[][] {
  const rows = [["metric", "promql_hint", "show_binding"]];
  for (let index = 1; index <= args.metric_count; index += 1) {
    rows.push([`metric_${index}`, `${args.job_name}_metric_${index}`, `metric_${index}`]);
  }
  return rows;
}

function alertRows(args: ConnectPrometheusMetricsPanelArgs): string[][] {
  const rows = [["alert", "severity", "route"]];
  for (let index = 1; index <= args.alert_count; index += 1) {
    rows.push([`alert_${index}`, index === 1 ? "critical" : "warning", "operator_dashboard"]);
  }
  if (args.alert_count === 0) {
    rows.push(["none", "not_configured", "operator_dashboard"]);
  }
  return rows;
}

export async function connectPrometheusMetricsPanelImpl(
  ctx: ToolContext,
  args: ConnectPrometheusMetricsPanelArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "prometheus_metrics_panel",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        endpoint_url: args.endpoint_url,
        job_name: args.job_name,
        adapter_mode: args.adapter_mode,
        metric_count: args.metric_count,
        alert_count: args.alert_count,
        scrape_interval_seconds: args.scrape_interval_seconds,
        active: args.active,
      },
      warnings: [
        "This scaffold does not scrape targets, run PromQL, or validate Prometheus reachability.",
        "Alert routes should inform operators; do not let metrics alone trigger hazardous show actions.",
      ],
      nodes: [
        sourceNode(args),
        { name: "metric_map", optype: "tableDAT", x: 300, y: 120, table: metricRows(args) },
        { name: "alert_routes", optype: "tableDAT", x: 600, y: 120, table: alertRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["endpoint_url", args.endpoint_url],
            ["job_name", args.job_name],
            ["scrape_interval_seconds", String(args.scrape_interval_seconds)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Normalize PromQL responses into metric_map rows. Keep alert evaluation and incident routing in a monitoring adapter or operator dashboard.",
        },
      ],
    },
    "connect_prometheus_metrics_panel failed",
    (report) =>
      `Created Prometheus metrics panel ${report.container_path}; metrics ${args.metric_count}; alerts ${args.alert_count}.`,
  );
}

export const registerConnectPrometheusMetricsPanel: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_prometheus_metrics_panel",
    {
      title: "Connect Prometheus metrics panel",
      description:
        "Create a Prometheus metrics scaffold with PromQL/client adapter notes, metric maps, alert routes, and operator-dashboard safety guidance.",
      inputSchema: connectPrometheusMetricsPanelSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectPrometheusMetricsPanelImpl(ctx, args),
  );
};
