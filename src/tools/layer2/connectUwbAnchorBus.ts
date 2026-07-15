import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { websocketDatParams } from "./externalShowBridgeHelpers.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectUwbAnchorBusSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the UWB scaffold."),
  name: z.string().default("uwb_anchor_bus").describe("Generated baseCOMP name."),
  space_label: z.string().default("tracked_space"),
  adapter_mode: z.enum(["websocket_json", "http_json", "manual"]).default("websocket_json"),
  adapter_url: z.string().default("ws://127.0.0.1:9086/uwb"),
  anchor_count: z.coerce.number().int().min(3).max(256).default(8),
  tag_count: z.coerce.number().int().min(1).max(2048).default(12),
  zone_count: z.coerce.number().int().min(1).max(256).default(4),
  position_units: z.enum(["meters", "centimeters", "normalized"]).default("meters"),
  active: z.boolean().default(false),
});

type ConnectUwbAnchorBusArgs = z.infer<typeof connectUwbAnchorBusSchema>;

function sourceNode(args: ConnectUwbAnchorBusArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "http_json") {
    return {
      name: "uwb_http_adapter",
      optype: "webclientDAT",
      x: 0,
      y: 120,
      params: { url: args.adapter_url, active: args.active ? 1 : 0 },
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_uwb_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Paste sanitized UWB positions into tag_position_map.",
    };
  }
  return {
    name: "uwb_ws_adapter",
    optype: "websocketDAT",
    x: 0,
    y: 120,
    params: websocketDatParams(args.adapter_url, args.active),
  };
}

function anchorRows(args: ConnectUwbAnchorBusArgs): string[][] {
  const rows = [["anchor", "space", "x", "y", "z"]];
  for (let index = 1; index <= args.anchor_count; index += 1) {
    rows.push([
      `anchor_${index}`,
      args.space_label,
      String((index - 1) % 4),
      String(Math.floor((index - 1) / 4)),
      "0",
    ]);
  }
  return rows;
}

function tagRows(args: ConnectUwbAnchorBusArgs): string[][] {
  const rows = [["tag", "zone", "x", "y", "units", "identity_policy"]];
  for (let index = 1; index <= args.tag_count; index += 1) {
    rows.push([
      `tag_ref_${index}`,
      `zone_${((index - 1) % args.zone_count) + 1}`,
      String((index % 7) / 2),
      String((index % 5) / 2),
      args.position_units,
      "pseudonymous",
    ]);
  }
  return rows;
}

export async function connectUwbAnchorBusImpl(ctx: ToolContext, args: ConnectUwbAnchorBusArgs) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "uwb_anchor_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        space_label: args.space_label,
        adapter_mode: args.adapter_mode,
        adapter_url: args.adapter_url,
        anchor_count: args.anchor_count,
        tag_count: args.tag_count,
        zone_count: args.zone_count,
        position_units: args.position_units,
        active: args.active,
      },
      warnings: [
        "UWB vendor SDKs, tag identity, calibration, safety limits, and consent controls are intentionally external to this scaffold.",
        "Use filtered positions and geofence policy before routing UWB motion to show-critical effects.",
      ],
      nodes: [
        sourceNode(args),
        { name: "anchor_map", optype: "tableDAT", x: 300, y: 120, table: anchorRows(args) },
        {
          name: "tag_position_map",
          optype: "tableDAT",
          x: 600,
          y: 120,
          table: tagRows(args),
        },
        {
          name: "spatial_policy",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["space_label", args.space_label],
            ["position_units", args.position_units],
            ["raw_tag_ids_in_td", "false"],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use an adapter for UWB RTLS SDKs, calibration, smoothing, tag pseudonymization, and safety geofences. TouchDesigner consumes tag_position_map rows.",
        },
      ],
    },
    "connect_uwb_anchor_bus failed",
    (report) =>
      `Created UWB anchor bus ${report.container_path}; anchors ${args.anchor_count}; tags ${args.tag_count}.`,
  );
}

export const registerConnectUwbAnchorBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_uwb_anchor_bus",
    {
      title: "Connect UWB anchor bus",
      description:
        "Create a UWB RTLS scaffold with sanitized tag positions, anchor maps, spatial policy, adapter source, and tag-privacy notes.",
      inputSchema: connectUwbAnchorBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectUwbAnchorBusImpl(ctx, args),
  );
};
