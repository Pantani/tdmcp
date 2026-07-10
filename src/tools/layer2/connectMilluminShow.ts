import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const connectMilluminShowSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the Millumin scaffold."),
  name: z.string().default("millumin_show").describe("Generated baseCOMP name."),
  millumin_host: z.string().default("127.0.0.1").describe("Millumin OSC host."),
  send_port: z.coerce.number().int().min(1).max(65535).default(5000),
  receive_port: z.coerce.number().int().min(1).max(65535).default(5001),
  layer_count: z.coerce.number().int().min(1).max(64).default(4),
  column_count: z.coerce.number().int().min(1).max(256).default(8),
  dashboard_page: z.string().default("main"),
  active: z.boolean().default(false),
});

type ConnectMilluminShowArgs = z.infer<typeof connectMilluminShowSchema>;

function commandRows(args: ConnectMilluminShowArgs): string[][] {
  const rows = [["label", "address_template", "value_hint"]];
  for (let layer = 1; layer <= args.layer_count; layer += 1) {
    rows.push([`layer ${layer} opacity`, `/millumin/layers/${layer}/opacity`, "0..1"]);
    rows.push([`layer ${layer} play`, `/millumin/layers/${layer}/play`, "pulse"]);
    rows.push([`layer ${layer} stop`, `/millumin/layers/${layer}/stop`, "pulse"]);
  }
  for (let column = 1; column <= args.column_count; column += 1) {
    rows.push([`column ${column} launch`, `/millumin/columns/${column}/launch`, "pulse"]);
  }
  rows.push(["dashboard button", `/millumin/dashboard/${args.dashboard_page}/{control}`, "0..1"]);
  return rows;
}

export async function connectMilluminShowImpl(ctx: ToolContext, args: ConnectMilluminShowArgs) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "millumin_show",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        millumin_host: args.millumin_host,
        send_port: args.send_port,
        receive_port: args.receive_port,
        layer_count: args.layer_count,
        column_count: args.column_count,
        dashboard_page: args.dashboard_page,
        active: args.active,
      },
      warnings: [
        "Millumin OSC must be enabled and mapped manually; this scaffold does not validate Millumin live.",
        "Address templates vary by show and Millumin version; verify against the live show file.",
      ],
      nodes: [
        {
          name: "osc_out",
          optype: "oscoutCHOP",
          x: 0,
          y: 120,
          params: {
            netaddress: args.millumin_host,
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
            ["host", args.millumin_host],
            ["send_port", String(args.send_port)],
            ["receive_port", String(args.receive_port)],
            ["layer_count", String(args.layer_count)],
            ["column_count", String(args.column_count)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: 120,
          text: "Enable OSC in Millumin, map command_map rows to the real show, and rehearse layer/column numbering before performance.",
        },
      ],
    },
    "connect_millumin_show failed",
    (report) =>
      `Created Millumin show scaffold ${report.container_path}; command map ${report.nodes?.command_map}; OSC send ${args.millumin_host}:${args.send_port}.`,
  );
}

export const registerConnectMilluminShow: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_millumin_show",
    {
      title: "Connect Millumin show",
      description:
        "Create a Millumin OSC layer, column, and dashboard control scaffold with command maps and setup notes.",
      inputSchema: connectMilluminShowSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectMilluminShowImpl(ctx, args),
  );
};
