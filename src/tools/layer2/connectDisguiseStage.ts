import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const connectDisguiseStageSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the disguise scaffold."),
  name: z.string().default("disguise_stage").describe("Generated baseCOMP name."),
  api_host: z.string().default("127.0.0.1"),
  api_port: z.coerce.number().int().min(1).max(65535).default(8080),
  osc_port: z.coerce.number().int().min(1).max(65535).default(7400),
  timeline_count: z.coerce.number().int().min(1).max(128).default(4),
  layer_count: z.coerce.number().int().min(1).max(256).default(8),
  active: z.boolean().default(false),
});

type ConnectDisguiseStageArgs = z.infer<typeof connectDisguiseStageSchema>;

function timelineRows(args: ConnectDisguiseStageArgs): string[][] {
  const rows = [["timeline", "play_command", "status_endpoint"]];
  for (let timeline = 1; timeline <= args.timeline_count; timeline += 1) {
    rows.push([
      `timeline_${timeline}`,
      `/api/session/timelines/${timeline}/play`,
      `/api/session/timelines/${timeline}`,
    ]);
  }
  return rows;
}

function layerRows(args: ConnectDisguiseStageArgs): string[][] {
  const rows = [["layer", "opacity_address", "visibility_address"]];
  for (let layer = 1; layer <= args.layer_count; layer += 1) {
    rows.push([
      `layer_${layer}`,
      `/disguise/layer/${layer}/opacity`,
      `/disguise/layer/${layer}/visible`,
    ]);
  }
  return rows;
}

export async function connectDisguiseStageImpl(ctx: ToolContext, args: ConnectDisguiseStageArgs) {
  const baseUrl = `http://${args.api_host}:${args.api_port}`;
  return runExternalShowScaffold(
    ctx,
    {
      kind: "disguise_stage",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        api_host: args.api_host,
        api_port: args.api_port,
        osc_port: args.osc_port,
        timeline_count: args.timeline_count,
        layer_count: args.layer_count,
        active: args.active,
      },
      warnings: [
        "disguise/d3 control is show-critical; keep timeline and layer commands operator-approved.",
        "This scaffold prepares HTTP/OSC maps only and does not validate a live disguise session.",
      ],
      nodes: [
        {
          name: "api_client",
          optype: "webclientDAT",
          x: 0,
          y: 120,
          params: { url: `${baseUrl}/api/session`, reqmethod: "GET", active: args.active ? 1 : 0 },
        },
        {
          name: "osc_in",
          optype: "oscinCHOP",
          x: 0,
          y: -40,
          params: { port: args.osc_port, active: args.active ? 1 : 0 },
        },
        { name: "timeline_map", optype: "tableDAT", x: 300, y: 120, table: timelineRows(args) },
        { name: "layer_map", optype: "tableDAT", x: 600, y: 120, table: layerRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["api_base", baseUrl],
            ["osc_port", String(args.osc_port)],
            ["timeline_count", String(args.timeline_count)],
            ["layer_count", String(args.layer_count)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Point api_client at the approved disguise endpoint, validate read-only session status first, then wire timeline_map commands through operator approval.",
        },
      ],
    },
    "connect_disguise_stage failed",
    (report) =>
      `Created disguise stage scaffold ${report.container_path}; timelines ${args.timeline_count}; layers ${args.layer_count}.`,
  );
}

export const registerConnectDisguiseStage: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_disguise_stage",
    {
      title: "Connect disguise stage",
      description:
        "Create a disguise/d3 HTTP and OSC show-control scaffold with timeline, layer, and approval maps.",
      inputSchema: connectDisguiseStageSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectDisguiseStageImpl(ctx, args),
  );
};
