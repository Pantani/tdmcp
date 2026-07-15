import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectOmniverseUsdBridgeSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the USD bridge."),
  name: z.string().default("omniverse_usd_bridge").describe("Generated baseCOMP name."),
  nucleus_url: z.string().default("omniverse://localhost/Projects/show"),
  stage_path: z.string().default("./usd/show_stage.usd"),
  sync_mode: z
    .enum(["usd_file_watch", "nucleus_live", "websocket_json", "manual_export"])
    .default("usd_file_watch"),
  server_url: z.string().default("ws://127.0.0.1:8899"),
  layer_count: z.coerce.number().int().min(1).max(64).default(4),
  variant_count: z.coerce.number().int().min(0).max(64).default(3),
  active: z.boolean().default(false),
});

type ConnectOmniverseUsdBridgeArgs = z.infer<typeof connectOmniverseUsdBridgeSchema>;

function sourceNode(args: ConnectOmniverseUsdBridgeArgs): ExternalShowNodeSpec {
  if (args.sync_mode === "websocket_json") {
    return {
      name: "usd_ws",
      optype: "websocketDAT",
      x: 0,
      y: 120,
      params: { url: args.server_url, active: args.active ? 1 : 0 },
    };
  }
  if (args.sync_mode === "nucleus_live") {
    return {
      name: "nucleus_status",
      optype: "webclientDAT",
      x: 0,
      y: 120,
      params: { url: args.nucleus_url, active: args.active ? 1 : 0 },
    };
  }
  return {
    name: "usd_stage_notes",
    optype: "textDAT",
    x: 0,
    y: 120,
    text: `USD stage: ${args.stage_path}\nNucleus: ${args.nucleus_url}\nSync mode: ${args.sync_mode}`,
  };
}

function layerRows(args: ConnectOmniverseUsdBridgeArgs): string[][] {
  const rows = [["layer", "usd_path", "role"]];
  for (let index = 1; index <= args.layer_count; index += 1) {
    rows.push([
      `layer_${index}`,
      `${args.stage_path}#layer_${index}`,
      index === 1 ? "root" : "sub",
    ]);
  }
  return rows;
}

function variantRows(args: ConnectOmniverseUsdBridgeArgs): string[][] {
  const rows = [["variant", "set", "default"]];
  for (let index = 1; index <= args.variant_count; index += 1) {
    rows.push([`variant_${index}`, "look_or_layout", index === 1 ? "true" : "false"]);
  }
  if (args.variant_count === 0) {
    rows.push(["none", "not_configured", "false"]);
  }
  return rows;
}

export async function connectOmniverseUsdBridgeImpl(
  ctx: ToolContext,
  args: ConnectOmniverseUsdBridgeArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "omniverse_usd_bridge",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        nucleus_url: args.nucleus_url,
        stage_path: args.stage_path,
        sync_mode: args.sync_mode,
        server_url: args.server_url,
        layer_count: args.layer_count,
        variant_count: args.variant_count,
        active: args.active,
      },
      warnings: [
        "This scaffold does not authenticate to Nucleus or parse USD stages.",
        "USD units, layer composition, and variant switching must be validated against the Omniverse session.",
      ],
      nodes: [
        sourceNode(args),
        { name: "layer_map", optype: "tableDAT", x: 300, y: 120, table: layerRows(args) },
        { name: "variant_map", optype: "tableDAT", x: 600, y: 120, table: variantRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["sync_mode", args.sync_mode],
            ["nucleus_url", args.nucleus_url],
            ["stage_path", args.stage_path],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use layer_map and variant_map as the TD-side contract for USD stage updates. Keep Omniverse credentials and live session state outside generated tables.",
        },
      ],
    },
    "connect_omniverse_usd_bridge failed",
    (report) =>
      `Created Omniverse USD bridge ${report.container_path}; mode ${args.sync_mode}; layers ${args.layer_count}.`,
  );
}

export const registerConnectOmniverseUsdBridge: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_omniverse_usd_bridge",
    {
      title: "Connect Omniverse USD bridge",
      description:
        "Create an NVIDIA Omniverse/USD stage sync scaffold with Nucleus/stage metadata, layer maps, variant maps, and live-session notes.",
      inputSchema: connectOmniverseUsdBridgeSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectOmniverseUsdBridgeImpl(ctx, args),
  );
};
