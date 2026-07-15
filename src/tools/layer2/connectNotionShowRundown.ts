import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectNotionShowRundownSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP for the Notion rundown scaffold."),
  name: z.string().default("notion_show_rundown").describe("Generated baseCOMP name."),
  database_id: z.string().default("notion_show_database"),
  rundown_label: z.string().default("main_show"),
  adapter_mode: z.enum(["rest_json", "webhook_json", "manual"]).default("rest_json"),
  adapter_url: z.string().default("http://127.0.0.1:9062/notion"),
  scene_count: z.coerce.number().int().min(1).max(256).default(12),
  property_count: z.coerce.number().int().min(1).max(64).default(8),
  approval_required: z.boolean().default(true),
  active: z.boolean().default(false),
});

type ConnectNotionShowRundownArgs = z.infer<typeof connectNotionShowRundownSchema>;

function sourceNode(args: ConnectNotionShowRundownArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "webhook_json") {
    return {
      name: "notion_ws_adapter",
      optype: "websocketDAT",
      x: 0,
      y: 120,
      params: { url: args.adapter_url, active: args.active ? 1 : 0 },
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_rundown_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Paste approved Notion rundown rows into scene_map.",
    };
  }
  return {
    name: "notion_client",
    optype: "webclientDAT",
    x: 0,
    y: 120,
    params: { url: args.adapter_url, active: args.active ? 1 : 0 },
  };
}

function sceneRows(args: ConnectNotionShowRundownArgs): string[][] {
  const rows = [["scene_id", "rundown", "title", "state", "cue_ref"]];
  for (let index = 1; index <= args.scene_count; index += 1) {
    rows.push([
      `scene_${String(index).padStart(2, "0")}`,
      args.rundown_label,
      `Scene ${index}`,
      index === 1 ? "standby" : "planned",
      `cue_${String(index).padStart(3, "0")}`,
    ]);
  }
  return rows;
}

function propertyRows(args: ConnectNotionShowRundownArgs): string[][] {
  const rows = [["property", "role", "binding"]];
  const roles = ["title", "status", "timecode", "look", "media", "notes"];
  for (let index = 1; index <= args.property_count; index += 1) {
    rows.push([`property_${index}`, roles[index - 1] ?? "custom", `notion_property_${index}`]);
  }
  return rows;
}

export async function connectNotionShowRundownImpl(
  ctx: ToolContext,
  args: ConnectNotionShowRundownArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "notion_show_rundown",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        database_id: args.database_id,
        rundown_label: args.rundown_label,
        adapter_mode: args.adapter_mode,
        adapter_url: args.adapter_url,
        scene_count: args.scene_count,
        property_count: args.property_count,
        approval_required: args.approval_required,
        active: args.active,
      },
      warnings: [
        "Notion tokens, database pagination, relation expansion, and rate limiting are intentionally external to this scaffold.",
        "Notion is treated as editorial input; runtime show-control changes should remain approval-gated.",
      ],
      nodes: [
        sourceNode(args),
        { name: "scene_map", optype: "tableDAT", x: 300, y: 120, table: sceneRows(args) },
        { name: "property_map", optype: "tableDAT", x: 600, y: 120, table: propertyRows(args) },
        {
          name: "approval_policy",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["database_id", args.database_id],
            ["rundown_label", args.rundown_label],
            ["approval_required", String(args.approval_required)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Normalize Notion pages into scene_map via an adapter. Keep direct Notion edits, relation expansion, and runtime show actions outside the TD scaffold.",
        },
      ],
    },
    "connect_notion_show_rundown failed",
    (report) =>
      `Created Notion show rundown ${report.container_path}; scenes ${args.scene_count}; database ${args.database_id}.`,
  );
}

export const registerConnectNotionShowRundown: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_notion_show_rundown",
    {
      title: "Connect Notion show rundown",
      description:
        "Create a Notion show-rundown scaffold with scene maps, property maps, approval policy, adapter source, and token-safety notes.",
      inputSchema: connectNotionShowRundownSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectNotionShowRundownImpl(ctx, args),
  );
};
