import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const createArtnetDiscoveryPanelSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP for the Art-Net discovery scaffold."),
  name: z.string().default("artnet_discovery_panel").describe("Generated baseCOMP name."),
  net: z.coerce.number().int().min(0).max(127).default(0),
  subnet: z.coerce.number().int().min(0).max(15).default(0),
  universe_count: z.coerce.number().int().min(1).max(64).default(4),
  device_count: z.coerce.number().int().min(1).max(128).default(8),
  include_dmx_monitor: z.boolean().default(true),
  active: z.boolean().default(false),
});

type CreateArtnetDiscoveryPanelArgs = z.infer<typeof createArtnetDiscoveryPanelSchema>;

function deviceRows(args: CreateArtnetDiscoveryPanelArgs): string[][] {
  const rows = [["device", "ip_hint", "role"]];
  for (let index = 0; index < args.device_count; index += 1) {
    rows.push([`node_${index + 1}`, `2.0.0.${index + 10}`, index === 0 ? "controller" : "fixture"]);
  }
  return rows;
}

function universeRows(args: CreateArtnetDiscoveryPanelArgs): string[][] {
  const rows = [["universe", "net", "subnet", "monitor"]];
  for (let index = 0; index < args.universe_count; index += 1) {
    rows.push([String(index), String(args.net), String(args.subnet), `dmx_universe_${index}`]);
  }
  return rows;
}

export async function createArtnetDiscoveryPanelImpl(
  ctx: ToolContext,
  args: CreateArtnetDiscoveryPanelArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "artnet_discovery_panel",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        net: args.net,
        subnet: args.subnet,
        universe_count: args.universe_count,
        device_count: args.device_count,
        include_dmx_monitor: args.include_dmx_monitor,
        active: args.active,
      },
      warnings: [
        "Art-Net polling can expose or disturb venue network assumptions; use the show VLAN or an isolated test network.",
        "The DMX monitor is diagnostic only; do not route monitored fixture channels back to live hardware without a safety policy.",
      ],
      nodes: [
        {
          name: "artnet_devices",
          optype: "artnetDAT",
          x: 0,
          y: 120,
          params: { active: args.active ? 1 : 0 },
        },
        {
          name: "dmx_monitor",
          optype: "dmxinCHOP",
          x: 0,
          y: -40,
          params: {
            active: args.include_dmx_monitor && args.active ? 1 : 0,
            interface: "artnet",
            net: args.net,
            subnet: args.subnet,
          },
        },
        { name: "device_map", optype: "tableDAT", x: 300, y: 120, table: deviceRows(args) },
        { name: "universe_map", optype: "tableDAT", x: 600, y: 120, table: universeRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["net", String(args.net)],
            ["subnet", String(args.subnet)],
            ["universe_count", String(args.universe_count)],
            ["device_count", String(args.device_count)],
            ["include_dmx_monitor", String(args.include_dmx_monitor)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use artnet_devices to poll nodes, compare device_map against the venue patch, and keep dmx_monitor diagnostic until physical output is approved.",
        },
      ],
    },
    "create_artnet_discovery_panel failed",
    (report) =>
      `Created Art-Net discovery panel ${report.container_path}; devices ${args.device_count}; universes ${args.universe_count}.`,
  );
}

export const registerCreateArtnetDiscoveryPanel: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_artnet_discovery_panel",
    {
      title: "Create Art-Net discovery panel",
      description:
        "Create an Art-Net DAT discovery scaffold with optional DMX In monitor, device maps, and universe maps.",
      inputSchema: createArtnetDiscoveryPanelSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createArtnetDiscoveryPanelImpl(ctx, args),
  );
};
