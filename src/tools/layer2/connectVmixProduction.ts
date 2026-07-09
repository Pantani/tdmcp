import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { runExternalShowScaffold } from "./externalShowBridgeScaffold.js";

export const connectVmixProductionSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the vMix scaffold."),
  name: z.string().default("vmix_production").describe("Generated baseCOMP name."),
  vmix_host: z.string().default("127.0.0.1"),
  api_port: z.coerce.number().int().min(1).max(65535).default(8088),
  input_count: z.coerce.number().int().min(1).max(256).default(8),
  overlay_count: z.coerce.number().int().min(0).max(16).default(4),
  include_record_stream: z.boolean().default(true),
  active: z.boolean().default(false),
});

type ConnectVmixProductionArgs = z.infer<typeof connectVmixProductionSchema>;

function apiBase(args: ConnectVmixProductionArgs): string {
  return `http://${args.vmix_host}:${args.api_port}/api`;
}

function commandRows(args: ConnectVmixProductionArgs): string[][] {
  const rows = [["label", "url_or_function", "value_hint"]];
  rows.push([
    "fade to input",
    `${apiBase(args)}/?Function=Fade&Input={input}`,
    `1..${args.input_count}`,
  ]);
  rows.push([
    "cut to input",
    `${apiBase(args)}/?Function=Cut&Input={input}`,
    `1..${args.input_count}`,
  ]);
  for (let overlay = 1; overlay <= args.overlay_count; overlay += 1) {
    rows.push([
      `overlay ${overlay} input`,
      `${apiBase(args)}/?Function=OverlayInput${overlay}&Input={input}`,
      `1..${args.input_count}`,
    ]);
  }
  if (args.include_record_stream) {
    rows.push([
      "start recording",
      `${apiBase(args)}/?Function=StartRecording`,
      "operator approved",
    ]);
    rows.push(["stop recording", `${apiBase(args)}/?Function=StopRecording`, "operator approved"]);
    rows.push([
      "start streaming",
      `${apiBase(args)}/?Function=StartStreaming`,
      "operator approved",
    ]);
    rows.push(["stop streaming", `${apiBase(args)}/?Function=StopStreaming`, "operator approved"]);
  }
  return rows;
}

export async function connectVmixProductionImpl(ctx: ToolContext, args: ConnectVmixProductionArgs) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "vmix_production",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        vmix_host: args.vmix_host,
        api_port: args.api_port,
        input_count: args.input_count,
        overlay_count: args.overlay_count,
        include_record_stream: args.include_record_stream,
        active: args.active,
      },
      warnings: [
        "This scaffold does not validate vMix live or store credentials.",
        "Recording/streaming commands should remain operator-approved in production.",
      ],
      nodes: [
        {
          name: "api_config",
          optype: "textDAT",
          x: 0,
          y: 120,
          text: JSON.stringify({ api_base: apiBase(args), active: args.active }, null, 2),
        },
        {
          name: "webclient",
          optype: "webclientDAT",
          x: 0,
          y: -40,
          params: { active: args.active ? 1 : 0 },
        },
        { name: "command_map", optype: "tableDAT", x: 300, y: 120, table: commandRows(args) },
        {
          name: "status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["api_base", apiBase(args)],
            ["input_count", String(args.input_count)],
            ["overlay_count", String(args.overlay_count)],
            ["record_stream_rows", String(args.include_record_stream)],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: 120,
          text: "Enable vMix Web Controller/API, confirm host firewall rules, then use command_map URLs as rehearsed templates. No API call is sent by this scaffold.",
        },
      ],
    },
    "connect_vmix_production failed",
    (report) =>
      `Created vMix production scaffold ${report.container_path}; API ${apiBase(args)}; command map ${report.nodes?.command_map}.`,
  );
}

export const registerConnectVmixProduction: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_vmix_production",
    {
      title: "Connect vMix production",
      description:
        "Create a vMix HTTP/API production-control scaffold for input switching, overlays, recording, and streaming command templates.",
      inputSchema: connectVmixProductionSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectVmixProductionImpl(ctx, args),
  );
};
