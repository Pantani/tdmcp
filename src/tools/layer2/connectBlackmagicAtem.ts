import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const connectBlackmagicAtemSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the ATEM scaffold."),
  name: z.string().default("blackmagic_atem").describe("Generated baseCOMP name."),
  atem_host: z.string().default("192.168.10.240").describe("Blackmagic ATEM switcher host."),
  send_port: z.coerce.number().int().min(1).max(65535).default(9910),
  receive_port: z.coerce.number().int().min(1).max(65535).default(9911),
  input_count: z.coerce.number().int().min(1).max(64).default(8),
  macro_count: z.coerce.number().int().min(0).max(256).default(8),
  include_cut_auto: z.boolean().default(true),
  active: z.boolean().default(false),
});

type ConnectBlackmagicAtemArgs = z.infer<typeof connectBlackmagicAtemSchema>;

function inputRows(args: ConnectBlackmagicAtemArgs): string[][] {
  const rows = [["input", "program_command", "preview_command"]];
  for (let input = 1; input <= args.input_count; input += 1) {
    rows.push([`input_${input}`, `program:${input}`, `preview:${input}`]);
  }
  return rows;
}

function actionRows(args: ConnectBlackmagicAtemArgs): string[][] {
  const rows = [["label", "command", "approval"]];
  if (args.include_cut_auto) {
    rows.push(["cut", "transition:cut", "operator"]);
    rows.push(["auto", "transition:auto", "operator"]);
  }
  for (let macro = 1; macro <= args.macro_count; macro += 1) {
    rows.push([`macro_${macro}`, `macro:run:${macro}`, "operator"]);
  }
  return rows;
}

export async function connectBlackmagicAtemImpl(ctx: ToolContext, args: ConnectBlackmagicAtemArgs) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "blackmagic_atem",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        atem_host: args.atem_host,
        send_port: args.send_port,
        receive_port: args.receive_port,
        input_count: args.input_count,
        macro_count: args.macro_count,
        include_cut_auto: args.include_cut_auto,
        active: args.active,
      },
      warnings: [
        "ATEM control uses a binary protocol; this is a command-map scaffold, not a live driver.",
        "Program, preview, macro, cut, and auto commands should remain operator-approved.",
      ],
      nodes: [
        {
          name: "udp_out",
          optype: "udpoutDAT",
          x: 0,
          y: 120,
          params: { netaddress: args.atem_host, port: args.send_port, active: args.active ? 1 : 0 },
        },
        {
          name: "udp_in",
          optype: "udpinDAT",
          x: 0,
          y: -40,
          params: { port: args.receive_port, active: args.active ? 1 : 0 },
        },
        { name: "input_map", optype: "tableDAT", x: 300, y: 120, table: inputRows(args) },
        { name: "action_map", optype: "tableDAT", x: 600, y: 120, table: actionRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["host", args.atem_host],
            ["send_port", String(args.send_port)],
            ["receive_port", String(args.receive_port)],
            ["input_count", String(args.input_count)],
            ["macro_count", String(args.macro_count)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use this ATEM scaffold as a wiring map for an approved ATEM extension or script. Do not send unreviewed binary switcher commands from show-control automation.",
        },
      ],
    },
    "connect_blackmagic_atem failed",
    (report) =>
      `Created Blackmagic ATEM scaffold ${report.container_path}; inputs ${args.input_count}; macros ${args.macro_count}.`,
  );
}

export const registerConnectBlackmagicAtem: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_blackmagic_atem",
    {
      title: "Connect Blackmagic ATEM",
      description:
        "Create a Blackmagic ATEM command-map scaffold with UDP transport placeholders, input maps, macro maps, and operator approval notes.",
      inputSchema: connectBlackmagicAtemSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectBlackmagicAtemImpl(ctx, args),
  );
};
