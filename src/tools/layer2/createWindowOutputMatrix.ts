import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const createWindowOutputMatrixSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP for the Window output matrix scaffold."),
  name: z.string().default("window_output_matrix").describe("Generated baseCOMP name."),
  window_count: z.coerce.number().int().min(1).max(32).default(2),
  resolution_width: z.coerce.number().int().min(320).max(16384).default(1920),
  resolution_height: z.coerce.number().int().min(240).max(16384).default(1080),
  perform_mode: z.boolean().default(false),
  active: z.boolean().default(false),
});

type CreateWindowOutputMatrixArgs = z.infer<typeof createWindowOutputMatrixSchema>;

function windowNodeName(index: number): string {
  return `window_${index + 1}`;
}

function windowRows(args: CreateWindowOutputMatrixArgs): string[][] {
  const rows = [["window", "monitor_hint", "resolution"]];
  for (let index = 0; index < args.window_count; index += 1) {
    rows.push([
      windowNodeName(index),
      `monitor_${index + 1}`,
      `${args.resolution_width}x${args.resolution_height}`,
    ]);
  }
  return rows;
}

function sourceRows(args: CreateWindowOutputMatrixArgs): string[][] {
  const rows = [["source", "window", "routing"]];
  for (let index = 0; index < args.window_count; index += 1) {
    rows.push([`source_${index + 1}`, windowNodeName(index), "operator assigns TOP"]);
  }
  return rows;
}

function windowNodes(args: CreateWindowOutputMatrixArgs) {
  return Array.from({ length: args.window_count }, (_, index) => ({
    name: windowNodeName(index),
    optype: "windowCOMP",
    x: index * 260,
    y: 180,
    params: { open: args.active ? 1 : 0, perform: args.perform_mode ? 1 : 0 },
  }));
}

export async function createWindowOutputMatrixImpl(
  ctx: ToolContext,
  args: CreateWindowOutputMatrixArgs,
) {
  const mapX = args.window_count * 260 + 120;
  return runExternalShowScaffold(
    ctx,
    {
      kind: "window_output_matrix",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        window_count: args.window_count,
        resolution_width: args.resolution_width,
        resolution_height: args.resolution_height,
        perform_mode: args.perform_mode,
        active: args.active,
      },
      warnings: [
        "Window COMP output depends on OS monitor order and TouchDesigner perform-mode settings.",
        "Keep windows inactive until source routing, monitor positions, and emergency blackout have been checked.",
      ],
      nodes: [
        ...windowNodes(args),
        { name: "window_map", optype: "tableDAT", x: mapX, y: 180, table: windowRows(args) },
        { name: "source_map", optype: "tableDAT", x: mapX + 300, y: 180, table: sourceRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: mapX,
          y: -40,
          table: [
            ["field", "value"],
            ["window_count", String(args.window_count)],
            ["resolution", `${args.resolution_width}x${args.resolution_height}`],
            ["perform_mode", String(args.perform_mode)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: mapX + 300,
          y: -40,
          text: "Use window_map and source_map as the operator routing plan. Assign TOP sources manually, then open windows only after monitor layout is verified.",
        },
      ],
    },
    "create_window_output_matrix failed",
    (report) =>
      `Created Window output matrix ${report.container_path}; windows ${args.window_count}; resolution ${args.resolution_width}x${args.resolution_height}.`,
  );
}

export const registerCreateWindowOutputMatrix: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_window_output_matrix",
    {
      title: "Create Window output matrix",
      description:
        "Create a Window COMP output matrix scaffold with window maps, source maps, status, and setup notes.",
      inputSchema: createWindowOutputMatrixSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createWindowOutputMatrixImpl(ctx, args),
  );
};
