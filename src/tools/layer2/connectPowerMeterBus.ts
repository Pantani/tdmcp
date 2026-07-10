import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectPowerMeterBusSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the power scaffold."),
  name: z.string().default("power_meter_bus").describe("Generated baseCOMP name."),
  venue_label: z.string().default("venue"),
  adapter_mode: z.enum(["websocket_json", "http_json", "manual"]).default("http_json"),
  adapter_url: z.string().default("http://127.0.0.1:9094/power"),
  meter_count: z.coerce.number().int().min(1).max(256).default(4),
  circuit_count: z.coerce.number().int().min(1).max(1024).default(12),
  warning_kw: z.coerce.number().min(0).max(100000).default(50),
  active: z.boolean().default(false),
});

type ConnectPowerMeterBusArgs = z.infer<typeof connectPowerMeterBusSchema>;

function sourceNode(args: ConnectPowerMeterBusArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "websocket_json") {
    return {
      name: "power_ws_adapter",
      optype: "websocketDAT",
      x: 0,
      y: 120,
      params: { url: args.adapter_url, active: args.active ? 1 : 0 },
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_power_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Paste normalized meter readings into power_readings.",
    };
  }
  return {
    name: "power_http_adapter",
    optype: "webclientDAT",
    x: 0,
    y: 120,
    params: { url: args.adapter_url, active: args.active ? 1 : 0 },
  };
}

function meterRows(args: ConnectPowerMeterBusArgs): string[][] {
  const rows = [["meter", "venue", "kw", "voltage", "status"]];
  for (let index = 1; index <= args.meter_count; index += 1) {
    rows.push([`meter_${index}`, args.venue_label, "0", "0", "unknown"]);
  }
  return rows;
}

function circuitRows(args: ConnectPowerMeterBusArgs): string[][] {
  const rows = [["circuit", "meter", "label", "kw"]];
  for (let index = 1; index <= args.circuit_count; index += 1) {
    rows.push([
      `circuit_${index}`,
      `meter_${((index - 1) % args.meter_count) + 1}`,
      `show_${index}`,
      "0",
    ]);
  }
  return rows;
}

export async function connectPowerMeterBusImpl(ctx: ToolContext, args: ConnectPowerMeterBusArgs) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "power_meter_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        venue_label: args.venue_label,
        adapter_mode: args.adapter_mode,
        adapter_url: args.adapter_url,
        meter_count: args.meter_count,
        circuit_count: args.circuit_count,
        warning_kw: args.warning_kw,
        active: args.active,
      },
      warnings: [
        "Power data is advisory telemetry only; do not switch breakers, dimmers, or electrical infrastructure from this scaffold.",
        "Electrical thresholds and load shedding require qualified operator review outside TouchDesigner.",
      ],
      nodes: [
        sourceNode(args),
        { name: "power_readings", optype: "tableDAT", x: 300, y: 120, table: meterRows(args) },
        { name: "circuit_map", optype: "tableDAT", x: 600, y: 120, table: circuitRows(args) },
        {
          name: "load_policy",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["venue_label", args.venue_label],
            ["warning_kw", String(args.warning_kw)],
            ["power_control_in_td", "false"],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Bridge BMS, Modbus, or vendor meters through a read-only adapter. TouchDesigner should visualize load, not make electrical control decisions.",
        },
      ],
    },
    "connect_power_meter_bus failed",
    (report) =>
      `Created power-meter bus ${report.container_path}; meters ${args.meter_count}; circuits ${args.circuit_count}.`,
  );
}

export const registerConnectPowerMeterBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_power_meter_bus",
    {
      title: "Connect power-meter bus",
      description:
        "Create a power-meter telemetry scaffold with read-only meter readings, circuit maps, adapter source, and electrical-control safety notes.",
      inputSchema: connectPowerMeterBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectPowerMeterBusImpl(ctx, args),
  );
};
