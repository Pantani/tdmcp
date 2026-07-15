import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectReplicatePredictionBridgeSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the Replicate scaffold."),
  name: z.string().default("replicate_prediction_bridge").describe("Generated baseCOMP name."),
  endpoint_url: z
    .string()
    .default("https://api.replicate.com/v1/predictions")
    .describe("Prediction endpoint or local adapter URL."),
  model_ref: z.string().default("owner/model:version").describe("Model/version reference hint."),
  request_mode: z.enum(["webclient_json", "webhook_adapter", "manual"]).default("webclient_json"),
  webhook_url: z.string().default("").describe("Optional webhook callback URL or adapter route."),
  poll_seconds: z.coerce.number().min(0.25).max(120).default(2),
  output_mode: z.enum(["image", "video", "json"]).default("image"),
  active: z.boolean().default(false),
});

type ConnectReplicatePredictionBridgeArgs = z.infer<typeof connectReplicatePredictionBridgeSchema>;

function sourceNode(args: ConnectReplicatePredictionBridgeArgs): ExternalShowNodeSpec {
  if (args.request_mode === "webhook_adapter") {
    return {
      name: "webhook_adapter",
      optype: "websocketDAT",
      x: 0,
      y: 120,
      params: { url: args.webhook_url || "ws://127.0.0.1:9020", active: args.active ? 1 : 0 },
    };
  }
  if (args.request_mode === "manual") {
    return {
      name: "manual_request",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Paste approved prediction requests into request_template.",
    };
  }
  return {
    name: "prediction_client",
    optype: "webclientDAT",
    x: 0,
    y: 120,
    params: { url: args.endpoint_url, reqmethod: "POST", active: args.active ? 1 : 0 },
  };
}

function requestRows(args: ConnectReplicatePredictionBridgeArgs): string[][] {
  return [
    ["field", "value"],
    ["model_ref", args.model_ref],
    ["request_mode", args.request_mode],
    ["webhook_url", args.webhook_url],
    ["poll_seconds", String(args.poll_seconds)],
    ["output_mode", args.output_mode],
  ];
}

function outputRows(args: ConnectReplicatePredictionBridgeArgs): string[][] {
  return [
    ["output", "role", "operator_action"],
    ["prediction_id", "job tracking", "copy from response"],
    ["status", "pending|processing|succeeded|failed", "poll or receive webhook"],
    ["result_url", `${args.output_mode} result`, "download/import manually or via adapter"],
  ];
}

export async function connectReplicatePredictionBridgeImpl(
  ctx: ToolContext,
  args: ConnectReplicatePredictionBridgeArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "replicate_prediction_bridge",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        endpoint_url: args.endpoint_url,
        model_ref: args.model_ref,
        request_mode: args.request_mode,
        webhook_url: args.webhook_url,
        poll_seconds: args.poll_seconds,
        output_mode: args.output_mode,
        active: args.active,
      },
      warnings: [
        "API tokens are intentionally not stored in this scaffold; keep credentials in an external adapter or TD-local secure config.",
        "Prediction submission, polling, webhook delivery, and media download are not validated offline.",
      ],
      nodes: [
        sourceNode(args),
        { name: "request_template", optype: "tableDAT", x: 300, y: 120, table: requestRows(args) },
        { name: "output_map", optype: "tableDAT", x: 600, y: 120, table: outputRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["endpoint_url", args.endpoint_url],
            ["model_ref", args.model_ref],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use request_template as the explicit request contract. Route result_url through a separate downloader/import adapter before binding generated media to visuals.",
        },
      ],
    },
    "connect_replicate_prediction_bridge failed",
    (report) =>
      `Created Replicate prediction bridge ${report.container_path}; model ${args.model_ref}; output ${args.output_mode}.`,
  );
}

export const registerConnectReplicatePredictionBridge: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_replicate_prediction_bridge",
    {
      title: "Connect Replicate prediction bridge",
      description:
        "Create a Replicate-style prediction handoff scaffold with request templates, polling/webhook maps, output contracts, and credential-safety notes.",
      inputSchema: connectReplicatePredictionBridgeSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectReplicatePredictionBridgeImpl(ctx, args),
  );
};
