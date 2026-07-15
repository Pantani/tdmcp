import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const createVcvRackBridgeSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the VCV scaffold."),
  name: z.string().default("vcv_rack_bridge").describe("Generated baseCOMP name."),
  mode: z.enum(["osc", "midi", "cv_audio", "manual"]).default("osc"),
  rack_host: z.string().default("127.0.0.1"),
  send_port: z.coerce.number().int().min(1).max(65535).default(12000),
  receive_port: z.coerce.number().int().min(1).max(65535).default(12001),
  midi_device: z.string().optional(),
  channel_count: z.coerce.number().int().min(1).max(64).default(8),
  bipolar: z.boolean().default(true),
  active: z.boolean().default(false),
});

type CreateVcvRackBridgeArgs = z.infer<typeof createVcvRackBridgeSchema>;

function channelRows(args: CreateVcvRackBridgeArgs): string[][] {
  const range = args.bipolar ? "-1..1" : "0..1";
  const rows = [["channel", "address_or_cc", "range", "note"]];
  for (let channel = 1; channel <= args.channel_count; channel += 1) {
    rows.push([
      `mod_${channel}`,
      args.mode === "midi" ? `cc${channel}` : `/tdmcp/mod/${channel}`,
      range,
      "Map to VCV CV-MAP, MIDI-CV, or OSC-capable module.",
    ]);
  }
  return rows;
}

type VcvSourceNodeFactory = (args: CreateVcvRackBridgeArgs) => ExternalShowNodeSpec[];

const sourceNodeFactories: Record<CreateVcvRackBridgeArgs["mode"], VcvSourceNodeFactory> = {
  osc: oscSourceNodes,
  midi: midiSourceNodes,
  cv_audio: manualSourceNodes,
  manual: manualSourceNodes,
};

function oscSourceNodes(args: CreateVcvRackBridgeArgs): ExternalShowNodeSpec[] {
  return [
    {
      name: "osc_out",
      optype: "oscoutCHOP",
      x: 0,
      y: 120,
      params: { netaddress: args.rack_host, port: args.send_port, active: args.active ? 1 : 0 },
    },
    {
      name: "osc_in",
      optype: "oscinCHOP",
      x: 0,
      y: -40,
      params: { port: args.receive_port, active: args.active ? 1 : 0 },
    },
  ];
}

function midiSourceNodes(args: CreateVcvRackBridgeArgs): ExternalShowNodeSpec[] {
  return [
    {
      name: "midi_out",
      optype: "midioutCHOP",
      x: 0,
      y: 120,
      params: { device: args.midi_device ?? "", active: args.active ? 1 : 0 },
    },
    {
      name: "midi_in",
      optype: "midiinCHOP",
      x: 0,
      y: -40,
      params: { device: args.midi_device ?? "", active: args.active ? 1 : 0 },
    },
  ];
}

function manualSourceNodes(args: CreateVcvRackBridgeArgs): ExternalShowNodeSpec[] {
  return [
    {
      name: "manual_bridge_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: `${args.mode} mode selected. Use channel_map as the canonical modulation contract.`,
    },
  ];
}

function sourceNodes(args: CreateVcvRackBridgeArgs): ExternalShowNodeSpec[] {
  return sourceNodeFactories[args.mode](args);
}

export async function createVcvRackBridgeImpl(ctx: ToolContext, args: CreateVcvRackBridgeArgs) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "vcv_rack_bridge",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        mode: args.mode,
        rack_host: args.rack_host,
        send_port: args.send_port,
        receive_port: args.receive_port,
        midi_device: args.midi_device ?? null,
        channel_count: args.channel_count,
        bipolar: args.bipolar,
        active: args.active,
      },
      warnings: [
        "VCV Rack must be configured separately with OSC/MIDI/CV modules; this scaffold does not validate Rack live.",
        "Avoid routing high-amplitude audio CV to speakers without limiting and monitoring.",
      ],
      nodes: [
        ...sourceNodes(args),
        { name: "channel_map", optype: "tableDAT", x: 300, y: 120, table: channelRows(args) },
        { name: "modulation_out", optype: "nullCHOP", x: 600, y: 120 },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["mode", args.mode],
            ["channel_count", String(args.channel_count)],
            ["bipolar", String(args.bipolar)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Map TD channels to VCV Rack via OSC or MIDI. Keep channel_map stable so visual patches and Rack patches can be rehearsed independently.",
        },
      ],
    },
    "create_vcv_rack_bridge failed",
    (report) =>
      `Created VCV Rack bridge ${report.container_path}; mode ${args.mode}; channels ${args.channel_count}.`,
  );
}

export const registerCreateVcvRackBridge: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_vcv_rack_bridge",
    {
      title: "Create VCV Rack bridge",
      description:
        "Create a VCV Rack OSC/MIDI/CV modulation bridge scaffold with channel mapping and setup notes.",
      inputSchema: createVcvRackBridgeSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createVcvRackBridgeImpl(ctx, args),
  );
};
