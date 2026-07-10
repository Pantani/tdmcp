import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { requestPulse, websocketDatParams } from "./externalShowBridgeHelpers.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectPeopleCountingBusSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the people-count bus."),
  name: z.string().default("people_counting_bus").describe("Generated baseCOMP name."),
  venue_label: z.string().default("venue"),
  adapter_mode: z.enum(["websocket_json", "http_json", "manual"]).default("websocket_json"),
  adapter_url: z.string().default("ws://127.0.0.1:9090/people-count"),
  zone_count: z.coerce.number().int().min(1).max(128).default(6),
  sample_count: z.coerce.number().int().min(1).max(2048).default(24),
  privacy_level: z
    .enum(["aggregate_only", "anonymous_tracks", "approval_required"])
    .default("aggregate_only"),
  active: z.boolean().default(false),
});

type ConnectPeopleCountingBusArgs = z.infer<typeof connectPeopleCountingBusSchema>;

function sourceNode(args: ConnectPeopleCountingBusArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "http_json") {
    return {
      name: "people_http_adapter",
      optype: "webclientDAT",
      x: 0,
      y: 120,
      params: { url: args.adapter_url, active: args.active ? 1 : 0 },
      pulses: requestPulse(args.active),
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_people_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Paste aggregate zone counts into zone_counts.",
    };
  }
  return {
    name: "people_ws_adapter",
    optype: "websocketDAT",
    x: 0,
    y: 120,
    params: websocketDatParams(args.adapter_url, args.active),
  };
}

function zoneRows(args: ConnectPeopleCountingBusArgs): string[][] {
  const rows = [["zone", "venue", "count", "capacity_hint", "policy"]];
  for (let index = 1; index <= args.zone_count; index += 1) {
    rows.push([`zone_${index}`, args.venue_label, "0", "unset", args.privacy_level]);
  }
  return rows;
}

function sampleRows(args: ConnectPeopleCountingBusArgs): string[][] {
  const rows = [["sample", "zone", "count", "confidence"]];
  for (let index = 1; index <= args.sample_count; index += 1) {
    rows.push([`sample_${index}`, `zone_${((index - 1) % args.zone_count) + 1}`, "0", "0.0"]);
  }
  return rows;
}

export async function connectPeopleCountingBusImpl(
  ctx: ToolContext,
  args: ConnectPeopleCountingBusArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "people_counting_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        venue_label: args.venue_label,
        adapter_mode: args.adapter_mode,
        adapter_url: args.adapter_url,
        zone_count: args.zone_count,
        sample_count: args.sample_count,
        privacy_level: args.privacy_level,
        active: args.active,
      },
      warnings: [
        "Raw camera frames, face templates, biometrics, and identifiable tracks are intentionally external to this scaffold.",
        "Use aggregate zone counts for visuals/signage; policy decisions stay in the adapter or show director.",
      ],
      nodes: [
        sourceNode(args),
        { name: "zone_counts", optype: "tableDAT", x: 300, y: 120, table: zoneRows(args) },
        { name: "sample_window", optype: "tableDAT", x: 600, y: 120, table: sampleRows(args) },
        {
          name: "privacy_policy",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["venue_label", args.venue_label],
            ["privacy_level", args.privacy_level],
            ["raw_images_in_td", "false"],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Run detection, tracking, anonymization, and retention policy in an adapter. TouchDesigner receives aggregate zone_counts only.",
        },
      ],
    },
    "connect_people_counting_bus failed",
    (report) =>
      `Created people-counting bus ${report.container_path}; zones ${args.zone_count}; samples ${args.sample_count}.`,
  );
}

export const registerConnectPeopleCountingBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_people_counting_bus",
    {
      title: "Connect people-counting bus",
      description:
        "Create a people-counting scaffold with aggregate zone counts, sample windows, adapter source, and privacy policy notes.",
      inputSchema: connectPeopleCountingBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectPeopleCountingBusImpl(ctx, args),
  );
};
