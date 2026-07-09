import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectSlackOpsBridgeSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the Slack ops scaffold."),
  name: z.string().default("slack_ops_bridge").describe("Generated baseCOMP name."),
  workspace_label: z.string().default("venue_workspace"),
  channel_name: z.string().default("#show-ops"),
  adapter_mode: z.enum(["incoming_webhook", "socket_mode", "manual"]).default("incoming_webhook"),
  adapter_url: z.string().default("http://127.0.0.1:9064/slack"),
  alert_count: z.coerce.number().int().min(1).max(128).default(8),
  command_count: z.coerce.number().int().min(0).max(128).default(4),
  approval_required: z.boolean().default(true),
  active: z.boolean().default(false),
});

type ConnectSlackOpsBridgeArgs = z.infer<typeof connectSlackOpsBridgeSchema>;

function sourceNode(args: ConnectSlackOpsBridgeArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "socket_mode") {
    return {
      name: "slack_socket_adapter",
      optype: "websocketDAT",
      x: 0,
      y: 120,
      params: { url: args.adapter_url, active: args.active ? 1 : 0 },
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_slack_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Copy operator-visible alert rows from alert_map into your Slack workflow.",
    };
  }
  return {
    name: "slack_webhook_client",
    optype: "webclientDAT",
    x: 0,
    y: 120,
    params: { url: args.adapter_url, reqmethod: "POST", active: args.active ? 1 : 0 },
  };
}

function alertRows(args: ConnectSlackOpsBridgeArgs): string[][] {
  const rows = [["alert", "channel", "severity", "message_template"]];
  const severities = ["info", "warning", "critical"];
  for (let index = 1; index <= args.alert_count; index += 1) {
    rows.push([
      `alert_${index}`,
      args.channel_name,
      severities[(index - 1) % severities.length] ?? "info",
      `Show alert ${index}: {{state}}`,
    ]);
  }
  return rows;
}

function commandRows(args: ConnectSlackOpsBridgeArgs): string[][] {
  const rows = [["command", "channel", "policy"]];
  if (args.command_count === 0) {
    rows.push(["none", args.channel_name, "alerts_only"]);
    return rows;
  }
  for (let index = 1; index <= args.command_count; index += 1) {
    rows.push([
      `/tdmcp_${index}`,
      args.channel_name,
      args.approval_required ? "approval_required" : "adapter_gated",
    ]);
  }
  return rows;
}

export async function connectSlackOpsBridgeImpl(ctx: ToolContext, args: ConnectSlackOpsBridgeArgs) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "slack_ops_bridge",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        workspace_label: args.workspace_label,
        channel_name: args.channel_name,
        adapter_mode: args.adapter_mode,
        adapter_url: args.adapter_url,
        alert_count: args.alert_count,
        command_count: args.command_count,
        approval_required: args.approval_required,
        active: args.active,
      },
      warnings: [
        "Slack bot tokens, signing secrets, channel lookup, rate limits, and Socket Mode details are intentionally external to this scaffold.",
        "Inbound commands must stay approval-gated; do not route Slack text directly into physical show-control actions.",
      ],
      nodes: [
        sourceNode(args),
        { name: "alert_map", optype: "tableDAT", x: 300, y: 120, table: alertRows(args) },
        { name: "command_map", optype: "tableDAT", x: 600, y: 120, table: commandRows(args) },
        {
          name: "ops_policy",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["workspace_label", args.workspace_label],
            ["channel_name", args.channel_name],
            ["approval_required", String(args.approval_required)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use Slack only as an operator-visible alert and approval surface. Token validation, slash-command verification, and rate limits belong in the adapter.",
        },
      ],
    },
    "connect_slack_ops_bridge failed",
    (report) =>
      `Created Slack ops bridge ${report.container_path}; alerts ${args.alert_count}; commands ${args.command_count}.`,
  );
}

export const registerConnectSlackOpsBridge: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_slack_ops_bridge",
    {
      title: "Connect Slack ops bridge",
      description:
        "Create a Slack operator-alert scaffold with webhook/socket adapter, alert rows, approval-gated command rows, and token/signing safety notes.",
      inputSchema: connectSlackOpsBridgeSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectSlackOpsBridgeImpl(ctx, args),
  );
};
