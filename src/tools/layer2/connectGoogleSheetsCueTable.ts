import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { websocketDatParams } from "./externalShowBridgeHelpers.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectGoogleSheetsCueTableSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP for the Google Sheets cue-table scaffold."),
  name: z.string().default("google_sheets_cue_table").describe("Generated baseCOMP name."),
  sheet_url: z.string().default("https://docs.google.com/spreadsheets/d/show-cues"),
  worksheet_name: z.string().default("cues"),
  adapter_mode: z.enum(["csv_export", "webhook_json", "manual"]).default("csv_export"),
  adapter_url: z.string().default("ws://127.0.0.1:9060"),
  cue_count: z.coerce.number().int().min(1).max(512).default(16),
  column_count: z.coerce.number().int().min(3).max(32).default(8),
  sync_direction: z.enum(["read_only", "read_write_requests"]).default("read_only"),
  active: z.boolean().default(false),
});

type ConnectGoogleSheetsCueTableArgs = z.infer<typeof connectGoogleSheetsCueTableSchema>;

function sourceNode(args: ConnectGoogleSheetsCueTableArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "webhook_json") {
    return {
      name: "sheets_ws_adapter",
      optype: "websocketDAT",
      x: 0,
      y: 120,
      params: websocketDatParams(args.adapter_url, args.active),
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_sheet_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Paste normalized worksheet rows into cue_table.",
    };
  }
  return {
    name: "sheets_csv_client",
    optype: "webclientDAT",
    x: 0,
    y: 120,
    params: { url: args.sheet_url, active: args.active ? 1 : 0 },
  };
}

function cueRows(args: ConnectGoogleSheetsCueTableArgs): string[][] {
  const headers = ["cue_id", "label", "timecode", "look", "media_asset", "notes"].slice(
    0,
    args.column_count,
  );
  for (let index = headers.length + 1; index <= args.column_count; index += 1) {
    headers.push(`custom_${index}`);
  }
  const rows = [headers];
  for (let index = 1; index <= args.cue_count; index += 1) {
    const row = [
      `cue_${String(index).padStart(3, "0")}`,
      `Cue ${index}`,
      `00:${String(index - 1).padStart(2, "0")}:00:00`,
      `look_${index}`,
      `asset_${index}`,
      "adapter supplied",
    ].slice(0, headers.length);
    while (row.length < headers.length) {
      row.push("");
    }
    rows.push(row);
  }
  return rows;
}

function columnRows(args: ConnectGoogleSheetsCueTableArgs): string[][] {
  const rows = [["column", "role", "required"]];
  const roles = ["id", "label", "timecode", "look", "media", "notes"];
  for (let index = 1; index <= args.column_count; index += 1) {
    rows.push([`col_${index}`, roles[index - 1] ?? "custom", index <= 3 ? "yes" : "no"]);
  }
  return rows;
}

export async function connectGoogleSheetsCueTableImpl(
  ctx: ToolContext,
  args: ConnectGoogleSheetsCueTableArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "google_sheets_cue_table",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        sheet_url: args.sheet_url,
        worksheet_name: args.worksheet_name,
        adapter_mode: args.adapter_mode,
        adapter_url: args.adapter_url,
        cue_count: args.cue_count,
        column_count: args.column_count,
        sync_direction: args.sync_direction,
        active: args.active,
      },
      warnings: [
        "Google OAuth credentials and writeback retries are intentionally external to this scaffold.",
        "Use read_write_requests only with an approval-gated adapter; the TD network does not directly edit the sheet.",
      ],
      nodes: [
        sourceNode(args),
        { name: "cue_table", optype: "tableDAT", x: 300, y: 120, table: cueRows(args) },
        { name: "column_map", optype: "tableDAT", x: 600, y: 120, table: columnRows(args) },
        {
          name: "validation",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "rule"],
            ["worksheet_name", args.worksheet_name],
            ["sync_direction", args.sync_direction],
            ["required_columns", "cue_id,label,timecode"],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use an external adapter for Sheets OAuth, CSV export cleanup, quota handling, and optional approved writeback. TouchDesigner consumes normalized cue rows only.",
        },
      ],
    },
    "connect_google_sheets_cue_table failed",
    (report) =>
      `Created Google Sheets cue table ${report.container_path}; cues ${args.cue_count}; worksheet ${args.worksheet_name}.`,
  );
}

export const registerConnectGoogleSheetsCueTable: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_google_sheets_cue_table",
    {
      title: "Connect Google Sheets cue table",
      description:
        "Create a Google Sheets cue-table scaffold with source adapter, cue rows, column validation, sync policy, and OAuth/writeback safety notes.",
      inputSchema: connectGoogleSheetsCueTableSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectGoogleSheetsCueTableImpl(ctx, args),
  );
};
