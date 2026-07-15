import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const createMonitorLayoutPanelSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP for the monitor layout scaffold."),
  name: z.string().default("monitor_layout_panel").describe("Generated baseCOMP name."),
  monitor_count: z.coerce.number().int().min(1).max(64).default(2),
  gpu_count: z.coerce.number().int().min(1).max(16).default(1),
  include_direct_display_hint: z.boolean().default(true),
});

type CreateMonitorLayoutPanelArgs = z.infer<typeof createMonitorLayoutPanelSchema>;

function monitorRows(args: CreateMonitorLayoutPanelArgs): string[][] {
  const rows = [["monitor", "gpu_hint", "role"]];
  for (let index = 0; index < args.monitor_count; index += 1) {
    rows.push([
      `monitor_${index + 1}`,
      `gpu_${(index % args.gpu_count) + 1}`,
      index === 0 ? "operator" : "output",
    ]);
  }
  return rows;
}

function gpuRows(args: CreateMonitorLayoutPanelArgs): string[][] {
  const rows = [["gpu", "outputs_hint", "operator_check"]];
  for (let index = 0; index < args.gpu_count; index += 1) {
    rows.push([`gpu_${index + 1}`, "DisplayPort/HDMI", "confirm driver and refresh rate"]);
  }
  return rows;
}

function preflightRows(args: CreateMonitorLayoutPanelArgs): string[][] {
  return [
    ["check", "required"],
    ["os_monitor_order_matches_map", "true"],
    ["refresh_rate_locked", "true"],
    ["blackout_path_rehearsed", "true"],
    ["direct_display_review", String(args.include_direct_display_hint)],
  ];
}

export async function createMonitorLayoutPanelImpl(
  ctx: ToolContext,
  args: CreateMonitorLayoutPanelArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "monitor_layout_panel",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        monitor_count: args.monitor_count,
        gpu_count: args.gpu_count,
        include_direct_display_hint: args.include_direct_display_hint,
      },
      warnings: [
        "Monitor ordering can change after OS updates, GPU driver changes, or cable swaps.",
        "Use this panel as a preflight inventory; it does not prove live output routing by itself.",
      ],
      nodes: [
        { name: "monitors", optype: "monitorsDAT", x: 0, y: 120 },
        { name: "monitor_map", optype: "tableDAT", x: 300, y: 120, table: monitorRows(args) },
        { name: "gpu_map", optype: "tableDAT", x: 600, y: 120, table: gpuRows(args) },
        { name: "preflight", optype: "tableDAT", x: 300, y: -40, table: preflightRows(args) },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Compare monitorsDAT against monitor_map before opening windows or Direct Display outputs. Re-run after every venue cable or driver change.",
        },
      ],
    },
    "create_monitor_layout_panel failed",
    (report) =>
      `Created monitor layout panel ${report.container_path}; monitors ${args.monitor_count}; GPUs ${args.gpu_count}.`,
  );
}

export const registerCreateMonitorLayoutPanel: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_monitor_layout_panel",
    {
      title: "Create monitor layout panel",
      description:
        "Create a Monitors DAT inventory scaffold with monitor maps, GPU maps, preflight checks, and setup notes.",
      inputSchema: createMonitorLayoutPanelSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createMonitorLayoutPanelImpl(ctx, args),
  );
};
