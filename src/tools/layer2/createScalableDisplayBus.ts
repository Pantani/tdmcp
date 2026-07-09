import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const createScalableDisplayBusSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP for the Scalable Display scaffold."),
  name: z.string().default("scalable_display_bus").describe("Generated baseCOMP name."),
  config_file: z.string().default("").describe("Path to the Scalable Display configuration file."),
  display_count: z.coerce.number().int().min(1).max(64).default(2),
  canvas_width: z.coerce.number().int().min(320).max(65536).default(3840),
  canvas_height: z.coerce.number().int().min(240).max(32768).default(1080),
  active: z.boolean().default(false),
});

type CreateScalableDisplayBusArgs = z.infer<typeof createScalableDisplayBusSchema>;

function tileRows(args: CreateScalableDisplayBusArgs): string[][] {
  const rows = [["display", "tile_x", "tile_width"]];
  const tileWidth = Math.floor(args.canvas_width / args.display_count);
  for (let index = 0; index < args.display_count; index += 1) {
    rows.push([`display_${index + 1}`, String(index * tileWidth), String(tileWidth)]);
  }
  return rows;
}

export async function createScalableDisplayBusImpl(
  ctx: ToolContext,
  args: CreateScalableDisplayBusArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "scalable_display_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        config_file: args.config_file,
        display_count: args.display_count,
        canvas_width: args.canvas_width,
        canvas_height: args.canvas_height,
        active: args.active,
      },
      warnings: [
        "Scalable Display calibration must match the installed display cluster and content canvas.",
        "Use tile_map as a setup checklist; this scaffold does not verify GPU output routing live.",
      ],
      nodes: [
        {
          name: "scalable_display",
          optype: "scalabledisplayTOP",
          x: 0,
          y: 120,
          params: { active: args.active ? 1 : 0, file: args.config_file },
        },
        { name: "display_out", optype: "nullTOP", x: 300, y: 120 },
        { name: "tile_map", optype: "tableDAT", x: 300, y: -40, table: tileRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 600,
          y: 120,
          table: [
            ["field", "value"],
            ["config_file", args.config_file],
            ["display_count", String(args.display_count)],
            ["canvas", `${args.canvas_width}x${args.canvas_height}`],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Route the master canvas through scalable_display only after tile_map, config_file, and the physical display cluster have been checked.",
        },
      ],
      connections: [{ from: "scalable_display", to: "display_out" }],
    },
    "create_scalable_display_bus failed",
    (report) =>
      `Created Scalable Display bus ${report.container_path}; displays ${args.display_count}; canvas ${args.canvas_width}x${args.canvas_height}.`,
  );
}

export const registerCreateScalableDisplayBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_scalable_display_bus",
    {
      title: "Create Scalable Display bus",
      description:
        "Create a Scalable Display TOP scaffold with display tile maps, status, and calibration setup notes.",
      inputSchema: createScalableDisplayBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createScalableDisplayBusImpl(ctx, args),
  );
};
