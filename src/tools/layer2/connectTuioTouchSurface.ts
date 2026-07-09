import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const connectTuioTouchSurfaceSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP for the TUIO surface scaffold."),
  name: z.string().default("tuio_touch_surface").describe("Generated baseCOMP name."),
  listen_port: z.coerce.number().int().min(1).max(65535).default(3333),
  surface_count: z.coerce.number().int().min(1).max(16).default(2),
  cursor_count: z.coerce.number().int().min(1).max(64).default(10),
  include_raw_osc: z.boolean().default(true),
  active: z.boolean().default(false),
});

type ConnectTuioTouchSurfaceArgs = z.infer<typeof connectTuioTouchSurfaceSchema>;

function surfaceRows(args: ConnectTuioTouchSurfaceArgs): string[][] {
  const rows = [["surface", "tuio_source", "target_panel"]];
  for (let index = 0; index < args.surface_count; index += 1) {
    rows.push([`surface_${index + 1}`, `/tuio/2Dcur`, `panel_${index + 1}`]);
  }
  return rows;
}

function cursorRows(args: ConnectTuioTouchSurfaceArgs): string[][] {
  const rows = [["cursor", "x_channel", "y_channel", "state_channel"]];
  for (let index = 0; index < args.cursor_count; index += 1) {
    rows.push([String(index), `cursor${index}_x`, `cursor${index}_y`, `cursor${index}_state`]);
  }
  return rows;
}

export async function connectTuioTouchSurfaceImpl(
  ctx: ToolContext,
  args: ConnectTuioTouchSurfaceArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "tuio_touch_surface",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        listen_port: args.listen_port,
        surface_count: args.surface_count,
        cursor_count: args.cursor_count,
        include_raw_osc: args.include_raw_osc,
        active: args.active,
      },
      warnings: [
        "TUIO input is unauthenticated UDP; use trusted networks for public installations.",
        "Normalize cursor IDs and surface coordinates before binding them to destructive or show-critical controls.",
      ],
      nodes: [
        {
          name: "tuio_in",
          optype: "tuioinDAT",
          x: 0,
          y: 120,
          params: { active: args.active ? 1 : 0, port: args.listen_port },
        },
        {
          name: "raw_osc",
          optype: "oscinDAT",
          x: 0,
          y: -40,
          params: { active: args.include_raw_osc && args.active ? 1 : 0, port: args.listen_port },
        },
        { name: "surface_map", optype: "tableDAT", x: 300, y: 120, table: surfaceRows(args) },
        { name: "cursor_map", optype: "tableDAT", x: 600, y: 120, table: cursorRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["listen_port", String(args.listen_port)],
            ["surface_count", String(args.surface_count)],
            ["cursor_count", String(args.cursor_count)],
            ["include_raw_osc", String(args.include_raw_osc)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Route TUIO cursor rows through surface_map, clamp coordinates per panel, and keep raw_osc disabled unless debugging incoming packets.",
        },
      ],
    },
    "connect_tuio_touch_surface failed",
    (report) =>
      `Created TUIO touch surface ${report.container_path}; surfaces ${args.surface_count}; port ${args.listen_port}.`,
  );
}

export const registerConnectTuioTouchSurface: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_tuio_touch_surface",
    {
      title: "Connect TUIO touch surface",
      description:
        "Create a TUIO touch-surface scaffold with TUIO DAT, optional raw OSC, cursor maps, and surface maps.",
      inputSchema: connectTuioTouchSurfaceSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectTuioTouchSurfaceImpl(ctx, args),
  );
};
