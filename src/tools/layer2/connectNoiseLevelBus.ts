import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectNoiseLevelBusSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for noise level data."),
  name: z.string().default("noise_level_bus").describe("Generated baseCOMP name."),
  venue_label: z.string().default("venue"),
  adapter_mode: z.enum(["websocket_json", "http_json", "manual"]).default("websocket_json"),
  adapter_url: z.string().default("ws://127.0.0.1:9095/noise"),
  zone_count: z.coerce.number().int().min(1).max(128).default(4),
  sample_count: z.coerce.number().int().min(1).max(2048).default(32),
  weighting: z.enum(["dba", "dbc", "flat"]).default("dba"),
  limit_db: z.coerce.number().min(0).max(200).default(95),
  active: z.boolean().default(false),
});

type ConnectNoiseLevelBusArgs = z.infer<typeof connectNoiseLevelBusSchema>;

function sourceNode(args: ConnectNoiseLevelBusArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "http_json") {
    return {
      name: "noise_http_adapter",
      optype: "webclientDAT",
      x: 0,
      y: 120,
      params: { url: args.adapter_url, active: args.active ? 1 : 0 },
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_noise_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Paste aggregate decibel rows into noise_levels.",
    };
  }
  return {
    name: "noise_ws_adapter",
    optype: "websocketDAT",
    x: 0,
    y: 120,
    params: { url: args.adapter_url, active: args.active ? 1 : 0 },
  };
}

function levelRows(args: ConnectNoiseLevelBusArgs): string[][] {
  const rows = [["zone", "db", "weighting", "limit_db", "status"]];
  for (let index = 1; index <= args.zone_count; index += 1) {
    rows.push([`zone_${index}`, "0", args.weighting, String(args.limit_db), "unknown"]);
  }
  return rows;
}

function sampleRows(args: ConnectNoiseLevelBusArgs): string[][] {
  const rows = [["sample", "zone", "db"]];
  for (let index = 1; index <= args.sample_count; index += 1) {
    rows.push([`sample_${index}`, `zone_${((index - 1) % args.zone_count) + 1}`, "0"]);
  }
  return rows;
}

export async function connectNoiseLevelBusImpl(ctx: ToolContext, args: ConnectNoiseLevelBusArgs) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "noise_level_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        venue_label: args.venue_label,
        adapter_mode: args.adapter_mode,
        adapter_url: args.adapter_url,
        zone_count: args.zone_count,
        sample_count: args.sample_count,
        weighting: args.weighting,
        limit_db: args.limit_db,
        active: args.active,
      },
      warnings: [
        "Raw audio capture and personally identifiable conversation data are intentionally external to this scaffold.",
        "Noise readings are show telemetry; compliance, hearing-safety, and PA control decisions require operator policy.",
      ],
      nodes: [
        sourceNode(args),
        { name: "noise_levels", optype: "tableDAT", x: 300, y: 120, table: levelRows(args) },
        { name: "sample_window", optype: "tableDAT", x: 600, y: 120, table: sampleRows(args) },
        {
          name: "noise_policy",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["venue_label", args.venue_label],
            ["weighting", args.weighting],
            ["limit_db", String(args.limit_db)],
            ["pa_control_in_td", "false"],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use a calibrated SPL adapter that emits aggregate decibel values. TouchDesigner can visualize noise state but should not control PA limiters.",
        },
      ],
    },
    "connect_noise_level_bus failed",
    (report) =>
      `Created noise-level bus ${report.container_path}; zones ${args.zone_count}; limit ${args.limit_db} dB.`,
  );
}

export const registerConnectNoiseLevelBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_noise_level_bus",
    {
      title: "Connect noise-level bus",
      description:
        "Create a noise-level telemetry scaffold with aggregate decibel readings, sample windows, adapter source, and PA/safety policy notes.",
      inputSchema: connectNoiseLevelBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectNoiseLevelBusImpl(ctx, args),
  );
};
