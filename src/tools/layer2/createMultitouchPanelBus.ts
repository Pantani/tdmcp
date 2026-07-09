import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const createMultitouchPanelBusSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP for the Multi Touch panel scaffold."),
  name: z.string().default("multitouch_panel_bus").describe("Generated baseCOMP name."),
  panel_count: z.coerce.number().int().min(1).max(16).default(4),
  max_touches: z.coerce.number().int().min(1).max(64).default(10),
  mouse_as_touch: z.boolean().default(false),
  active: z.boolean().default(false),
});

type CreateMultitouchPanelBusArgs = z.infer<typeof createMultitouchPanelBusSchema>;

function panelRows(args: CreateMultitouchPanelBusArgs): string[][] {
  const rows = [["panel", "bounds_hint", "touch_policy"]];
  for (let index = 0; index < args.panel_count; index += 1) {
    rows.push([`panel_${index + 1}`, "u/v/min/max", index === 0 ? "primary" : "secondary"]);
  }
  return rows;
}

function touchRows(args: CreateMultitouchPanelBusArgs): string[][] {
  const rows = [["touch", "x_channel", "y_channel", "state_channel"]];
  for (let index = 0; index < args.max_touches; index += 1) {
    rows.push([String(index), `touch${index}_x`, `touch${index}_y`, `touch${index}_state`]);
  }
  return rows;
}

export async function createMultitouchPanelBusImpl(
  ctx: ToolContext,
  args: CreateMultitouchPanelBusArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "multitouch_panel_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        panel_count: args.panel_count,
        max_touches: args.max_touches,
        mouse_as_touch: args.mouse_as_touch,
        active: args.active,
      },
      warnings: [
        "Multi Touch In DAT is Windows-specific; macOS TouchDesigner builds will not validate this live.",
        "Mouse-as-touch can collide with real touch IDs; keep it off for production touch walls unless explicitly testing.",
      ],
      nodes: [
        {
          name: "multi_touch_in",
          optype: "multitouchinDAT",
          x: 0,
          y: 120,
          params: { active: args.active ? 1 : 0, mouse: args.mouse_as_touch ? 1 : 0 },
        },
        {
          name: "touch_panel",
          optype: "containerCOMP",
          x: 0,
          y: -40,
          params: { multitouch: 1 },
        },
        { name: "panel_map", optype: "tableDAT", x: 300, y: 120, table: panelRows(args) },
        { name: "touch_map", optype: "tableDAT", x: 600, y: 120, table: touchRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["panel_count", String(args.panel_count)],
            ["max_touches", String(args.max_touches)],
            ["mouse_as_touch", String(args.mouse_as_touch)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use multi_touch_in events to drive panel_map hit testing. Disable built-in first-touch behavior on panels if custom scripts own multitouch handling.",
        },
      ],
    },
    "create_multitouch_panel_bus failed",
    (report) =>
      `Created Multi Touch panel bus ${report.container_path}; panels ${args.panel_count}; touches ${args.max_touches}.`,
  );
}

export const registerCreateMultitouchPanelBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_multitouch_panel_bus",
    {
      title: "Create Multi Touch panel bus",
      description:
        "Create a Windows Multi Touch In DAT scaffold with panel maps, touch-slot maps, and platform notes.",
      inputSchema: createMultitouchPanelBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createMultitouchPanelBusImpl(ctx, args),
  );
};
