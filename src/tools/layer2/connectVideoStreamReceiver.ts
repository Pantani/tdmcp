import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const connectVideoStreamReceiverSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP for the Video Stream In scaffold."),
  name: z.string().default("video_stream_receiver").describe("Generated baseCOMP name."),
  url: z.string().default("rtsp://127.0.0.1:8554/live"),
  mode: z.enum(["rtsp", "hls", "srt", "webrtc"]).default("rtsp"),
  latency_ms: z.coerce.number().int().min(0).max(10000).default(250),
  active: z.boolean().default(false),
});

type ConnectVideoStreamReceiverArgs = z.infer<typeof connectVideoStreamReceiverSchema>;

function streamRows(args: ConnectVideoStreamReceiverArgs): string[][] {
  return [
    ["field", "value"],
    ["mode", args.mode],
    ["url", args.url],
    ["latency_ms", String(args.latency_ms)],
    ["target_top", "stream_out"],
  ];
}

export async function connectVideoStreamReceiverImpl(
  ctx: ToolContext,
  args: ConnectVideoStreamReceiverArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "video_stream_receiver",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        url: args.url,
        mode: args.mode,
        latency_ms: args.latency_ms,
        active: args.active,
      },
      warnings: [
        "Network video ingest depends on codec, GPU/driver support, firewall rules, and stream server health.",
        "Keep receivers inactive until the target URL is trusted; public RTSP/HLS/SRT endpoints can expose credentials or unstable timing.",
      ],
      nodes: [
        {
          name: "stream_in",
          optype: "videostreaminTOP",
          x: 0,
          y: 120,
          params: { active: args.active ? 1 : 0, url: args.url, mode: args.mode },
        },
        { name: "stream_out", optype: "nullTOP", x: 300, y: 120 },
        { name: "stream_map", optype: "tableDAT", x: 300, y: -40, table: streamRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 600,
          y: 120,
          table: [
            ["field", "value"],
            ["mode", args.mode],
            ["latency_ms", String(args.latency_ms)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use stream_in for RTSP/HLS/SRT/WebRTC ingest, then feed stream_out into preview or analysis chains only after codec and latency are verified.",
        },
      ],
      connections: [{ from: "stream_in", to: "stream_out" }],
    },
    "connect_video_stream_receiver failed",
    (report) =>
      `Created video stream receiver ${report.container_path}; mode ${args.mode}; url ${args.url}.`,
  );
}

export const registerConnectVideoStreamReceiver: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_video_stream_receiver",
    {
      title: "Connect video stream receiver",
      description:
        "Create a Video Stream In TOP scaffold for RTSP, HLS, SRT, or WebRTC ingest with stream maps and setup notes.",
      inputSchema: connectVideoStreamReceiverSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectVideoStreamReceiverImpl(ctx, args),
  );
};
