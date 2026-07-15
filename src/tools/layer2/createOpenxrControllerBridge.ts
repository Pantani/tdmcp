import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { websocketDatParams } from "./externalShowBridgeHelpers.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const createOpenxrControllerBridgeSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the OpenXR scaffold."),
  name: z.string().default("openxr_controller_bridge").describe("Generated baseCOMP name."),
  source_mode: z.enum(["osc", "websocket_json", "manual"]).default("osc"),
  receive_port: z.coerce.number().int().min(1).max(65535).default(9050),
  server_url: z.string().default("ws://127.0.0.1:9050"),
  controller_count: z.coerce.number().int().min(1).max(8).default(2),
  coordinate_space: z.enum(["openxr", "steamvr", "touchdesigner"]).default("touchdesigner"),
  active: z.boolean().default(false),
});

type CreateOpenxrControllerBridgeArgs = z.infer<typeof createOpenxrControllerBridgeSchema>;

function sourceNode(args: CreateOpenxrControllerBridgeArgs): ExternalShowNodeSpec {
  if (args.source_mode === "websocket_json") {
    return {
      name: "openxr_websocket_in",
      optype: "websocketDAT",
      x: 0,
      y: 120,
      params: websocketDatParams(args.server_url, args.active),
    };
  }
  if (args.source_mode === "osc") {
    return {
      name: "openxr_osc_in",
      optype: "oscinCHOP",
      x: 0,
      y: 120,
      params: { port: args.receive_port, active: args.active ? 1 : 0 },
    };
  }
  return {
    name: "manual_payload",
    optype: "textDAT",
    x: 0,
    y: 120,
    text: "Manual OpenXR controller payload target. External adapters should write pose/button JSON here.",
  };
}

function poseRows(args: CreateOpenxrControllerBridgeArgs): string[][] {
  const rows = [["controller", "channels", "coordinate_space"]];
  for (let index = 1; index <= args.controller_count; index += 1) {
    rows.push([
      `controller_${index}`,
      "tx ty tz rx ry rz qx qy qz qw confidence",
      args.coordinate_space,
    ]);
  }
  return rows;
}

function buttonRows(args: CreateOpenxrControllerBridgeArgs): string[][] {
  const rows = [["controller", "button", "channel"]];
  for (let index = 1; index <= args.controller_count; index += 1) {
    rows.push([`controller_${index}`, "trigger", `c${index}_trigger`]);
    rows.push([`controller_${index}`, "grip", `c${index}_grip`]);
    rows.push([`controller_${index}`, "thumbstick_x", `c${index}_thumbstick_x`]);
    rows.push([`controller_${index}`, "thumbstick_y", `c${index}_thumbstick_y`]);
  }
  return rows;
}

export async function createOpenxrControllerBridgeImpl(
  ctx: ToolContext,
  args: CreateOpenxrControllerBridgeArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "openxr_controller_bridge",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        source_mode: args.source_mode,
        receive_port: args.receive_port,
        server_url: args.server_url,
        controller_count: args.controller_count,
        coordinate_space: args.coordinate_space,
        active: args.active,
      },
      warnings: [
        "This scaffold does not bind directly to an OpenXR runtime; an external adapter must provide frames.",
        "Coordinate orientation and controller identity must be rehearsed against the actual VR runtime.",
      ],
      nodes: [
        sourceNode(args),
        { name: "pose_map", optype: "tableDAT", x: 300, y: 120, table: poseRows(args) },
        { name: "button_map", optype: "tableDAT", x: 600, y: 120, table: buttonRows(args) },
        { name: "controller_out", optype: "nullCHOP", x: 900, y: 120 },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["source_mode", args.source_mode],
            ["controller_count", String(args.controller_count)],
            ["coordinate_space", args.coordinate_space],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Feed controller pose/button frames from OpenXR, SteamVR, or OSC/WebSocket middleware. Keep controller_out naming stable before binding visuals.",
        },
      ],
    },
    "create_openxr_controller_bridge failed",
    (report) =>
      `Created OpenXR controller bridge ${report.container_path}; source ${args.source_mode}; controllers ${args.controller_count}.`,
  );
}

export const registerCreateOpenxrControllerBridge: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_openxr_controller_bridge",
    {
      title: "Create OpenXR controller bridge",
      description:
        "Create an OpenXR/SteamVR controller input scaffold for pose, trigger, grip, thumbstick, and button streams supplied by an external adapter.",
      inputSchema: createOpenxrControllerBridgeSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createOpenxrControllerBridgeImpl(ctx, args),
  );
};
