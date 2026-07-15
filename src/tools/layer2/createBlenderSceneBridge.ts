import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { websocketDatParams } from "./externalShowBridgeHelpers.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const createBlenderSceneBridgeSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the Blender bridge."),
  name: z.string().default("blender_scene_bridge").describe("Generated baseCOMP name."),
  handoff_mode: z.enum(["file_watch", "websocket_json", "osc"]).default("file_watch"),
  watch_folder: z.string().default("./blender_exports"),
  server_url: z.string().default("ws://127.0.0.1:8765"),
  receive_port: z.coerce.number().int().min(1).max(65535).default(8765),
  asset_format: z.enum(["gltf", "alembic", "fbx", "obj"]).default("gltf"),
  sync_camera: z.boolean().default(true),
  sync_lights: z.boolean().default(false),
  active: z.boolean().default(false),
});

type CreateBlenderSceneBridgeArgs = z.infer<typeof createBlenderSceneBridgeSchema>;

function sourceNode(args: CreateBlenderSceneBridgeArgs): ExternalShowNodeSpec {
  if (args.handoff_mode === "websocket_json") {
    return {
      name: "blender_websocket_in",
      optype: "websocketDAT",
      x: 0,
      y: 120,
      params: websocketDatParams(args.server_url, args.active),
    };
  }
  if (args.handoff_mode === "osc") {
    return {
      name: "blender_osc_in",
      optype: "oscinCHOP",
      x: 0,
      y: 120,
      params: { port: args.receive_port, active: args.active ? 1 : 0 },
    };
  }
  return {
    name: "file_watch_config",
    optype: "textDAT",
    x: 0,
    y: 120,
    text: `Watch folder: ${args.watch_folder}\nAsset format: ${args.asset_format}\nUse an external watcher to import changed assets into TD.`,
  };
}

export async function createBlenderSceneBridgeImpl(
  ctx: ToolContext,
  args: CreateBlenderSceneBridgeArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "blender_scene_bridge",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        handoff_mode: args.handoff_mode,
        watch_folder: args.watch_folder,
        server_url: args.server_url,
        receive_port: args.receive_port,
        asset_format: args.asset_format,
        sync_camera: args.sync_camera,
        sync_lights: args.sync_lights,
        active: args.active,
      },
      warnings: [
        "This scaffold does not launch Blender or validate a Blender Python add-on.",
        "Asset units, axis conversion, and material translation must be tested against the exported file.",
      ],
      nodes: [
        sourceNode(args),
        {
          name: "handoff_config",
          optype: "textDAT",
          x: 300,
          y: 120,
          text: JSON.stringify(
            {
              handoff_mode: args.handoff_mode,
              watch_folder: args.watch_folder,
              server_url: args.server_url,
              receive_port: args.receive_port,
              asset_format: args.asset_format,
            },
            null,
            2,
          ),
        },
        {
          name: "asset_manifest",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["asset", "format", "source", "td_target"],
            ["scene", args.asset_format, args.watch_folder, "import/replace manually"],
          ],
        },
        {
          name: "camera_sync",
          optype: "tableDAT",
          x: 600,
          y: 120,
          table: [
            ["field", "enabled"],
            ["camera", String(args.sync_camera)],
            ["lights", String(args.sync_lights)],
          ],
        },
        {
          name: "status",
          optype: "tableDAT",
          x: 600,
          y: -40,
          table: [
            ["field", "value"],
            ["handoff_mode", args.handoff_mode],
            ["asset_format", args.asset_format],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 900,
          y: 120,
          text: "Export GLTF/Alembic/FBX/OBJ from Blender and use this bridge as a stable handoff manifest. Live import/reload policy is intentionally left explicit.",
        },
      ],
    },
    "create_blender_scene_bridge failed",
    (report) =>
      `Created Blender scene bridge ${report.container_path}; mode ${args.handoff_mode}; asset format ${args.asset_format}.`,
  );
}

export const registerCreateBlenderSceneBridge: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_blender_scene_bridge",
    {
      title: "Create Blender scene bridge",
      description:
        "Create a Blender-to-TouchDesigner scene handoff scaffold for file-watch, OSC, or WebSocket metadata workflows.",
      inputSchema: createBlenderSceneBridgeSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createBlenderSceneBridgeImpl(ctx, args),
  );
};
