import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const createViosoWarpPanelSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the VIOSO warp scaffold."),
  name: z.string().default("vioso_warp_panel").describe("Generated baseCOMP name."),
  config_file: z.string().default("").describe("Path to the VIOSO calibration/config file."),
  projector_index: z.coerce.number().int().min(0).max(255).default(0),
  blend_zone_count: z.coerce.number().int().min(1).max(128).default(4),
  active: z.boolean().default(false),
});

type CreateViosoWarpPanelArgs = z.infer<typeof createViosoWarpPanelSchema>;

function blendZoneRows(args: CreateViosoWarpPanelArgs): string[][] {
  const rows = [["blend_zone", "edge", "operator_check"]];
  const edges = ["left", "right", "top", "bottom"];
  for (let index = 0; index < args.blend_zone_count; index += 1) {
    rows.push([`blend_${index + 1}`, edges[index % edges.length] ?? "edge", "verify overlap"]);
  }
  return rows;
}

export async function createViosoWarpPanelImpl(ctx: ToolContext, args: CreateViosoWarpPanelArgs) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "vioso_warp_panel",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        config_file: args.config_file,
        projector_index: args.projector_index,
        blend_zone_count: args.blend_zone_count,
        active: args.active,
      },
      warnings: [
        "VIOSO TOP is TouchDesigner Pro-only and requires matching calibration assets.",
        "Keep VIOSO output inactive until projector index, blend zones, and edge alignment are verified live.",
      ],
      nodes: [
        {
          name: "vioso_warp",
          optype: "viosoTOP",
          x: 0,
          y: 120,
          params: {
            active: args.active ? 1 : 0,
            file: args.config_file,
            projectorindex: args.projector_index,
          },
        },
        { name: "warp_out", optype: "nullTOP", x: 300, y: 120 },
        {
          name: "projector_map",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["projector_index", String(args.projector_index)],
            ["config_file", args.config_file],
          ],
        },
        {
          name: "blend_zone_map",
          optype: "tableDAT",
          x: 600,
          y: 120,
          table: blendZoneRows(args),
        },
        {
          name: "status",
          optype: "tableDAT",
          x: 600,
          y: -40,
          table: [
            ["field", "value"],
            ["blend_zone_count", String(args.blend_zone_count)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 900,
          y: -40,
          text: "Load the VIOSO calibration, confirm projector_index with the venue map, then use blend_zone_map as the operator checklist before routing live content.",
        },
      ],
      connections: [{ from: "vioso_warp", to: "warp_out" }],
    },
    "create_vioso_warp_panel failed",
    (report) =>
      `Created VIOSO warp panel ${report.container_path}; projector ${args.projector_index}; blend zones ${args.blend_zone_count}.`,
  );
}

export const registerCreateViosoWarpPanel: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_vioso_warp_panel",
    {
      title: "Create VIOSO warp panel",
      description:
        "Create a VIOSO projection-warp scaffold with VIOSO TOP, blend-zone maps, projector metadata, and setup notes.",
      inputSchema: createViosoWarpPanelSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createViosoWarpPanelImpl(ctx, args),
  );
};
