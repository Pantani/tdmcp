import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const createNcamCameraTrackingBusSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the NCAM scaffold."),
  name: z.string().default("ncam_camera_tracking_bus").describe("Generated baseCOMP name."),
  port: z.coerce.number().int().min(1).max(65535).default(3880),
  camera_count: z.coerce.number().int().min(1).max(8).default(1),
  lens_profile_count: z.coerce.number().int().min(0).max(32).default(4),
  include_video_top: z.boolean().default(true),
  active: z.boolean().default(false),
});

type CreateNcamCameraTrackingBusArgs = z.infer<typeof createNcamCameraTrackingBusSchema>;

function cameraRows(args: CreateNcamCameraTrackingBusArgs): string[][] {
  const rows = [["camera", "channel_prefix", "virtual_camera"]];
  for (let index = 0; index < args.camera_count; index += 1) {
    rows.push([`camera_${index + 1}`, `ncam_${index + 1}_`, index === 0 ? "primary" : "aux"]);
  }
  return rows;
}

function lensRows(args: CreateNcamCameraTrackingBusArgs): string[][] {
  const rows = [["profile", "focus_channel", "zoom_channel"]];
  for (let index = 0; index < args.lens_profile_count; index += 1) {
    rows.push([`lens_${index + 1}`, `lens${index + 1}_focus`, `lens${index + 1}_zoom`]);
  }
  return rows;
}

export async function createNcamCameraTrackingBusImpl(
  ctx: ToolContext,
  args: CreateNcamCameraTrackingBusArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "ncam_camera_tracking_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        port: args.port,
        camera_count: args.camera_count,
        lens_profile_count: args.lens_profile_count,
        include_video_top: args.include_video_top,
        active: args.active,
      },
      warnings: [
        "NCAM CHOP/TOP requires TouchDesigner Pro and a calibrated NCAM system.",
        "Confirm lens calibration, camera origin, and frame latency before compositing final XR views.",
      ],
      nodes: [
        {
          name: "ncam_chop",
          optype: "ncamCHOP",
          x: 0,
          y: 120,
          params: { active: args.active ? 1 : 0, port: args.port },
        },
        {
          name: "ncam_top",
          optype: "ncamTOP",
          x: 0,
          y: -40,
          params: { active: args.include_video_top && args.active ? 1 : 0 },
        },
        { name: "camera_map", optype: "tableDAT", x: 300, y: 120, table: cameraRows(args) },
        { name: "lens_map", optype: "tableDAT", x: 600, y: 120, table: lensRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["port", String(args.port)],
            ["camera_count", String(args.camera_count)],
            ["lens_profile_count", String(args.lens_profile_count)],
            ["include_video_top", String(args.include_video_top)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use ncam_chop for camera pose, lens_map for calibrated focus/zoom channels, and ncam_top only after the NCAM feed is verified live.",
        },
      ],
    },
    "create_ncam_camera_tracking_bus failed",
    (report) =>
      `Created NCAM camera tracking bus ${report.container_path}; cameras ${args.camera_count}; port ${args.port}.`,
  );
}

export const registerCreateNcamCameraTrackingBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_ncam_camera_tracking_bus",
    {
      title: "Create NCAM camera tracking bus",
      description:
        "Create an NCAM camera-tracking scaffold with pose, lens, video-preview, and calibration maps.",
      inputSchema: createNcamCameraTrackingBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createNcamCameraTrackingBusImpl(ctx, args),
  );
};
