import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const connectMaxMspBridgeSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the Max/MSP scaffold."),
  name: z.string().default("max_msp_bridge").describe("Generated baseCOMP name."),
  max_host: z.string().default("127.0.0.1").describe("Max/MSP OSC host."),
  send_port: z.coerce.number().int().min(1).max(65535).default(7400),
  receive_port: z.coerce.number().int().min(1).max(65535).default(7401),
  namespace: z.string().default("/tdmcp").describe("OSC namespace prefix."),
  channel_count: z.coerce.number().int().min(1).max(128).default(8),
  include_audio_features: z.boolean().default(true),
  active: z.boolean().default(false),
});

type ConnectMaxMspBridgeArgs = z.infer<typeof connectMaxMspBridgeSchema>;

function normalizeNamespace(namespace: string): string {
  const trimmed = namespace.trim().replace(/\/+$/g, "");
  if (!trimmed) return "/tdmcp";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function channelRows(args: ConnectMaxMspBridgeArgs, namespace: string): string[][] {
  const rows = [["channel", "address", "range", "direction"]];
  for (let index = 1; index <= args.channel_count; index += 1) {
    rows.push([`param_${index}`, `${namespace}/param/${index}`, "0..1", "td_to_max"]);
  }
  if (args.include_audio_features) {
    rows.push(["rms", `${namespace}/audio/rms`, "0..1", "max_to_td"]);
    rows.push(["centroid", `${namespace}/audio/centroid`, "hz", "max_to_td"]);
    rows.push(["onset", `${namespace}/audio/onset`, "pulse", "max_to_td"]);
  }
  return rows;
}

export async function connectMaxMspBridgeImpl(ctx: ToolContext, args: ConnectMaxMspBridgeArgs) {
  const namespace = normalizeNamespace(args.namespace);

  return runExternalShowScaffold(
    ctx,
    {
      kind: "max_msp_bridge",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        max_host: args.max_host,
        send_port: args.send_port,
        receive_port: args.receive_port,
        namespace,
        channel_count: args.channel_count,
        include_audio_features: args.include_audio_features,
        active: args.active,
      },
      warnings: [
        "This scaffold does not launch Max/MSP or install externals.",
        "Keep the OSC namespace stable across the Max patch and TouchDesigner bindings.",
      ],
      nodes: [
        {
          name: "osc_out",
          optype: "oscoutCHOP",
          x: 0,
          y: 120,
          params: { netaddress: args.max_host, port: args.send_port, active: args.active ? 1 : 0 },
        },
        {
          name: "osc_in",
          optype: "oscinCHOP",
          x: 0,
          y: -40,
          params: { port: args.receive_port, active: args.active ? 1 : 0 },
        },
        {
          name: "channel_map",
          optype: "tableDAT",
          x: 300,
          y: 120,
          table: channelRows(args, namespace),
        },
        {
          name: "audio_feature_map",
          optype: "tableDAT",
          x: 600,
          y: 120,
          table: [
            ["feature", "address", "enabled"],
            ["rms", `${namespace}/audio/rms`, String(args.include_audio_features)],
            ["centroid", `${namespace}/audio/centroid`, String(args.include_audio_features)],
            ["onset", `${namespace}/audio/onset`, String(args.include_audio_features)],
          ],
        },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["host", args.max_host],
            ["send_port", String(args.send_port)],
            ["receive_port", String(args.receive_port)],
            ["namespace", namespace],
            ["channel_count", String(args.channel_count)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Create matching udpsend/udpreceive or OSC-route objects in Max/MSP. Use channel_map as the contract and rehearse packet rates before performance.",
        },
      ],
    },
    "connect_max_msp_bridge failed",
    (report) =>
      `Created Max/MSP bridge ${report.container_path}; namespace ${namespace}; channels ${args.channel_count}.`,
  );
}

export const registerConnectMaxMspBridge: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_max_msp_bridge",
    {
      title: "Connect Max/MSP bridge",
      description:
        "Create a Max/MSP OSC bridge scaffold with parameter and audio-feature channel maps.",
      inputSchema: connectMaxMspBridgeSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectMaxMspBridgeImpl(ctx, args),
  );
};
