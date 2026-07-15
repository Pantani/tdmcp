import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const createNdiRouterMatrixSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the NDI matrix."),
  name: z.string().default("ndi_router_matrix").describe("Generated baseCOMP name."),
  source_count: z.coerce.number().int().min(1).max(128).default(8),
  output_count: z.coerce.number().int().min(1).max(32).default(4),
  include_preview: z.boolean().default(true),
  active: z.boolean().default(false),
});

type CreateNdiRouterMatrixArgs = z.infer<typeof createNdiRouterMatrixSchema>;

function sourceRows(args: CreateNdiRouterMatrixArgs): string[][] {
  const rows = [["source", "ndi_name", "validated", "notes"]];
  for (let source = 1; source <= args.source_count; source += 1) {
    rows.push([
      `source_${source}`,
      `NDI Source ${source}`,
      "false",
      "Fill after live NDI discovery.",
    ]);
  }
  return rows;
}

function routeRows(args: CreateNdiRouterMatrixArgs): string[][] {
  const rows = [["output", "selected_source", "mode"]];
  for (let output = 1; output <= args.output_count; output += 1) {
    rows.push([`output_${output}`, "source_1", "manual"]);
  }
  return rows;
}

export async function createNdiRouterMatrixImpl(ctx: ToolContext, args: CreateNdiRouterMatrixArgs) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "ndi_router_matrix",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        source_count: args.source_count,
        output_count: args.output_count,
        include_preview: args.include_preview,
        active: args.active,
      },
      warnings: [
        "This scaffold does not enumerate live NDI sources.",
        "Use source_map as the rehearsed contract before binding live input TOPs.",
      ],
      nodes: [
        { name: "source_map", optype: "tableDAT", x: 0, y: 120, table: sourceRows(args) },
        { name: "route_matrix", optype: "tableDAT", x: 300, y: 120, table: routeRows(args) },
        {
          name: "preview_receiver",
          optype: args.include_preview ? "ndiinTOP" : "textDAT",
          x: 600,
          y: 120,
          params: args.include_preview ? { active: args.active ? 1 : 0 } : undefined,
          text: args.include_preview ? undefined : "Preview receiver disabled.",
        },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["source_count", String(args.source_count)],
            ["output_count", String(args.output_count)],
            ["include_preview", String(args.include_preview)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Fill source_map with discovered NDI sender names, then use route_matrix as the routing contract for switchers, recorders, and preview surfaces.",
        },
      ],
    },
    "create_ndi_router_matrix failed",
    (report) =>
      `Created NDI router matrix ${report.container_path}; sources ${args.source_count}; outputs ${args.output_count}.`,
  );
}

export const registerCreateNdiRouterMatrix: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_ndi_router_matrix",
    {
      title: "Create NDI router matrix",
      description:
        "Create a stable NDI source/output routing matrix scaffold without claiming live NDI discovery.",
      inputSchema: createNdiRouterMatrixSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createNdiRouterMatrixImpl(ctx, args),
  );
};
