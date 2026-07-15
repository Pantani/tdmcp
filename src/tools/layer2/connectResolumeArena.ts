import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const connectResolumeArenaSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the Resolume scaffold."),
  name: z.string().default("resolume_arena").describe("Generated baseCOMP name."),
  resolume_host: z.string().default("127.0.0.1").describe("Resolume OSC host."),
  send_port: z.coerce.number().int().min(1).max(65535).default(7000),
  receive_port: z.coerce.number().int().min(1).max(65535).default(7001),
  composition_name: z.string().default("composition").describe("Label stored in status metadata."),
  deck_count: z.coerce.number().int().min(1).max(16).default(1),
  layer_count: z.coerce.number().int().min(1).max(32).default(3),
  clip_count: z.coerce.number().int().min(1).max(128).default(8),
  preview_mode: z.enum(["none", "ndi", "syphon_spout"]).default("none"),
  active: z.boolean().default(false).describe("Activate OSC operators immediately."),
});

type ConnectResolumeArenaArgs = z.infer<typeof connectResolumeArenaSchema>;

function commandRows(args: ConnectResolumeArenaArgs): string[][] {
  const rows = [["label", "address", "value_hint"]];
  rows.push(["composition bpm", "/composition/tempocontroller/tempotap", "pulse"]);
  rows.push(["composition speed", "/composition/speed", "0..1"]);
  rows.push(["deck select", "/composition/decks/{deck}/select", `1..${args.deck_count}`]);
  for (let layer = 1; layer <= args.layer_count; layer += 1) {
    rows.push([`layer ${layer} opacity`, `/composition/layers/${layer}/video/opacity`, "0..1"]);
    rows.push([
      `layer ${layer} connect clip`,
      `/composition/layers/${layer}/clips/{clip}/connect`,
      `1..${args.clip_count}`,
    ]);
  }
  return rows;
}

export async function connectResolumeArenaImpl(ctx: ToolContext, args: ConnectResolumeArenaArgs) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "resolume_arena",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        resolume_host: args.resolume_host,
        send_port: args.send_port,
        receive_port: args.receive_port,
        composition_name: args.composition_name,
        deck_count: args.deck_count,
        layer_count: args.layer_count,
        clip_count: args.clip_count,
        preview_mode: args.preview_mode,
        active: args.active,
      },
      warnings: [
        "Resolume must have OSC enabled manually; this scaffold does not validate Arena/Avenue live.",
        "Confirm Resolume's OSC input/output ports match the generated TD operators.",
      ],
      nodes: [
        {
          name: "osc_out",
          optype: "oscoutCHOP",
          x: 0,
          y: 120,
          params: {
            netaddress: args.resolume_host,
            port: args.send_port,
            active: args.active ? 1 : 0,
          },
        },
        {
          name: "osc_in",
          optype: "oscinCHOP",
          x: 0,
          y: -40,
          params: { port: args.receive_port, active: args.active ? 1 : 0 },
        },
        { name: "command_map", optype: "tableDAT", x: 300, y: 120, table: commandRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["host", args.resolume_host],
            ["send_port", String(args.send_port)],
            ["receive_port", String(args.receive_port)],
            ["preview_mode", args.preview_mode],
            ["active", String(args.active)],
          ],
        },
        {
          name: "preview_config",
          optype: "textDAT",
          x: 600,
          y: 120,
          text: `Preview mode: ${args.preview_mode}. Configure Resolume and TD manually for NDI or Syphon/Spout capture.`,
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Enable OSC in Resolume Preferences > OSC. Use command_map rows as address templates. Clip/layer numbers are 1-based for operator-facing notes; verify against your Resolume OSC shortcut export.",
        },
      ],
    },
    "connect_resolume_arena failed",
    (report) =>
      `Created Resolume OSC scaffold ${report.container_path}; commands ${report.nodes?.command_map}; OSC send ${args.resolume_host}:${args.send_port}.`,
  );
}

export const registerConnectResolumeArena: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_resolume_arena",
    {
      title: "Connect Resolume Arena",
      description:
        "Create a Resolume Arena/Avenue OSC control scaffold with command maps, status DATs, and preview handoff notes. Runtime validation against Resolume remains explicit.",
      inputSchema: connectResolumeArenaSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectResolumeArenaImpl(ctx, args),
  );
};
