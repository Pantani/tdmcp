import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const connectSupercolliderSynthSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the scaffold."),
  name: z.string().default("supercollider_synth").describe("Generated baseCOMP name."),
  sc_host: z.string().default("127.0.0.1"),
  send_port: z.coerce.number().int().min(1).max(65535).default(57120),
  receive_port: z.coerce.number().int().min(1).max(65535).default(57121),
  synth_count: z.coerce.number().int().min(1).max(128).default(4),
  bus_count: z.coerce.number().int().min(1).max(128).default(8),
  active: z.boolean().default(false),
});

type ConnectSupercolliderSynthArgs = z.infer<typeof connectSupercolliderSynthSchema>;

function synthRows(args: ConnectSupercolliderSynthArgs): string[][] {
  const rows = [["synth", "trigger_address", "param_address"]];
  for (let synth = 1; synth <= args.synth_count; synth += 1) {
    rows.push([`synth_${synth}`, `/tdmcp/synth/${synth}/trigger`, `/tdmcp/synth/${synth}/param`]);
  }
  return rows;
}

function busRows(args: ConnectSupercolliderSynthArgs): string[][] {
  const rows = [["bus", "address", "value_hint"]];
  for (let bus = 0; bus < args.bus_count; bus += 1) {
    rows.push([`bus_${bus}`, `/tdmcp/bus/${bus}`, "0..1"]);
  }
  return rows;
}

export async function connectSupercolliderSynthImpl(
  ctx: ToolContext,
  args: ConnectSupercolliderSynthArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "supercollider_synth",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        sc_host: args.sc_host,
        send_port: args.send_port,
        receive_port: args.receive_port,
        synth_count: args.synth_count,
        bus_count: args.bus_count,
        active: args.active,
      },
      warnings: [
        "This scaffold sends OSC maps only; it does not evaluate SuperCollider code or boot scsynth.",
        "Keep high-gain audio actions operator-reviewed when linked to venue PA or monitoring systems.",
      ],
      nodes: [
        {
          name: "osc_out",
          optype: "oscoutCHOP",
          x: 0,
          y: 120,
          params: { netaddress: args.sc_host, port: args.send_port, active: args.active ? 1 : 0 },
        },
        {
          name: "osc_in",
          optype: "oscinCHOP",
          x: 0,
          y: -40,
          params: { port: args.receive_port, active: args.active ? 1 : 0 },
        },
        { name: "synth_map", optype: "tableDAT", x: 300, y: 120, table: synthRows(args) },
        { name: "bus_map", optype: "tableDAT", x: 600, y: 120, table: busRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["sc_host", args.sc_host],
            ["send_port", String(args.send_port)],
            ["receive_port", String(args.receive_port)],
            ["synth_count", String(args.synth_count)],
            ["bus_count", String(args.bus_count)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Boot SuperCollider separately, align OSC ports, then map synth_map and bus_map addresses to your SynthDefs and control buses.",
        },
      ],
    },
    "connect_supercollider_synth failed",
    (report) =>
      `Created SuperCollider scaffold ${report.container_path}; synths ${args.synth_count}; buses ${args.bus_count}.`,
  );
}

export const registerConnectSupercolliderSynth: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_supercollider_synth",
    {
      title: "Connect SuperCollider synth",
      description:
        "Create a SuperCollider OSC synth/bus bridge scaffold with explicit port maps and no code-evaluation behavior.",
      inputSchema: connectSupercolliderSynthSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectSupercolliderSynthImpl(ctx, args),
  );
};
