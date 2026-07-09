import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const createDirectDisplayOutputSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP for the Direct Display output scaffold."),
  name: z.string().default("direct_display_output").describe("Generated baseCOMP name."),
  display_index: z.coerce.number().int().min(0).max(16).default(0),
  output_count: z.coerce.number().int().min(1).max(3).default(1),
  resolution_width: z.coerce.number().int().min(320).max(16384).default(1920),
  resolution_height: z.coerce.number().int().min(240).max(16384).default(1080),
  active: z.boolean().default(false),
});

type CreateDirectDisplayOutputArgs = z.infer<typeof createDirectDisplayOutputSchema>;

function displayRows(args: CreateDirectDisplayOutputArgs): string[][] {
  const rows = [["output", "display_index", "resolution"]];
  for (let index = 0; index < args.output_count; index += 1) {
    rows.push([
      `output_${index + 1}`,
      String(args.display_index + index),
      `${args.resolution_width}x${args.resolution_height}`,
    ]);
  }
  return rows;
}

export async function createDirectDisplayOutputImpl(
  ctx: ToolContext,
  args: CreateDirectDisplayOutputArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "direct_display_output",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        display_index: args.display_index,
        output_count: args.output_count,
        resolution_width: args.resolution_width,
        resolution_height: args.resolution_height,
        active: args.active,
      },
      warnings: [
        "Direct Display output bypasses normal desktop windows and must be tested on the target Windows/GPU display chain.",
        "Keep active=false until monitor IDs, cable routing, and emergency blackout behavior are confirmed.",
      ],
      nodes: [
        {
          name: "direct_display",
          optype: "directdisplayoutTOP",
          x: 0,
          y: 120,
          params: { active: args.active ? 1 : 0, display: args.display_index },
        },
        { name: "monitors", optype: "monitorsDAT", x: 0, y: -40 },
        { name: "display_map", optype: "tableDAT", x: 300, y: 120, table: displayRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["display_index", String(args.display_index)],
            ["output_count", String(args.output_count)],
            ["resolution", `${args.resolution_width}x${args.resolution_height}`],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Compare monitors with display_map before enabling direct_display. Direct Display is a show-output path, so rehearse blackout/failsafe first.",
        },
      ],
    },
    "create_direct_display_output failed",
    (report) =>
      `Created Direct Display output ${report.container_path}; display ${args.display_index}; outputs ${args.output_count}.`,
  );
}

export const registerCreateDirectDisplayOutput: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_direct_display_output",
    {
      title: "Create Direct Display output",
      description:
        "Create a Direct Display Out TOP scaffold with monitor inventory, display maps, and inactive-by-default safety notes.",
      inputSchema: createDirectDisplayOutputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createDirectDisplayOutputImpl(ctx, args),
  );
};
