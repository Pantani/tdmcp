import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const createDecklinkIoRouterSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the router scaffold."),
  name: z.string().default("decklink_io_router").describe("Generated baseCOMP name."),
  input_device: z.string().default("Blackmagic"),
  output_device: z.string().default("Blackmagic"),
  signal_format: z.string().default("1080p5994"),
  route_count: z.coerce.number().int().min(1).max(16).default(2),
  active: z.boolean().default(false),
});

type CreateDecklinkIoRouterArgs = z.infer<typeof createDecklinkIoRouterSchema>;

function routeRows(args: CreateDecklinkIoRouterArgs): string[][] {
  const rows = [["route", "input_device", "output_device", "signal_format"]];
  for (let route = 1; route <= args.route_count; route += 1) {
    rows.push([
      `route_${route}`,
      route === 1 ? args.input_device : `${args.input_device}_${route}`,
      route === 1 ? args.output_device : `${args.output_device}_${route}`,
      args.signal_format,
    ]);
  }
  return rows;
}

export async function createDecklinkIoRouterImpl(
  ctx: ToolContext,
  args: CreateDecklinkIoRouterArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "decklink_io_router",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        input_device: args.input_device,
        output_device: args.output_device,
        signal_format: args.signal_format,
        route_count: args.route_count,
        active: args.active,
      },
      warnings: [
        "DeckLink capture/output is hardware and driver gated; validate devices in Video Device DATs before enabling output.",
        "Output cards can affect live displays; keep active=false until signal format, reference, and routing are confirmed.",
      ],
      nodes: [
        {
          name: "video_in",
          optype: "videodeviceinTOP",
          x: 0,
          y: 120,
          params: {
            active: args.active ? 1 : 0,
            driver: "blackmagic",
            device: args.input_device,
            signalformat: args.signal_format,
          },
        },
        { name: "router_out", optype: "nullTOP", x: 300, y: 120 },
        {
          name: "video_out",
          optype: "videodeviceoutTOP",
          x: 600,
          y: 120,
          params: {
            active: args.active ? 1 : 0,
            library: "blackmagic",
            device: args.output_device,
            signalformat: args.signal_format,
          },
        },
        { name: "route_map", optype: "tableDAT", x: 300, y: -40, table: routeRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 600,
          y: -40,
          table: [
            ["field", "value"],
            ["input_device", args.input_device],
            ["output_device", args.output_device],
            ["signal_format", args.signal_format],
            ["route_count", String(args.route_count)],
            ["active", String(args.active)],
          ],
        },
      ],
      connections: [
        { from: "video_in", to: "router_out" },
        { from: "router_out", to: "video_out" },
      ],
    },
    "create_decklink_io_router failed",
    (report) =>
      `Created DeckLink I/O router ${report.container_path}; routes ${args.route_count}; signal ${args.signal_format}.`,
  );
}

export const registerCreateDecklinkIoRouter: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_decklink_io_router",
    {
      title: "Create DeckLink I/O router",
      description:
        "Create a Blackmagic DeckLink video-device input/output router scaffold with route maps and hardware-gated safety notes.",
      inputSchema: createDecklinkIoRouterSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createDecklinkIoRouterImpl(ctx, args),
  );
};
