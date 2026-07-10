import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectAirtableContentBusSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP for the Airtable content-bus scaffold."),
  name: z.string().default("airtable_content_bus").describe("Generated baseCOMP name."),
  base_id: z.string().default("app_show_base"),
  table_name: z.string().default("Show Content"),
  view_name: z.string().default("Approved"),
  adapter_mode: z.enum(["rest_json", "webhook_json", "manual"]).default("rest_json"),
  adapter_url: z.string().default("http://127.0.0.1:9061/airtable"),
  record_count: z.coerce.number().int().min(1).max(512).default(24),
  field_count: z.coerce.number().int().min(1).max(64).default(8),
  sync_direction: z.enum(["read_only", "approved_updates"]).default("read_only"),
  active: z.boolean().default(false),
});

type ConnectAirtableContentBusArgs = z.infer<typeof connectAirtableContentBusSchema>;

function sourceNode(args: ConnectAirtableContentBusArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "webhook_json") {
    return {
      name: "airtable_ws_adapter",
      optype: "websocketDAT",
      x: 0,
      y: 120,
      params: { url: args.adapter_url, active: args.active ? 1 : 0 },
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_airtable_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Paste normalized Airtable records into record_map.",
    };
  }
  return {
    name: "airtable_client",
    optype: "webclientDAT",
    x: 0,
    y: 120,
    params: { url: args.adapter_url, active: args.active ? 1 : 0 },
  };
}

function recordRows(args: ConnectAirtableContentBusArgs): string[][] {
  const rows = [["record_id", "table", "view", "status", "asset_key"]];
  for (let index = 1; index <= args.record_count; index += 1) {
    rows.push([
      `rec_${String(index).padStart(4, "0")}`,
      args.table_name,
      args.view_name,
      "approved",
      `asset_${index}`,
    ]);
  }
  return rows;
}

function fieldRows(args: ConnectAirtableContentBusArgs): string[][] {
  const rows = [["field", "type", "binding"]];
  for (let index = 1; index <= args.field_count; index += 1) {
    rows.push([
      `field_${index}`,
      index % 3 === 0 ? "attachment" : "text",
      `airtable_field_${index}`,
    ]);
  }
  return rows;
}

export async function connectAirtableContentBusImpl(
  ctx: ToolContext,
  args: ConnectAirtableContentBusArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "airtable_content_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        base_id: args.base_id,
        table_name: args.table_name,
        view_name: args.view_name,
        adapter_mode: args.adapter_mode,
        adapter_url: args.adapter_url,
        record_count: args.record_count,
        field_count: args.field_count,
        sync_direction: args.sync_direction,
        active: args.active,
      },
      warnings: [
        "Airtable API keys, pagination, attachment downloads, and rate limiting are intentionally external to this scaffold.",
        "approved_updates should be routed through an operator-visible adapter queue before mutating Airtable records.",
      ],
      nodes: [
        sourceNode(args),
        { name: "record_map", optype: "tableDAT", x: 300, y: 120, table: recordRows(args) },
        { name: "field_map", optype: "tableDAT", x: 600, y: 120, table: fieldRows(args) },
        {
          name: "sync_policy",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["base_id", args.base_id],
            ["table_name", args.table_name],
            ["view_name", args.view_name],
            ["sync_direction", args.sync_direction],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Keep Airtable auth, filters, paging, attachment transforms, and update retries in the adapter. TouchDesigner consumes stable content rows.",
        },
      ],
    },
    "connect_airtable_content_bus failed",
    (report) =>
      `Created Airtable content bus ${report.container_path}; records ${args.record_count}; table ${args.table_name}.`,
  );
}

export const registerConnectAirtableContentBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_airtable_content_bus",
    {
      title: "Connect Airtable content bus",
      description:
        "Create an Airtable content scaffold with record maps, field maps, sync policy, adapter source, and token/rate-limit safety notes.",
      inputSchema: connectAirtableContentBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectAirtableContentBusImpl(ctx, args),
  );
};
