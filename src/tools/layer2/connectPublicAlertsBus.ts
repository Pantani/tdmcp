import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectPublicAlertsBusSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the alert scaffold."),
  name: z.string().default("public_alerts_bus").describe("Generated baseCOMP name."),
  provider: z.enum(["cap_feed", "nws_alerts", "municipal_rss", "custom"]).default("cap_feed"),
  region_label: z.string().default("venue_region"),
  adapter_mode: z.enum(["rest_json", "websocket_json", "manual"]).default("rest_json"),
  adapter_url: z.string().default("http://127.0.0.1:9076/alerts"),
  alert_count: z.coerce.number().int().min(1).max(1024).default(8),
  severity_count: z.coerce.number().int().min(1).max(16).default(4),
  route_count: z.coerce.number().int().min(1).max(64).default(3),
  active: z.boolean().default(false),
});

type ConnectPublicAlertsBusArgs = z.infer<typeof connectPublicAlertsBusSchema>;

function sourceNode(args: ConnectPublicAlertsBusArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "websocket_json") {
    return {
      name: "alerts_ws_adapter",
      optype: "websocketDAT",
      x: 0,
      y: 120,
      params: { url: args.adapter_url, active: args.active ? 1 : 0 },
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_alert_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Paste advisory alert rows into alert_map.",
    };
  }
  return {
    name: "alerts_client",
    optype: "webclientDAT",
    x: 0,
    y: 120,
    params: { url: args.adapter_url, active: args.active ? 1 : 0 },
  };
}

function alertRows(args: ConnectPublicAlertsBusArgs): string[][] {
  const rows = [["alert", "region", "severity", "status"]];
  for (let index = 1; index <= args.alert_count; index += 1) {
    rows.push([
      `alert_${index}`,
      args.region_label,
      `severity_${((index - 1) % args.severity_count) + 1}`,
      "advisory",
    ]);
  }
  return rows;
}

function severityRows(args: ConnectPublicAlertsBusArgs): string[][] {
  const rows = [["severity", "rank", "operator_policy"]];
  for (let index = 1; index <= args.severity_count; index += 1) {
    rows.push([`severity_${index}`, String(index), index >= 3 ? "operator_visible" : "display"]);
  }
  return rows;
}

function routeRows(args: ConnectPublicAlertsBusArgs): string[][] {
  const rows = [["route", "target", "policy"]];
  for (let index = 1; index <= args.route_count; index += 1) {
    rows.push([`route_${index}`, index === 1 ? "dashboard" : "overlay", "advisory_only"]);
  }
  return rows;
}

export async function connectPublicAlertsBusImpl(
  ctx: ToolContext,
  args: ConnectPublicAlertsBusArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "public_alerts_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        provider: args.provider,
        region_label: args.region_label,
        adapter_mode: args.adapter_mode,
        adapter_url: args.adapter_url,
        alert_count: args.alert_count,
        severity_count: args.severity_count,
        route_count: args.route_count,
        active: args.active,
      },
      warnings: [
        "CAP/XML parsing, feed auth, duplicate suppression, localization, and operator escalation are intentionally external to this scaffold.",
        "Public alerts are advisory in this scaffold; venue safety actions require explicit human policy.",
      ],
      nodes: [
        sourceNode(args),
        { name: "alert_map", optype: "tableDAT", x: 300, y: 120, table: alertRows(args) },
        { name: "severity_map", optype: "tableDAT", x: 600, y: 120, table: severityRows(args) },
        { name: "routing_policy", optype: "tableDAT", x: 300, y: -40, table: routeRows(args) },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Normalize public-alert feeds in an adapter. TouchDesigner consumes advisory alert rows, severity maps, and visible routing policy.",
        },
      ],
    },
    "connect_public_alerts_bus failed",
    (report) =>
      `Created public alerts bus ${report.container_path}; alerts ${args.alert_count}; provider ${args.provider}.`,
  );
}

export const registerConnectPublicAlertsBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_public_alerts_bus",
    {
      title: "Connect public alerts bus",
      description:
        "Create a public-alert scaffold with advisory alert rows, severity maps, routing policy, adapter source, and safety/escalation notes.",
      inputSchema: connectPublicAlertsBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectPublicAlertsBusImpl(ctx, args),
  );
};
