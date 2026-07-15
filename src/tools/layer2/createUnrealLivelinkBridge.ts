import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const createUnrealLivelinkBridgeSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the Unreal bridge."),
  name: z.string().default("unreal_livelink_bridge").describe("Generated baseCOMP name."),
  mode: z.enum(["livelink_osc", "udp_json", "ndi_preview", "manual"]).default("livelink_osc"),
  unreal_host: z.string().default("127.0.0.1"),
  send_port: z.coerce.number().int().min(1).max(65535).default(9000),
  receive_port: z.coerce.number().int().min(1).max(65535).default(9001),
  subject_name: z.string().default("tdmcp_camera"),
  sync_camera: z.boolean().default(true),
  sync_transform: z.boolean().default(true),
  preview_mode: z.enum(["none", "ndi"]).default("ndi"),
  active: z.boolean().default(false),
});

type CreateUnrealLivelinkBridgeArgs = z.infer<typeof createUnrealLivelinkBridgeSchema>;

function sourceNodes(args: CreateUnrealLivelinkBridgeArgs): ExternalShowNodeSpec[] {
  if (args.mode === "manual") {
    return [
      {
        name: "manual_payload",
        optype: "textDAT",
        x: 0,
        y: 120,
        text: `Manual Unreal payload target for subject ${args.subject_name}.`,
      },
    ];
  }
  return [
    {
      name: "osc_out",
      optype: "oscoutCHOP",
      x: 0,
      y: 120,
      params: { netaddress: args.unreal_host, port: args.send_port, active: args.active ? 1 : 0 },
    },
    {
      name: "osc_in",
      optype: "oscinCHOP",
      x: 0,
      y: -40,
      params: { port: args.receive_port, active: args.active ? 1 : 0 },
    },
  ];
}

export async function createUnrealLivelinkBridgeImpl(
  ctx: ToolContext,
  args: CreateUnrealLivelinkBridgeArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "unreal_livelink_bridge",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        mode: args.mode,
        unreal_host: args.unreal_host,
        send_port: args.send_port,
        receive_port: args.receive_port,
        subject_name: args.subject_name,
        sync_camera: args.sync_camera,
        sync_transform: args.sync_transform,
        preview_mode: args.preview_mode,
        active: args.active,
      },
      warnings: [
        "Unreal Live Link plugin setup is not validated by this scaffold.",
        "NDI preview requires separate Unreal/NDI configuration and network validation.",
      ],
      nodes: [
        ...sourceNodes(args),
        {
          name: "subject_map",
          optype: "tableDAT",
          x: 300,
          y: 120,
          table: [
            ["subject", "field", "enabled"],
            [args.subject_name, "camera", String(args.sync_camera)],
            [args.subject_name, "transform", String(args.sync_transform)],
          ],
        },
        {
          name: "event_queue",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [["time", "event", "payload_json"]],
        },
        {
          name: "preview_config",
          optype: "textDAT",
          x: 600,
          y: 120,
          text: `Preview mode: ${args.preview_mode}. Use NDI only after Unreal output and TD receive are confirmed live.`,
        },
        {
          name: "status",
          optype: "tableDAT",
          x: 600,
          y: -40,
          table: [
            ["field", "value"],
            ["mode", args.mode],
            ["subject", args.subject_name],
            ["host", args.unreal_host],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 900,
          y: 120,
          text: "Use Unreal Live Link/OSC/NDI configuration outside TD, then bind subject_map rows to the live receiver. Do not assume plugin availability from this scaffold alone.",
        },
      ],
    },
    "create_unreal_livelink_bridge failed",
    (report) =>
      `Created Unreal Live Link scaffold ${report.container_path}; mode ${args.mode}; subject ${args.subject_name}.`,
  );
}

export const registerCreateUnrealLivelinkBridge: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_unreal_livelink_bridge",
    {
      title: "Create Unreal Live Link bridge",
      description:
        "Create an Unreal Engine Live Link/OSC/NDI handoff scaffold with subject maps, event queue, and runtime setup warnings.",
      inputSchema: createUnrealLivelinkBridgeSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createUnrealLivelinkBridgeImpl(ctx, args),
  );
};
