import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const createZedDepthBusSchema = z
  .object({
    parent_path: z.string().default("/project1").describe("Parent COMP for the ZED scaffold."),
    name: z.string().default("zed_depth_bus").describe("Generated baseCOMP name."),
    camera_index: z.coerce.number().int().min(0).max(16).default(0),
    stream_count: z.coerce.number().int().min(1).max(16).default(3),
    body_count: z.coerce.number().int().min(0).max(32).default(1),
    include_pointcloud: z.boolean().default(true),
    active: z.boolean().default(false),
  })
  .refine((value) => value.stream_count >= (value.include_pointcloud ? 3 : 2), {
    path: ["stream_count"],
    message:
      "stream_count must include the generated color/depth streams and pointcloud when enabled.",
  });

type CreateZedDepthBusArgs = z.infer<typeof createZedDepthBusSchema>;

function streamRows(args: CreateZedDepthBusArgs): string[][] {
  const rows = [["stream", "operator", "purpose"]];
  rows.push(["left_or_color", "zedTOP", "camera texture"]);
  rows.push(["depth", "zedTOP", "depth texture"]);
  if (args.include_pointcloud) rows.push(["pointcloud", "zedSOP", "3D points"]);
  for (let index = rows.length; index <= args.stream_count; index += 1) {
    rows.push([`aux_${index}`, "zedCHOP", "custom ZED stream"]);
  }
  return rows;
}

function bodyRows(args: CreateZedDepthBusArgs): string[][] {
  const rows = [["body", "channel_prefix", "purpose"]];
  for (let body = 0; body < args.body_count; body += 1) {
    rows.push([String(body), `zed_body_${body}_`, "body tracking"]);
  }
  return rows;
}

export async function createZedDepthBusImpl(ctx: ToolContext, args: CreateZedDepthBusArgs) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "zed_depth_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        camera_index: args.camera_index,
        stream_count: args.stream_count,
        body_count: args.body_count,
        include_pointcloud: args.include_pointcloud,
        active: args.active,
      },
      warnings: [
        "ZED TouchDesigner operators are Windows/driver gated; this scaffold does not validate a live camera.",
        "Depth/body channels require live calibration before they drive projection, robotics, or physical outputs.",
      ],
      nodes: [
        {
          name: "zed_top",
          optype: "zedTOP",
          x: 0,
          y: 160,
          params: { active: args.active ? 1 : 0, camera: args.camera_index },
        },
        {
          name: "zed_chop",
          optype: "zedCHOP",
          x: 0,
          y: 0,
          params: { active: args.active ? 1 : 0, camera: args.camera_index },
        },
        ...(args.include_pointcloud
          ? [
              {
                name: "zed_sop",
                optype: "zedSOP",
                x: 0,
                y: -160,
                params: { active: args.active ? 1 : 0 },
              },
            ]
          : []),
        { name: "stream_map", optype: "tableDAT", x: 300, y: 120, table: streamRows(args) },
        { name: "body_map", optype: "tableDAT", x: 600, y: 120, table: bodyRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["camera_index", String(args.camera_index)],
            ["stream_count", String(args.stream_count)],
            ["body_count", String(args.body_count)],
            ["include_pointcloud", String(args.include_pointcloud)],
            ["active", String(args.active)],
          ],
        },
      ],
    },
    "create_zed_depth_bus failed",
    (report) =>
      `Created ZED depth bus ${report.container_path}; streams ${args.stream_count}; bodies ${args.body_count}.`,
  );
}

export const registerCreateZedDepthBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_zed_depth_bus",
    {
      title: "Create ZED depth bus",
      description:
        "Create a ZED camera depth/body/point-cloud scaffold with ZED TOP/CHOP/SOP placeholders and runtime-gated warnings.",
      inputSchema: createZedDepthBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createZedDepthBusImpl(ctx, args),
  );
};
