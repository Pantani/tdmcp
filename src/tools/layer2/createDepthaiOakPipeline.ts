import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const createDepthaiOakPipelineSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the OAK scaffold."),
  name: z.string().default("depthai_oak_pipeline").describe("Generated baseCOMP name."),
  device_name: z.string().default("oak"),
  stream_count: z.coerce.number().int().min(1).max(16).default(3),
  include_depth: z.boolean().default(true),
  include_tracking: z.boolean().default(true),
  active: z.boolean().default(false),
});

type CreateDepthaiOakPipelineArgs = z.infer<typeof createDepthaiOakPipelineSchema>;

function streamRows(args: CreateDepthaiOakPipelineArgs): string[][] {
  const rows = [["stream", "operator", "purpose"]];
  rows.push(["rgb", "oakselectTOP", "camera texture"]);
  if (args.include_depth) {
    rows.push(["depth", "oakselectTOP", "depth texture"]);
  }
  if (args.include_tracking) {
    rows.push(["tracking", "oakselectCHOP", "detections / landmarks"]);
  }
  for (let index = rows.length; index <= args.stream_count; index += 1) {
    rows.push([`aux_${index}`, "oakselectCHOP", "custom DepthAI stream"]);
  }
  return rows;
}

export async function createDepthaiOakPipelineImpl(
  ctx: ToolContext,
  args: CreateDepthaiOakPipelineArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "depthai_oak_pipeline",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        device_name: args.device_name,
        stream_count: args.stream_count,
        include_depth: args.include_depth,
        include_tracking: args.include_tracking,
        active: args.active,
      },
      warnings: [
        "OAK operators require a compatible TouchDesigner build and DepthAI device; this scaffold does not validate hardware live.",
        "Tune pipeline streams in the OAK Device CHOP before binding downstream visuals.",
      ],
      nodes: [
        {
          name: "oak_device",
          optype: "oakdeviceCHOP",
          x: 0,
          y: 120,
          params: { active: args.active ? 1 : 0, sensor: args.device_name },
        },
        {
          name: "rgb_top",
          optype: "oakselectTOP",
          x: 300,
          y: 180,
          params: { chop: "oak_device", outputindex: 0 },
        },
        {
          name: "depth_top",
          optype: "oakselectTOP",
          x: 300,
          y: 20,
          params: { chop: "oak_device", outputindex: args.include_depth ? 1 : 0 },
        },
        {
          name: "tracking_chop",
          optype: "oakselectCHOP",
          x: 300,
          y: -140,
          params: { chop: "oak_device", outputindex: args.include_tracking ? 2 : 0 },
        },
        { name: "stream_map", optype: "tableDAT", x: 600, y: 120, table: streamRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 600,
          y: -40,
          table: [
            ["field", "value"],
            ["device_name", args.device_name],
            ["stream_count", String(args.stream_count)],
            ["include_depth", String(args.include_depth)],
            ["include_tracking", String(args.include_tracking)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 900,
          y: 120,
          text: "Install and test the DepthAI/OAK device in TouchDesigner, then map the actual OAK Device CHOP streams to rgb_top, depth_top, and tracking_chop.",
        },
      ],
    },
    "create_depthai_oak_pipeline failed",
    (report) =>
      `Created DepthAI/OAK scaffold ${report.container_path}; streams ${args.stream_count}; depth ${args.include_depth}.`,
  );
}

export const registerCreateDepthaiOakPipeline: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_depthai_oak_pipeline",
    {
      title: "Create DepthAI OAK pipeline",
      description:
        "Create a DepthAI/OAK camera scaffold with OAK Device, OAK Select TOP/CHOP placeholders, stream maps, and hardware-gated setup notes.",
      inputSchema: createDepthaiOakPipelineSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createDepthaiOakPipelineImpl(ctx, args),
  );
};
