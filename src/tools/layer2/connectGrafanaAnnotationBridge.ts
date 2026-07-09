import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectGrafanaAnnotationBridgeSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the Grafana scaffold."),
  name: z.string().default("grafana_annotation_bridge").describe("Generated baseCOMP name."),
  base_url: z.string().default("http://127.0.0.1:3000"),
  dashboard_uid: z.string().default("show-dashboard"),
  adapter_mode: z.enum(["webclient_json", "websocket_json", "manual"]).default("webclient_json"),
  panel_count: z.coerce.number().int().min(1).max(128).default(6),
  tag_count: z.coerce.number().int().min(1).max(64).default(4),
  active: z.boolean().default(false),
});

type ConnectGrafanaAnnotationBridgeArgs = z.infer<typeof connectGrafanaAnnotationBridgeSchema>;

function sourceNode(args: ConnectGrafanaAnnotationBridgeArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "websocket_json") {
    return {
      name: "grafana_ws_adapter",
      optype: "websocketDAT",
      x: 0,
      y: 120,
      params: { url: args.base_url, active: args.active ? 1 : 0 },
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_annotation_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Copy approved annotation payloads from annotation_map into your Grafana adapter.",
    };
  }
  return {
    name: "grafana_client",
    optype: "webclientDAT",
    x: 0,
    y: 120,
    params: { url: args.base_url, reqmethod: "POST", active: args.active ? 1 : 0 },
  };
}

function panelRows(args: ConnectGrafanaAnnotationBridgeArgs): string[][] {
  const rows = [["panel", "dashboard_uid", "purpose"]];
  for (let index = 1; index <= args.panel_count; index += 1) {
    rows.push([`panel_${index}`, args.dashboard_uid, index === 1 ? "show_state" : "telemetry"]);
  }
  return rows;
}

function tagRows(args: ConnectGrafanaAnnotationBridgeArgs): string[][] {
  const rows = [["tag", "meaning"]];
  for (let index = 1; index <= args.tag_count; index += 1) {
    rows.push([`tdmcp_tag_${index}`, "operator event marker"]);
  }
  return rows;
}

export async function connectGrafanaAnnotationBridgeImpl(
  ctx: ToolContext,
  args: ConnectGrafanaAnnotationBridgeArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "grafana_annotation_bridge",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        base_url: args.base_url,
        dashboard_uid: args.dashboard_uid,
        adapter_mode: args.adapter_mode,
        panel_count: args.panel_count,
        tag_count: args.tag_count,
        active: args.active,
      },
      warnings: [
        "Grafana API tokens are intentionally not stored in this scaffold.",
        "Annotation creation should be rate-limited and operator-visible; do not use it as a hidden control channel.",
      ],
      nodes: [
        sourceNode(args),
        { name: "panel_map", optype: "tableDAT", x: 300, y: 120, table: panelRows(args) },
        { name: "tag_map", optype: "tableDAT", x: 600, y: 120, table: tagRows(args) },
        {
          name: "annotation_map",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["dashboard_uid", args.dashboard_uid],
            ["base_url", args.base_url],
            ["adapter_mode", args.adapter_mode],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use annotation_map as the explicit event-marker contract. Keep auth headers, dashboard lookup, retries, and rate limits in an adapter.",
        },
      ],
    },
    "connect_grafana_annotation_bridge failed",
    (report) =>
      `Created Grafana annotation bridge ${report.container_path}; panels ${args.panel_count}; tags ${args.tag_count}.`,
  );
}

export const registerConnectGrafanaAnnotationBridge: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_grafana_annotation_bridge",
    {
      title: "Connect Grafana annotation bridge",
      description:
        "Create a Grafana annotation/event-marker scaffold with dashboard, panel, tag, and annotation maps plus token-safety notes.",
      inputSchema: connectGrafanaAnnotationBridgeSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectGrafanaAnnotationBridgeImpl(ctx, args),
  );
};
