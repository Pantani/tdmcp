import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const connectWebsocketControlBusSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP for the WebSocket control scaffold."),
  name: z.string().default("websocket_control_bus").describe("Generated baseCOMP name."),
  net_address: z.string().default("127.0.0.1"),
  port: z.coerce.number().int().min(1).max(65535).default(8080),
  path: z.string().default("/"),
  tls: z.boolean().default(false),
  command_count: z.coerce.number().int().min(1).max(64).default(8),
  active: z.boolean().default(false),
});

type ConnectWebsocketControlBusArgs = z.infer<typeof connectWebsocketControlBusSchema>;

function commandRows(args: ConnectWebsocketControlBusArgs): string[][] {
  const rows = [["command", "message_type", "policy"]];
  for (let index = 0; index < args.command_count; index += 1) {
    rows.push([
      `command_${index + 1}`,
      `show.command.${index + 1}`,
      index === 0 ? "dry_run" : "map",
    ]);
  }
  return rows;
}

function schemaRows(): string[][] {
  return [
    ["field", "type", "note"],
    ["type", "string", "message discriminator"],
    ["payload", "object", "validated downstream"],
    ["source", "string", "optional sender id"],
    ["timestamp", "number", "optional sender clock"],
  ];
}

export async function connectWebsocketControlBusImpl(
  ctx: ToolContext,
  args: ConnectWebsocketControlBusArgs,
) {
  const scheme = args.tls ? "wss" : "ws";
  const path = args.path.startsWith("/") ? args.path : `/${args.path}`;
  const url = `${scheme}://${args.net_address}:${args.port}${path}`;

  return runExternalShowScaffold(
    ctx,
    {
      kind: "websocket_control_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        net_address: args.net_address,
        port: args.port,
        path: args.path,
        tls: args.tls,
        url,
        command_count: args.command_count,
        active: args.active,
      },
      warnings: [
        "WebSocket messages are external control input; validate message type and payload before binding to show state.",
        "Do not route websocket commands directly to hazardous physical outputs without policy and operator approval.",
      ],
      nodes: [
        {
          name: "websocket",
          optype: "websocketDAT",
          x: 0,
          y: 120,
          params: {
            active: args.active ? 1 : 0,
            netaddress: url,
            port: args.port,
          },
        },
        { name: "command_map", optype: "tableDAT", x: 300, y: 120, table: commandRows(args) },
        { name: "message_schema", optype: "tableDAT", x: 600, y: 120, table: schemaRows() },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["url", url],
            ["command_count", String(args.command_count)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use websocket rows as untrusted intent messages. Parse message_schema, map only known command_map entries, and keep hazardous actions behind policy.",
        },
      ],
    },
    "connect_websocket_control_bus failed",
    (report) =>
      `Created WebSocket control bus ${report.container_path}; url ${url}; commands ${args.command_count}.`,
  );
}

export const registerConnectWebsocketControlBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_websocket_control_bus",
    {
      title: "Connect WebSocket control bus",
      description:
        "Create a WebSocket DAT scaffold with command maps, message schema hints, status, and safety notes.",
      inputSchema: connectWebsocketControlBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectWebsocketControlBusImpl(ctx, args),
  );
};
