import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const connectLightingConsoleOscSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP for the lighting-console OSC scaffold."),
  name: z.string().default("lighting_console_osc").describe("Generated baseCOMP name."),
  console_family: z
    .enum(["grandma3", "etc_eos", "chamsys", "avolites", "generic_osc"])
    .default("generic_osc"),
  console_host: z.string().default("127.0.0.1"),
  send_port: z.coerce.number().int().min(1).max(65535).default(8000),
  receive_port: z.coerce.number().int().min(1).max(65535).default(8001),
  cue_count: z.coerce.number().int().min(1).max(512).default(16),
  executor_count: z.coerce.number().int().min(1).max(128).default(8),
  safety_mode: z.enum(["dry_run", "approval_required"]).default("dry_run"),
  active: z.boolean().default(false),
});

type ConnectLightingConsoleOscArgs = z.infer<typeof connectLightingConsoleOscSchema>;

function commandRows(args: ConnectLightingConsoleOscArgs): string[][] {
  const rows = [["label", "address_template", "value_hint", "policy"]];
  for (let cue = 1; cue <= args.cue_count; cue += 1) {
    rows.push([`cue ${cue} go`, `/cue/${cue}/go`, "pulse", args.safety_mode]);
  }
  for (let executor = 1; executor <= args.executor_count; executor += 1) {
    rows.push([
      `executor ${executor} level`,
      `/executor/${executor}/level`,
      "0..1",
      args.safety_mode,
    ]);
  }
  rows.push(["blackout", "/blackout", "pulse", "approval_required"]);
  rows.push(["strobe", "/strobe", "0..1", "approval_required"]);
  return rows;
}

export async function connectLightingConsoleOscImpl(
  ctx: ToolContext,
  args: ConnectLightingConsoleOscArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "lighting_console_osc",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        console_family: args.console_family,
        console_host: args.console_host,
        send_port: args.send_port,
        receive_port: args.receive_port,
        cue_count: args.cue_count,
        executor_count: args.executor_count,
        safety_mode: args.safety_mode,
        active: args.active,
      },
      warnings: [
        "This scaffold creates console OSC templates only; it does not send direct DMX.",
        "Blackout, strobe, laser, fog, and moving-head actions must remain approval-gated and rehearsed.",
        "Console OSC address sets vary by show file and vendor; validate against the live console.",
      ],
      nodes: [
        {
          name: "osc_out",
          optype: "oscoutCHOP",
          x: 0,
          y: 120,
          params: {
            netaddress: args.console_host,
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
          name: "policy_gate",
          optype: "tableDAT",
          x: 600,
          y: 120,
          table: [
            ["action_family", "decision", "reason"],
            ["cue_executor", args.safety_mode, "Show-file commands require operator context."],
            [
              "blackout_strobe_laser_fog_moving_head",
              "approval_required",
              "Physical or hazardous output.",
            ],
            [
              "direct_dmx",
              "block",
              "Use existing DMX tools with explicit live enablement instead.",
            ],
          ],
        },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["console_family", args.console_family],
            ["host", args.console_host],
            ["send_port", String(args.send_port)],
            ["receive_port", String(args.receive_port)],
            ["safety_mode", args.safety_mode],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Map command_map rows to the console's real OSC syntax after a live-console rehearsal. This scaffold intentionally leaves hardware authority with the lighting operator and policy gate.",
        },
      ],
    },
    "connect_lighting_console_osc failed",
    (report) =>
      `Created lighting-console OSC scaffold ${report.container_path}; command map ${report.nodes?.command_map}; policy ${args.safety_mode}.`,
  );
}

export const registerConnectLightingConsoleOsc: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_lighting_console_osc",
    {
      title: "Connect lighting console OSC",
      description:
        "Create a safety-gated OSC command scaffold for grandMA3, ETC Eos, ChamSys, Avolites, or generic lighting consoles without sending direct DMX.",
      inputSchema: connectLightingConsoleOscSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectLightingConsoleOscImpl(ctx, args),
  );
};
