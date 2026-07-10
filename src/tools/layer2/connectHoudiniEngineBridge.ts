import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectHoudiniEngineBridgeSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the Houdini bridge."),
  name: z.string().default("houdini_engine_bridge").describe("Generated baseCOMP name."),
  handoff_mode: z
    .enum(["file_watch", "hda_parameters", "websocket_json", "udp_cook_status"])
    .default("file_watch"),
  hda_file: z.string().default("./houdini/show_asset.hda"),
  cache_folder: z.string().default("./houdini/cache"),
  server_url: z.string().default("ws://127.0.0.1:9876"),
  receive_port: z.coerce.number().int().min(1).max(65535).default(9876),
  asset_format: z.enum(["bgeo", "usd", "alembic", "obj"]).default("bgeo"),
  parameter_count: z.coerce.number().int().min(1).max(128).default(12),
  active: z.boolean().default(false),
});

type ConnectHoudiniEngineBridgeArgs = z.infer<typeof connectHoudiniEngineBridgeSchema>;

function sourceNode(args: ConnectHoudiniEngineBridgeArgs): ExternalShowNodeSpec {
  if (args.handoff_mode === "websocket_json") {
    return {
      name: "houdini_ws",
      optype: "websocketDAT",
      x: 0,
      y: 120,
      params: { url: args.server_url, active: args.active ? 1 : 0 },
    };
  }
  if (args.handoff_mode === "udp_cook_status") {
    return {
      name: "cook_status_udp",
      optype: "udpinDAT",
      x: 0,
      y: 120,
      params: { port: args.receive_port, active: args.active ? 1 : 0 },
    };
  }
  return {
    name: "handoff_notes",
    optype: "textDAT",
    x: 0,
    y: 120,
    text: `HDA: ${args.hda_file}\nCache folder: ${args.cache_folder}\nFormat: ${args.asset_format}`,
  };
}

function parameterRows(args: ConnectHoudiniEngineBridgeArgs): string[][] {
  const rows = [["parameter", "direction", "td_channel", "houdini_path"]];
  for (let index = 1; index <= args.parameter_count; index += 1) {
    rows.push([`parm_${index}`, "td_to_houdini", `parm_${index}`, `/obj/show_asset/parm_${index}`]);
  }
  return rows;
}

export async function connectHoudiniEngineBridgeImpl(
  ctx: ToolContext,
  args: ConnectHoudiniEngineBridgeArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "houdini_engine_bridge",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        handoff_mode: args.handoff_mode,
        hda_file: args.hda_file,
        cache_folder: args.cache_folder,
        server_url: args.server_url,
        receive_port: args.receive_port,
        asset_format: args.asset_format,
        parameter_count: args.parameter_count,
        active: args.active,
      },
      warnings: [
        "This scaffold does not run Houdini Engine, load an HDA, or cook geometry.",
        "Cache format, axis conversion, and HDA parameter names must be verified against the actual Houdini asset.",
      ],
      nodes: [
        sourceNode(args),
        {
          name: "hda_manifest",
          optype: "tableDAT",
          x: 300,
          y: 120,
          table: [
            ["field", "value"],
            ["hda_file", args.hda_file],
            ["cache_folder", args.cache_folder],
            ["asset_format", args.asset_format],
          ],
        },
        { name: "parameter_map", optype: "tableDAT", x: 600, y: 120, table: parameterRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["handoff_mode", args.handoff_mode],
            ["server_url", args.server_url],
            ["receive_port", String(args.receive_port)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use parameter_map as the explicit contract between TD controls and the Houdini HDA. Import cooked BGEO/USD/Alembic/OBJ caches only after unit and axis checks.",
        },
      ],
    },
    "connect_houdini_engine_bridge failed",
    (report) =>
      `Created Houdini Engine bridge ${report.container_path}; mode ${args.handoff_mode}; format ${args.asset_format}.`,
  );
}

export const registerConnectHoudiniEngineBridge: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_houdini_engine_bridge",
    {
      title: "Connect Houdini Engine bridge",
      description:
        "Create a Houdini Engine/HDA/cache handoff scaffold with HDA manifests, parameter maps, cook-status ingest, and geometry cache notes.",
      inputSchema: connectHoudiniEngineBridgeSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectHoudiniEngineBridgeImpl(ctx, args),
  );
};
