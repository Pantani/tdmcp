import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const connectWebrtcBrowserInputSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the WebRTC scaffold."),
  name: z.string().default("webrtc_browser_input").describe("Generated baseCOMP name."),
  signaling_url: z.string().default("ws://127.0.0.1:8787"),
  room_id: z.string().default("tdmcp"),
  input_mode: z.enum(["webcam", "screen", "pointer", "sensors", "mixed"]).default("mixed"),
  include_data_channels: z.boolean().default(true),
  active: z.boolean().default(false),
});

type ConnectWebrtcBrowserInputArgs = z.infer<typeof connectWebrtcBrowserInputSchema>;

function dataRows(args: ConnectWebrtcBrowserInputArgs): string[][] {
  const rows = [["channel", "payload", "enabled"]];
  rows.push([
    "pointer",
    "x y buttons pressure",
    String(args.input_mode === "pointer" || args.input_mode === "mixed"),
  ]);
  rows.push([
    "orientation",
    "alpha beta gamma accel",
    String(args.input_mode === "sensors" || args.input_mode === "mixed"),
  ]);
  rows.push(["control", "json commands", String(args.include_data_channels)]);
  return rows;
}

export async function connectWebrtcBrowserInputImpl(
  ctx: ToolContext,
  args: ConnectWebrtcBrowserInputArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "webrtc_browser_input",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        signaling_url: args.signaling_url,
        room_id: args.room_id,
        input_mode: args.input_mode,
        include_data_channels: args.include_data_channels,
        active: args.active,
      },
      warnings: [
        "This scaffold does not implement a WebRTC peer inside TouchDesigner.",
        "Use an external browser/signaling app to provide media and data-channel payloads.",
      ],
      nodes: [
        {
          name: "signaling_config",
          optype: "textDAT",
          x: 0,
          y: 120,
          text: JSON.stringify(
            {
              signaling_url: args.signaling_url,
              room_id: args.room_id,
              input_mode: args.input_mode,
              active: args.active,
            },
            null,
            2,
          ),
        },
        { name: "data_channel_map", optype: "tableDAT", x: 300, y: 120, table: dataRows(args) },
        {
          name: "media_handoff",
          optype: "textDAT",
          x: 600,
          y: 120,
          text: "Route browser webcam/screen media into TD through NDI, Spout/Syphon, virtual camera, or a custom WebRTC receiver adapter.",
        },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["signaling_url", args.signaling_url],
            ["room_id", args.room_id],
            ["input_mode", args.input_mode],
            ["include_data_channels", String(args.include_data_channels)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Run a browser capture/signaling app externally. Use data_channel_map as the data contract and rehearse latency/privacy prompts before opening audience input.",
        },
      ],
    },
    "connect_webrtc_browser_input failed",
    (report) =>
      `Created WebRTC browser input scaffold ${report.container_path}; room ${args.room_id}; mode ${args.input_mode}.`,
  );
}

export const registerConnectWebrtcBrowserInput: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_webrtc_browser_input",
    {
      title: "Connect WebRTC browser input",
      description:
        "Create a browser/WebRTC input scaffold for webcam, screen, pointer, and sensor data supplied by an external signaling app.",
      inputSchema: connectWebrtcBrowserInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectWebrtcBrowserInputImpl(ctx, args),
  );
};
