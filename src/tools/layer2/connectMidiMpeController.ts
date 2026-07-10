import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const connectMidiMpeControllerSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the MPE scaffold."),
  name: z.string().default("midi_mpe_controller").describe("Generated baseCOMP name."),
  device_name: z.string().default("MPE Controller"),
  lower_zone_channels: z.coerce.number().int().min(1).max(15).default(15),
  include_output: z.boolean().default(false),
  expression_count: z.coerce.number().int().min(1).max(32).default(5),
  active: z.boolean().default(false),
});

type ConnectMidiMpeControllerArgs = z.infer<typeof connectMidiMpeControllerSchema>;

const EXPRESSIONS = ["note", "velocity", "pressure", "timbre", "pitchbend"];

function expressionRows(args: ConnectMidiMpeControllerArgs): string[][] {
  const rows = [["expression", "midi_hint", "visual_use"]];
  for (let index = 0; index < args.expression_count; index += 1) {
    const expression = EXPRESSIONS[index] ?? `expression_${index + 1}`;
    rows.push([expression, `mpe:${expression}`, index < 2 ? "trigger" : "continuous"]);
  }
  return rows;
}

function zoneRows(args: ConnectMidiMpeControllerArgs): string[][] {
  const rows = [["zone", "member_channels", "master_channel"]];
  rows.push(["lower", `2-${args.lower_zone_channels + 1}`, "1"]);
  return rows;
}

export async function connectMidiMpeControllerImpl(
  ctx: ToolContext,
  args: ConnectMidiMpeControllerArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "midi_mpe_controller",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        device_name: args.device_name,
        lower_zone_channels: args.lower_zone_channels,
        include_output: args.include_output,
        expression_count: args.expression_count,
        active: args.active,
      },
      warnings: [
        "MPE channel naming varies by controller and TouchDesigner MIDI settings; learn channels from the live midiinCHOP before binding.",
        "Outbound MIDI is disabled unless include_output is true and should be tested away from physical instruments first.",
      ],
      nodes: [
        {
          name: "mpe_in",
          optype: "midiinCHOP",
          x: 0,
          y: 120,
          params: { active: args.active ? 1 : 0, device: args.device_name },
        },
        ...(args.include_output
          ? [
              {
                name: "mpe_out",
                optype: "midioutCHOP",
                x: 0,
                y: -40,
                params: { active: args.active ? 1 : 0, device: args.device_name },
              },
            ]
          : []),
        { name: "zone_map", optype: "tableDAT", x: 300, y: 120, table: zoneRows(args) },
        {
          name: "expression_map",
          optype: "tableDAT",
          x: 600,
          y: 120,
          table: expressionRows(args),
        },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["device_name", args.device_name],
            ["lower_zone_channels", String(args.lower_zone_channels)],
            ["include_output", String(args.include_output)],
            ["expression_count", String(args.expression_count)],
            ["active", String(args.active)],
          ],
        },
      ],
    },
    "connect_midi_mpe_controller failed",
    (report) =>
      `Created MIDI MPE controller scaffold ${report.container_path}; expressions ${args.expression_count}; lower-zone channels ${args.lower_zone_channels}.`,
  );
}

export const registerConnectMidiMpeController: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_midi_mpe_controller",
    {
      title: "Connect MIDI MPE controller",
      description:
        "Create an expressive MIDI MPE input/output scaffold with zone and expression maps for pressure, timbre, pitch bend, and note channels.",
      inputSchema: connectMidiMpeControllerSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectMidiMpeControllerImpl(ctx, args),
  );
};
