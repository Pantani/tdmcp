import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const connectQlabCueStackSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the QLab scaffold."),
  name: z.string().default("qlab_cue_stack").describe("Generated baseCOMP name."),
  qlab_host: z.string().default("127.0.0.1").describe("QLab OSC host."),
  send_port: z.coerce.number().int().min(1).max(65535).default(53000),
  receive_port: z.coerce.number().int().min(1).max(65535).default(53001),
  workspace_id: z.string().optional().describe("Optional QLab workspace identifier/label."),
  cue_count: z.coerce.number().int().min(1).max(256).default(16),
  include_transport: z.boolean().default(true).describe("Include GO/STOP/PAUSE/RESUME rows."),
  active: z.boolean().default(false).describe("Activate OSC operators immediately."),
});

type ConnectQlabCueStackArgs = z.infer<typeof connectQlabCueStackSchema>;

function cueRows(args: ConnectQlabCueStackArgs): string[][] {
  const rows = [["label", "address", "value_hint", "risk"]];
  if (args.include_transport) {
    rows.push(["go", "/go", "pulse", "show-control"]);
    rows.push(["stop all", "/panic", "pulse", "requires rehearsal"]);
    rows.push(["pause all", "/pause", "pulse", "show-control"]);
    rows.push(["resume all", "/resume", "pulse", "show-control"]);
  }
  for (let cue = 1; cue <= args.cue_count; cue += 1) {
    rows.push([`cue ${cue} start`, `/cue/${cue}/start`, "pulse", "show-control"]);
    rows.push([`cue ${cue} stop`, `/cue/${cue}/stop`, "pulse", "show-control"]);
  }
  return rows;
}

export async function connectQlabCueStackImpl(ctx: ToolContext, args: ConnectQlabCueStackArgs) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "qlab_cue_stack",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        qlab_host: args.qlab_host,
        send_port: args.send_port,
        receive_port: args.receive_port,
        workspace_id: args.workspace_id ?? null,
        cue_count: args.cue_count,
        include_transport: args.include_transport,
        active: args.active,
      },
      warnings: [
        "QLab OSC must be enabled and rehearsed manually; this scaffold does not validate QLab live.",
        "Panic/stop rows are command templates, not a substitute for operator rehearsal.",
      ],
      nodes: [
        {
          name: "osc_out",
          optype: "oscoutCHOP",
          x: 0,
          y: 120,
          params: { netaddress: args.qlab_host, port: args.send_port, active: args.active ? 1 : 0 },
        },
        {
          name: "osc_in",
          optype: "oscinCHOP",
          x: 0,
          y: -40,
          params: { port: args.receive_port, active: args.active ? 1 : 0 },
        },
        { name: "cue_map", optype: "tableDAT", x: 300, y: 120, table: cueRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["host", args.qlab_host],
            ["send_port", String(args.send_port)],
            ["receive_port", String(args.receive_port)],
            ["workspace_id", args.workspace_id ?? ""],
            ["cue_count", String(args.cue_count)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: 120,
          text: "Enable OSC in QLab workspace settings, confirm the workspace passcode/network binding, then map cue_map rows to rehearsed cue numbers. Keep emergency stop behavior operator-owned.",
        },
      ],
    },
    "connect_qlab_cue_stack failed",
    (report) =>
      `Created QLab cue-stack scaffold ${report.container_path}; cue map ${report.nodes?.cue_map}; OSC send ${args.qlab_host}:${args.send_port}.`,
  );
}

export const registerConnectQlabCueStack: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_qlab_cue_stack",
    {
      title: "Connect QLab cue stack",
      description:
        "Create a QLab OSC cue-stack scaffold with cue command maps, status, and rehearsal-focused setup notes.",
      inputSchema: connectQlabCueStackSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectQlabCueStackImpl(ctx, args),
  );
};
