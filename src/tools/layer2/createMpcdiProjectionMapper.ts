import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const createMpcdiProjectionMapperSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP for the MPCDI projection mapper scaffold."),
  name: z.string().default("mpcdi_projection_mapper").describe("Generated baseCOMP name."),
  config_file: z.string().default("").describe("Path to the MPCDI calibration/config file."),
  projector_count: z.coerce.number().int().min(1).max(64).default(2),
  region_count: z.coerce.number().int().min(1).max(128).default(4),
  active: z.boolean().default(false),
});

type CreateMpcdiProjectionMapperArgs = z.infer<typeof createMpcdiProjectionMapperSchema>;

function projectorRows(args: CreateMpcdiProjectionMapperArgs): string[][] {
  const rows = [["projector", "region_hint", "operator_check"]];
  for (let index = 0; index < args.projector_count; index += 1) {
    rows.push([`projector_${index + 1}`, `region_${index + 1}`, "confirm blend/warp live"]);
  }
  return rows;
}

function regionRows(args: CreateMpcdiProjectionMapperArgs): string[][] {
  const rows = [["region", "projector_hint", "content_role"]];
  for (let index = 0; index < args.region_count; index += 1) {
    rows.push([`region_${index + 1}`, `projector_${(index % args.projector_count) + 1}`, "slice"]);
  }
  return rows;
}

export async function createMpcdiProjectionMapperImpl(
  ctx: ToolContext,
  args: CreateMpcdiProjectionMapperArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "mpcdi_projection_mapper",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        config_file: args.config_file,
        projector_count: args.projector_count,
        region_count: args.region_count,
        active: args.active,
      },
      warnings: [
        "MPCDI calibration files must be verified against the physical projector rig before show output.",
        "This scaffold does not validate the calibration file on disk or prove projector alignment live.",
      ],
      nodes: [
        {
          name: "mpcdi_warp",
          optype: "mpcdiTOP",
          x: 0,
          y: 120,
          params: { active: args.active ? 1 : 0, file: args.config_file },
        },
        {
          name: "mpcdi_info",
          optype: "mpcdiDAT",
          x: 0,
          y: -40,
          params: { file: args.config_file },
        },
        { name: "warp_out", optype: "nullTOP", x: 300, y: 120 },
        {
          name: "projector_map",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: projectorRows(args),
        },
        { name: "region_map", optype: "tableDAT", x: 600, y: 120, table: regionRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 600,
          y: -40,
          table: [
            ["field", "value"],
            ["config_file", args.config_file],
            ["projector_count", String(args.projector_count)],
            ["region_count", String(args.region_count)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 900,
          y: -40,
          text: "Load the MPCDI file, inspect mpcdi_info, then route content through mpcdi_warp only after regions and projector_map match the venue calibration.",
        },
      ],
      connections: [{ from: "mpcdi_warp", to: "warp_out" }],
    },
    "create_mpcdi_projection_mapper failed",
    (report) =>
      `Created MPCDI projection mapper ${report.container_path}; projectors ${args.projector_count}; regions ${args.region_count}.`,
  );
}

export const registerCreateMpcdiProjectionMapper: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_mpcdi_projection_mapper",
    {
      title: "Create MPCDI projection mapper",
      description:
        "Create an MPCDI projection-calibration scaffold with MPCDI TOP/DAT, projector maps, region maps, and setup notes.",
      inputSchema: createMpcdiProjectionMapperSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createMpcdiProjectionMapperImpl(ctx, args),
  );
};
