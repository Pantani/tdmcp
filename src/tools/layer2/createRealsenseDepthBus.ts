import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowConnectionSpec,
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const createRealsenseDepthBusSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP for the RealSense depth scaffold."),
  name: z.string().default("realsense_depth_bus").describe("Generated baseCOMP name."),
  source_mode: z
    .enum(["realsense_top", "ndi_depth", "websocket_json", "sample"])
    .default("realsense_top"),
  serial_number: z.string().default("").describe("Optional RealSense camera serial number."),
  ndi_source: z.string().default("RealSense Depth").describe("NDI source name for depth input."),
  server_url: z.string().default("ws://127.0.0.1:9015").describe("Adapter WebSocket URL."),
  resolution: z.enum(["640x480", "848x480", "1280x720"]).default("848x480"),
  include_color: z.boolean().default(true),
  include_pointcloud: z.boolean().default(true),
  active: z.boolean().default(false),
});

type CreateRealsenseDepthBusArgs = z.infer<typeof createRealsenseDepthBusSchema>;

function resolutionRows(args: CreateRealsenseDepthBusArgs): string[][] {
  const [width = "848", height = "480"] = args.resolution.split("x");
  return [
    ["field", "value"],
    ["source_mode", args.source_mode],
    ["width", width],
    ["height", height],
    ["include_color", String(args.include_color)],
    ["include_pointcloud", String(args.include_pointcloud)],
  ];
}

function channelRows(args: CreateRealsenseDepthBusArgs): string[][] {
  const rows = [["output", "role", "validation"]];
  rows.push(["depth_out", "normalized_depth_top", "confirm near/far range and units"]);
  if (args.include_color) {
    rows.push(["color_out", "color_reference_top", "confirm registration with depth"]);
  }
  if (args.include_pointcloud) {
    rows.push(["pointcloud_map", "xyz_schema", "confirm metric scale and handedness"]);
  }
  return rows;
}

function sourceNode(args: CreateRealsenseDepthBusArgs): ExternalShowNodeSpec {
  if (args.source_mode === "ndi_depth") {
    return {
      name: "depth_source",
      optype: "ndiinTOP",
      x: 0,
      y: 120,
      params: { sourcename: args.ndi_source, active: args.active ? 1 : 0 },
    };
  }
  if (args.source_mode === "websocket_json") {
    return {
      name: "depth_adapter_ws",
      optype: "websocketDAT",
      x: 0,
      y: 120,
      params: { url: args.server_url, active: args.active ? 1 : 0 },
    };
  }
  if (args.source_mode === "sample") {
    return {
      name: "depth_source",
      optype: "noiseTOP",
      x: 0,
      y: 120,
      params: { outputresolution: "custom", resolutionw: 848, resolutionh: 480 },
    };
  }
  return {
    name: "depth_source",
    optype: "realsenseTOP",
    x: 0,
    y: 120,
    params: {
      active: args.active ? 1 : 0,
      serialnumber: args.serial_number,
      outputresolution: "custom",
    },
  };
}

function connections(args: CreateRealsenseDepthBusArgs): ExternalShowConnectionSpec[] {
  if (args.source_mode === "websocket_json") {
    return [];
  }
  return [{ from: "depth_source", to: "depth_out" }];
}

export async function createRealsenseDepthBusImpl(
  ctx: ToolContext,
  args: CreateRealsenseDepthBusArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "realsense_depth_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        source_mode: args.source_mode,
        serial_number: args.serial_number,
        ndi_source: args.ndi_source,
        server_url: args.server_url,
        resolution: args.resolution,
        include_color: args.include_color,
        include_pointcloud: args.include_pointcloud,
        active: args.active,
      },
      warnings: [
        "RealSense SDK/runtime availability and camera calibration are not validated by this scaffold.",
        "Depth scale, near/far clipping, and color-depth registration must be verified live before show use.",
      ],
      nodes: [
        sourceNode(args),
        { name: "depth_out", optype: "nullTOP", x: 300, y: 120 },
        {
          name: "color_out",
          optype: args.include_color ? "nullTOP" : "textDAT",
          x: 300,
          y: -40,
          text: args.include_color ? undefined : "Color output disabled for this scaffold.",
        },
        {
          name: "pointcloud_map",
          optype: "tableDAT",
          x: 600,
          y: 120,
          table: channelRows(args),
        },
        { name: "stream_config", optype: "tableDAT", x: 600, y: -40, table: resolutionRows(args) },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 900,
          y: 120,
          text: "Use depth_out as the normalized depth TOP. When using a WebSocket adapter, parse frames into depth/color TOPs explicitly before downstream binding.",
        },
      ],
      connections: connections(args),
    },
    "create_realsense_depth_bus failed",
    (report) =>
      `Created RealSense depth bus ${report.container_path}; source ${args.source_mode}; resolution ${args.resolution}.`,
  );
}

export const registerCreateRealsenseDepthBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_realsense_depth_bus",
    {
      title: "Create RealSense depth bus",
      description:
        "Create an Intel RealSense depth-camera scaffold with RealSense TOP, NDI, WebSocket adapter, or sample-source modes plus depth/color/point-cloud routing notes.",
      inputSchema: createRealsenseDepthBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createRealsenseDepthBusImpl(ctx, args),
  );
};
