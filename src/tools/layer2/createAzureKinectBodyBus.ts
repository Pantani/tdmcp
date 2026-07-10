import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const createAzureKinectBodyBusSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP for the Azure Kinect scaffold."),
  name: z.string().default("azure_kinect_body_bus").describe("Generated baseCOMP name."),
  device_index: z.coerce.number().int().min(0).max(16).default(0),
  body_count: z.coerce.number().int().min(1).max(32).default(2),
  include_depth_top: z.boolean().default(true),
  include_color_top: z.boolean().default(true),
  active: z.boolean().default(false),
});

type CreateAzureKinectBodyBusArgs = z.infer<typeof createAzureKinectBodyBusSchema>;

function bodyRows(args: CreateAzureKinectBodyBusArgs): string[][] {
  const rows = [["body", "joint_prefix", "confidence_channel"]];
  for (let body = 0; body < args.body_count; body += 1) {
    rows.push([String(body), `body${body}_joint_`, `body${body}_confidence`]);
  }
  return rows;
}

function streamRows(args: CreateAzureKinectBodyBusArgs): string[][] {
  const rows = [["stream", "operator", "enabled"]];
  rows.push(["skeleton", "kinectazureCHOP", String(args.active)]);
  if (args.include_depth_top) rows.push(["depth", "kinectazureTOP", String(args.active)]);
  if (args.include_color_top) rows.push(["color", "kinectazureTOP", String(args.active)]);
  return rows;
}

export async function createAzureKinectBodyBusImpl(
  ctx: ToolContext,
  args: CreateAzureKinectBodyBusArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "azure_kinect_body_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        device_index: args.device_index,
        body_count: args.body_count,
        include_depth_top: args.include_depth_top,
        include_color_top: args.include_color_top,
        active: args.active,
      },
      warnings: [
        "Azure Kinect operators are hardware/driver gated and may require Windows-specific setup.",
        "Run live calibration before binding body channels to show cues or projection surfaces.",
      ],
      nodes: [
        {
          name: "kinect_chop",
          optype: "kinectazureCHOP",
          x: 0,
          y: 120,
          params: { active: args.active ? 1 : 0, device: args.device_index },
        },
        ...(args.include_depth_top
          ? [
              {
                name: "kinect_depth_top",
                optype: "kinectazureTOP",
                x: 0,
                y: -40,
                params: { active: args.active ? 1 : 0, device: args.device_index, image: "depth" },
              },
            ]
          : []),
        ...(args.include_color_top
          ? [
              {
                name: "kinect_color_top",
                optype: "kinectazureTOP",
                x: 0,
                y: -200,
                params: { active: args.active ? 1 : 0, device: args.device_index, image: "color" },
              },
            ]
          : []),
        { name: "body_map", optype: "tableDAT", x: 300, y: 120, table: bodyRows(args) },
        { name: "stream_map", optype: "tableDAT", x: 600, y: 120, table: streamRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["device_index", String(args.device_index)],
            ["body_count", String(args.body_count)],
            ["include_depth_top", String(args.include_depth_top)],
            ["include_color_top", String(args.include_color_top)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use this Azure Kinect bus as a calibrated body/depth source. Confirm SDK, camera permissions, skeleton quality, and depth alignment before show bindings.",
        },
      ],
    },
    "create_azure_kinect_body_bus failed",
    (report) =>
      `Created Azure Kinect body bus ${report.container_path}; bodies ${args.body_count}; device ${args.device_index}.`,
  );
}

export const registerCreateAzureKinectBodyBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_azure_kinect_body_bus",
    {
      title: "Create Azure Kinect body bus",
      description:
        "Create an Azure Kinect body/depth scaffold with Kinect Azure TOP/CHOP placeholders, stream maps, and calibration notes.",
      inputSchema: createAzureKinectBodyBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createAzureKinectBodyBusImpl(ctx, args),
  );
};
