import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { websocketDatParams } from "./externalShowBridgeHelpers.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectOpcuaIndustrialBusSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the OPC UA scaffold."),
  name: z.string().default("opcua_industrial_bus").describe("Generated baseCOMP name."),
  endpoint_url: z.string().default("opc.tcp://127.0.0.1:4840"),
  adapter_http_url: z.string().default("http://127.0.0.1:9084/opcua"),
  adapter_ws_url: z.string().default("ws://127.0.0.1:9084/opcua"),
  adapter_udp_port: z.coerce.number().int().min(1).max(65535).default(9084),
  namespace_index: z.coerce.number().int().min(0).max(999).default(2),
  node_count: z.coerce.number().int().min(1).max(256).default(12),
  poll_ms: z.coerce.number().int().min(50).max(60000).default(250),
  adapter_mode: z
    .enum(["webclient_json", "websocket_json", "udp_json", "manual"])
    .default("manual"),
  security_policy: z
    .enum(["none", "basic256sha256", "external_adapter"])
    .default("external_adapter"),
  active: z.boolean().default(false),
});

type ConnectOpcuaIndustrialBusArgs = z.infer<typeof connectOpcuaIndustrialBusSchema>;

function sourceNode(args: ConnectOpcuaIndustrialBusArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "webclient_json") {
    return {
      name: "opcua_http_adapter",
      optype: "webclientDAT",
      x: 0,
      y: 120,
      params: { url: args.adapter_http_url, active: args.active ? 1 : 0 },
    };
  }
  if (args.adapter_mode === "websocket_json") {
    return {
      name: "opcua_ws_adapter",
      optype: "websocketDAT",
      x: 0,
      y: 120,
      params: websocketDatParams(args.adapter_ws_url, args.active),
    };
  }
  if (args.adapter_mode === "udp_json") {
    return {
      name: "opcua_udp_adapter",
      optype: "udpinDAT",
      x: 0,
      y: 120,
      params: { port: args.adapter_udp_port, active: args.active ? 1 : 0 },
    };
  }
  return {
    name: "adapter_notes",
    optype: "textDAT",
    x: 0,
    y: 120,
    text: "Manual mode selected. Use an external OPC UA adapter to publish approved telemetry into node_map.",
  };
}

function nodeRows(args: ConnectOpcuaIndustrialBusArgs): string[][] {
  const rows = [["label", "node_id", "access", "show_binding"]];
  for (let index = 1; index <= args.node_count; index += 1) {
    rows.push([
      `node_${index}`,
      `ns=${args.namespace_index};s=Show.Node${index}`,
      "read_only",
      `telemetry_${index}`,
    ]);
  }
  return rows;
}

export async function connectOpcuaIndustrialBusImpl(
  ctx: ToolContext,
  args: ConnectOpcuaIndustrialBusArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "opcua_industrial_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        endpoint_url: args.endpoint_url,
        adapter_http_url: args.adapter_http_url,
        adapter_ws_url: args.adapter_ws_url,
        adapter_udp_port: args.adapter_udp_port,
        namespace_index: args.namespace_index,
        node_count: args.node_count,
        poll_ms: args.poll_ms,
        adapter_mode: args.adapter_mode,
        security_policy: args.security_policy,
        active: args.active,
      },
      warnings: [
        "This scaffold stores no OPC UA credentials and does not connect directly to PLCs.",
        "Treat industrial telemetry as read-only unless a site safety review explicitly approves write paths.",
      ],
      nodes: [
        sourceNode(args),
        { name: "node_map", optype: "tableDAT", x: 300, y: 120, table: nodeRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 600,
          y: 120,
          table: [
            ["field", "value"],
            ["endpoint_url", args.endpoint_url],
            ["adapter_http_url", args.adapter_http_url],
            ["adapter_ws_url", args.adapter_ws_url],
            ["adapter_udp_port", String(args.adapter_udp_port)],
            ["namespace_index", String(args.namespace_index)],
            ["node_count", String(args.node_count)],
            ["poll_ms", String(args.poll_ms)],
            ["security_policy", args.security_policy],
            ["active", String(args.active)],
          ],
        },
        {
          name: "safety_policy",
          optype: "textDAT",
          x: 300,
          y: -40,
          text: "Default policy: read telemetry only, no writes to PLC or physical machinery. Gate every command through venue safety approval before routing beyond visualization.",
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Run OPC UA authentication and certificate handling in an external adapter. TD should receive normalized, approved JSON or tables for visualization.",
        },
      ],
    },
    "connect_opcua_industrial_bus failed",
    (report) =>
      `Created OPC UA industrial bus ${report.container_path}; nodes ${args.node_count}; mode ${args.adapter_mode}.`,
  );
}

export const registerConnectOpcuaIndustrialBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_opcua_industrial_bus",
    {
      title: "Connect OPC UA industrial bus",
      description:
        "Create an OPC UA industrial telemetry scaffold with node maps, adapter ingest options, status tables, and read-only safety-policy notes.",
      inputSchema: connectOpcuaIndustrialBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectOpcuaIndustrialBusImpl(ctx, args),
  );
};
