import { z } from "zod";
import { NodeRefSchema } from "../../td-client/validators.js";
import { guardTd, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { globToRegExp } from "./nodeMatch.js";

export const getTdNodesSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP whose direct children should be listed."),
  pattern: z
    .string()
    .optional()
    .describe(
      "Case-insensitive filter on node name/path. Supports '*' wildcards (e.g. 'text*', '*noise*').",
    ),
  path_only: z
    .boolean()
    .default(false)
    .describe("Return only the list of node paths, dropping type/name."),
  limit: z.number().int().positive().optional().describe("Cap the number of nodes returned."),
  detail_level: z
    .enum(["summary", "full"])
    .default("summary")
    .describe(
      "'summary' (default) returns a count, a type breakdown and the first few paths; 'full' returns every node. Use 'full' (or path_only) when you need the complete list.",
    ),
});
type GetTdNodesArgs = z.infer<typeof getTdNodesSchema>;

const SAMPLE_SIZE = 10;

export const getTdNodesOutputSchema = z.object({
  parent_path: z.string().describe("The parent COMP whose children were listed."),
  count: z.number().describe("Number of children matched (before any limit truncation)."),
  detail_level: z
    .enum(["summary", "full"])
    .describe("Which detail level produced this result, echoing the request."),
  truncated: z.boolean().describe("True if `limit` cut the list short of the full match count."),
  by_type: z
    .record(z.string(), z.number())
    .optional()
    .describe("Summary mode: count of matched nodes per operator type."),
  sample: z
    .array(z.string())
    .optional()
    .describe("Summary mode: paths of the first few matched nodes."),
  paths: z
    .array(z.string())
    .optional()
    .describe("path_only mode: the matched node paths and nothing else."),
  nodes: z
    .array(NodeRefSchema)
    .optional()
    .describe("Full mode: every matched node as {path, name, type}."),
  hint: z
    .string()
    .optional()
    .describe("Summary mode: note that the list was sampled, with how to get all of it."),
});

export async function getTdNodesImpl(ctx: ToolContext, args: GetTdNodesArgs) {
  return guardTd(
    () => ctx.client.getNodes(args.parent_path),
    (list) => {
      let nodes = list.nodes;
      if (args.pattern) {
        const re = globToRegExp(args.pattern);
        nodes = nodes.filter((n) => re.test(n.name) || re.test(n.path));
      }
      const matched = nodes.length;
      const truncated = args.limit !== undefined && matched > args.limit;
      if (args.limit !== undefined) nodes = nodes.slice(0, args.limit);
      const where = args.pattern ? ` matching "${args.pattern}"` : "";
      const base = {
        parent_path: args.parent_path,
        count: matched,
        detail_level: args.detail_level,
        truncated,
      };

      if (args.path_only) {
        return structuredResult(`${matched} node(s) under ${args.parent_path}${where}.`, {
          ...base,
          paths: nodes.map((n) => n.path),
        });
      }

      if (args.detail_level === "summary") {
        const byType: Record<string, number> = {};
        for (const n of nodes) {
          const key = n.type || "unknown";
          byType[key] = (byType[key] ?? 0) + 1;
        }
        const sample = nodes.slice(0, SAMPLE_SIZE).map((n) => n.path);
        return structuredResult(
          `${matched} node(s) under ${args.parent_path}${where}. Summary only — pass detail_level:"full" or path_only:true for the full list.`,
          {
            ...base,
            by_type: byType,
            sample,
            ...(matched > sample.length
              ? {
                  hint: `Showing first ${sample.length} of ${matched}. Use detail_level:"full" for all.`,
                }
              : {}),
          },
        );
      }

      return structuredResult(`${matched} node(s) under ${args.parent_path}${where}.`, {
        ...base,
        nodes,
      });
    },
  );
}

export const registerGetTdNodes: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "get_td_nodes",
    {
      title: "List TouchDesigner nodes",
      description:
        'Read-only: list the DIRECT child nodes of one COMP. Defaults to a compact summary (count + type breakdown + sample paths); pass detail_level:"full" or path_only:true for the complete list, and `pattern` to filter by name. Returns {count, by_type/sample or paths/nodes}. Use this to browse one level; use find_td_nodes to search recursively and by operator type, or get_td_topology when you also need the connections between nodes. Token economy: keep the default compact summary and scope with `pattern`; only request the full list when you truly need every path, and avoid re-listing a path you already inspected.',
      inputSchema: getTdNodesSchema.shape,
      outputSchema: getTdNodesOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => getTdNodesImpl(ctx, args),
  );
};
