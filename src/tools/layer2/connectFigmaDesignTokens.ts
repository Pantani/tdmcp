import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { websocketDatParams } from "./externalShowBridgeHelpers.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectFigmaDesignTokensSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP for the Figma token scaffold."),
  name: z.string().default("figma_design_tokens").describe("Generated baseCOMP name."),
  file_key: z.string().default("figma_file_key"),
  team_label: z.string().default("design_team"),
  adapter_mode: z.enum(["rest_json", "webhook_json", "manual"]).default("rest_json"),
  adapter_url: z.string().default("http://127.0.0.1:9063/figma"),
  token_format: z
    .enum(["style_dictionary", "css_variables", "json_tokens"])
    .default("style_dictionary"),
  token_count: z.coerce.number().int().min(1).max(512).default(32),
  component_count: z.coerce.number().int().min(0).max(256).default(8),
  active: z.boolean().default(false),
});

type ConnectFigmaDesignTokensArgs = z.infer<typeof connectFigmaDesignTokensSchema>;

function sourceNode(args: ConnectFigmaDesignTokensArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "webhook_json") {
    return {
      name: "figma_ws_adapter",
      optype: "websocketDAT",
      x: 0,
      y: 120,
      params: websocketDatParams(args.adapter_url, args.active),
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_token_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Paste exported Figma token rows into token_map.",
    };
  }
  return {
    name: "figma_client",
    optype: "webclientDAT",
    x: 0,
    y: 120,
    params: { url: args.adapter_url, active: args.active ? 1 : 0 },
  };
}

function tokenRows(args: ConnectFigmaDesignTokensArgs): string[][] {
  const rows = [["token", "type", "value", "binding"]];
  const types = ["color", "number", "font", "radius", "spacing"];
  for (let index = 1; index <= args.token_count; index += 1) {
    const type = types[(index - 1) % types.length] ?? "custom";
    rows.push([
      `token_${index}`,
      type,
      type === "color"
        ? `#${((index * 379) % 0xffffff).toString(16).padStart(6, "0")}`
        : `${index}`,
      `figma_token_${index}`,
    ]);
  }
  return rows;
}

function componentRows(args: ConnectFigmaDesignTokensArgs): string[][] {
  const rows = [["component", "variant", "review_state"]];
  if (args.component_count === 0) {
    rows.push(["none", "none", "tokens_only"]);
    return rows;
  }
  for (let index = 1; index <= args.component_count; index += 1) {
    rows.push([`component_${index}`, `variant_${index}`, "approved"]);
  }
  return rows;
}

export async function connectFigmaDesignTokensImpl(
  ctx: ToolContext,
  args: ConnectFigmaDesignTokensArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "figma_design_tokens",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        file_key: args.file_key,
        team_label: args.team_label,
        adapter_mode: args.adapter_mode,
        adapter_url: args.adapter_url,
        token_format: args.token_format,
        token_count: args.token_count,
        component_count: args.component_count,
        active: args.active,
      },
      warnings: [
        "Figma access tokens, file paging, branch/version comparisons, and transform exports are intentionally external to this scaffold.",
        "Treat imported tokens as design-review input; bind them to show controls only after artist review.",
      ],
      nodes: [
        sourceNode(args),
        { name: "token_map", optype: "tableDAT", x: 300, y: 120, table: tokenRows(args) },
        {
          name: "component_map",
          optype: "tableDAT",
          x: 600,
          y: 120,
          table: componentRows(args),
        },
        {
          name: "style_preview",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["team_label", args.team_label],
            ["file_key", args.file_key],
            ["token_format", args.token_format],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use a Figma adapter to export stable token rows. TouchDesigner can then bind color, spacing, and component-review metadata without storing access tokens.",
        },
      ],
    },
    "connect_figma_design_tokens failed",
    (report) =>
      `Created Figma design token bridge ${report.container_path}; tokens ${args.token_count}; format ${args.token_format}.`,
  );
}

export const registerConnectFigmaDesignTokens: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_figma_design_tokens",
    {
      title: "Connect Figma design tokens",
      description:
        "Create a Figma design-token scaffold with token rows, component-review rows, style preview metadata, adapter source, and access-token safety notes.",
      inputSchema: connectFigmaDesignTokensSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectFigmaDesignTokensImpl(ctx, args),
  );
};
