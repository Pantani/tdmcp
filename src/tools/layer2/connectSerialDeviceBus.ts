import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const connectSerialDeviceBusSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP for the serial device scaffold."),
  name: z.string().default("serial_device_bus").describe("Generated baseCOMP name."),
  device: z.string().default("COM1"),
  baud_rate: z.coerce.number().int().min(300).max(4000000).default(115200),
  message_count: z.coerce.number().int().min(1).max(64).default(6),
  include_chop: z.boolean().default(true),
  active: z.boolean().default(false),
});

type ConnectSerialDeviceBusArgs = z.infer<typeof connectSerialDeviceBusSchema>;

function messageRows(args: ConnectSerialDeviceBusArgs): string[][] {
  const rows = [["message", "prefix", "purpose"]];
  for (let index = 0; index < args.message_count; index += 1) {
    rows.push([`message_${index + 1}`, `msg${index + 1}:`, index === 0 ? "heartbeat" : "sensor"]);
  }
  return rows;
}

function parseRows(): string[][] {
  return [
    ["field", "source", "conversion"],
    ["timestamp", "host", "number"],
    ["device_id", "serial", "string"],
    ["value", "serial", "float"],
    ["state", "serial", "enum"],
  ];
}

export async function connectSerialDeviceBusImpl(
  ctx: ToolContext,
  args: ConnectSerialDeviceBusArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "serial_device_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        device: args.device,
        baud_rate: args.baud_rate,
        message_count: args.message_count,
        include_chop: args.include_chop,
        active: args.active,
      },
      warnings: [
        "Serial device names and permissions are platform-specific; verify the port outside show time.",
        "Treat serial input as untrusted sensor data and clamp parsed values before binding visuals or hardware.",
      ],
      nodes: [
        {
          name: "serial_dat",
          optype: "serialDAT",
          x: 0,
          y: 120,
          params: { active: args.active ? 1 : 0, device: args.device, baudrate: args.baud_rate },
        },
        {
          name: "serial_chop",
          optype: "serialCHOP",
          x: 0,
          y: -40,
          params: { active: args.include_chop && args.active ? 1 : 0, device: args.device },
        },
        { name: "message_map", optype: "tableDAT", x: 300, y: 120, table: messageRows(args) },
        { name: "parse_map", optype: "tableDAT", x: 600, y: 120, table: parseRows() },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["device", args.device],
            ["baud_rate", String(args.baud_rate)],
            ["message_count", String(args.message_count)],
            ["include_chop", String(args.include_chop)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use serial_dat for line/message parsing and serial_chop only when the device emits numeric streams. Add checksums or framing before show-critical bindings.",
        },
      ],
    },
    "connect_serial_device_bus failed",
    (report) =>
      `Created serial device bus ${report.container_path}; device ${args.device}; baud ${args.baud_rate}.`,
  );
}

export const registerConnectSerialDeviceBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_serial_device_bus",
    {
      title: "Connect serial device bus",
      description:
        "Create a Serial DAT/CHOP scaffold for microcontrollers, sensors, and show-control devices with parse maps.",
      inputSchema: connectSerialDeviceBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectSerialDeviceBusImpl(ctx, args),
  );
};
