import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const connectSpoutSyphonRouterSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the router scaffold."),
  name: z.string().default("spout_syphon_router").describe("Generated baseCOMP name."),
  mode: z.enum(["receive", "send", "roundtrip"]).default("roundtrip"),
  source_name: z.string().default("tdmcp_source").describe("Syphon/Spout sender to receive."),
  output_name: z.string().default("tdmcp_output").describe("Syphon/Spout sender name to publish."),
  route_count: z.coerce.number().int().min(1).max(64).default(4),
  active: z.boolean().default(false),
});

type ConnectSpoutSyphonRouterArgs = z.infer<typeof connectSpoutSyphonRouterSchema>;

function routeRows(args: ConnectSpoutSyphonRouterArgs): string[][] {
  const rows = [["route", "input_sender", "output_sender", "mode"]];
  for (let index = 1; index <= args.route_count; index += 1) {
    rows.push([
      `route_${index}`,
      index === 1 ? args.source_name : `${args.source_name}_${index}`,
      index === 1 ? args.output_name : `${args.output_name}_${index}`,
      args.mode,
    ]);
  }
  return rows;
}

export async function connectSpoutSyphonRouterImpl(
  ctx: ToolContext,
  args: ConnectSpoutSyphonRouterArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "spout_syphon_router",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        mode: args.mode,
        source_name: args.source_name,
        output_name: args.output_name,
        route_count: args.route_count,
        active: args.active,
      },
      warnings: [
        "Syphon/Spout availability is platform-gated; this scaffold does not validate a live sender.",
        "Use only one active sender name per route during show operation to avoid ambiguous texture handoffs.",
      ],
      nodes: [
        {
          name: "texture_in",
          optype: "syphonspoutinTOP",
          x: 0,
          y: 120,
          params: { sendername: args.source_name, active: args.active ? 1 : 0 },
        },
        { name: "router_out", optype: "nullTOP", x: 300, y: 120 },
        {
          name: "texture_out",
          optype: "syphonspoutoutTOP",
          x: 600,
          y: 120,
          params: { sendername: args.output_name, active: args.active ? 1 : 0 },
        },
        { name: "route_map", optype: "tableDAT", x: 300, y: -40, table: routeRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 600,
          y: -40,
          table: [
            ["field", "value"],
            ["mode", args.mode],
            ["source_name", args.source_name],
            ["output_name", args.output_name],
            ["route_count", String(args.route_count)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 900,
          y: 120,
          text: "Syphon/Spout uses syphonspoutinTOP and syphonspoutoutTOP. Confirm platform support, exact sender names, and GPU visibility before enabling active routes.",
        },
      ],
      connections: [
        { from: "texture_in", to: "router_out" },
        { from: "router_out", to: "texture_out" },
      ],
    },
    "connect_spout_syphon_router failed",
    (report) =>
      `Created Syphon/Spout router ${report.container_path}; routes ${args.route_count}; mode ${args.mode}.`,
  );
}

export const registerConnectSpoutSyphonRouter: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_spout_syphon_router",
    {
      title: "Connect Syphon/Spout router",
      description:
        "Create a platform-gated Syphon/Spout texture-sharing router scaffold with route maps and explicit setup notes.",
      inputSchema: connectSpoutSyphonRouterSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectSpoutSyphonRouterImpl(ctx, args),
  );
};
