import { z } from "zod";
import { errorResult, jsonStructuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const DESCRIPTION =
  "Find a tdmcp tool by what it does, and enable it if it is not listed yet. Use this when the tool you need is not in your list: under TDMCP_TOOL_PROFILE=core only an everyday set is listed and the rest stay disabled until enabled here. Pass `query` to search names, titles and descriptions (each match reports `enabled`), and `enable` with exact tool names to turn them on for this session; the server then sends tools/list_changed. Changes nothing in TouchDesigner.";

const SUMMARY_CHARS = 200;

export const findToolSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe('What the tool should do, e.g. "pixel sort" or "resolume osc".'),
  enable: z
    .array(z.string().min(1).max(100))
    .max(25)
    .optional()
    .describe("Exact tool names to enable for this session."),
  limit: z.number().int().min(1).max(25).default(8).describe("Maximum matches to return."),
});

type FindToolArgs = z.infer<typeof findToolSchema>;

function tokens(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1);
}

function scoreTool(
  name: string,
  title: string,
  description: string,
  query: readonly string[],
): number {
  const nameTokens = new Set(tokens(name));
  const titleTokens = new Set(tokens(title));
  const descriptionText = description.toLowerCase();
  let score = query.join("_") === name ? 20 : 0;
  for (const token of query) {
    if (nameTokens.has(token)) score += 5;
    if (titleTokens.has(token)) score += 3;
    if (descriptionText.includes(token)) score += 1;
  }
  return score;
}

function summarize(description: string): string {
  const firstSentence = description.split(/(?<=\.)\s/, 1)[0] ?? description;
  return firstSentence.length > SUMMARY_CHARS
    ? `${firstSentence.slice(0, SUMMARY_CHARS)}…`
    : firstSentence;
}

function searchCatalog(ctx: ToolContext, query: string, limit: number) {
  const queryTokens = tokens(query);
  const matches = [...(ctx.toolCatalog ?? new Map()).entries()].map(([name, tool]) => ({
    name,
    title: tool.title ?? name,
    description: tool.description ?? "",
    enabled: tool.enabled,
  }));
  return matches
    .map((tool) => ({
      tool,
      score: scoreTool(tool.name, tool.title, tool.description, queryTokens),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit)
    .map(({ tool }) => ({
      name: tool.name,
      title: tool.title,
      summary: summarize(tool.description),
      enabled: tool.enabled,
    }));
}

function enableTools(ctx: ToolContext, names: readonly string[]) {
  const enabled: string[] = [];
  const unknown: string[] = [];
  for (const name of names) {
    const tool = ctx.toolCatalog?.get(name);
    if (!tool) {
      unknown.push(name);
      continue;
    }
    // enable() is what notifies the client, so skip it for a tool already on.
    if (!tool.enabled) tool.enable();
    enabled.push(name);
  }
  return { enabled, unknown };
}

export async function findToolImpl(ctx: ToolContext, args: FindToolArgs) {
  if (args.query === undefined && args.enable === undefined) {
    return errorResult("Pass `query` to search for a tool, or `enable` with exact tool names.");
  }
  const { enabled, unknown } = enableTools(ctx, args.enable ?? []);
  const matches = args.query !== undefined ? searchCatalog(ctx, args.query, args.limit) : [];
  const parts = [
    ...(args.query !== undefined ? [`${matches.length} matching tool(s).`] : []),
    ...(enabled.length > 0 ? [`Enabled: ${enabled.join(", ")}.`] : []),
    ...(unknown.length > 0 ? [`Unknown tool(s): ${unknown.join(", ")}.`] : []),
  ];
  return jsonStructuredResult(parts.join(" "), {
    matches,
    enabled,
    unknown,
    ...(enabled.length > 0
      ? {
          note: "If your client does not refresh its tool list on tools/list_changed, restart it with TDMCP_TOOL_PROFILE=full.",
        }
      : {}),
  });
}

export const registerFindTool: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "find_tool",
    {
      title: "Find and enable a tool",
      description: DESCRIPTION,
      inputSchema: findToolSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args) => findToolImpl(ctx, args),
  );
};
