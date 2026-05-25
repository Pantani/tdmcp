import { z } from "zod";
import { NodeRefSchema } from "../../td-client/validators.js";
import { guardTd, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { globToRegExp } from "./nodeMatch.js";

export const findTdNodesSchema = z.object({
  parent_path: z.string().default("/project1").describe("Where to search from."),
  pattern: z
    .string()
    .optional()
    .describe("Case-insensitive name/path filter with '*' wildcards (e.g. 'text*', '*noise*')."),
  type: z
    .string()
    .optional()
    .describe("Case-insensitive operator-type substring (e.g. 'TOP', 'noise')."),
  recursive: z
    .boolean()
    .default(true)
    .describe("Search the whole sub-network (true) or only direct children (false)."),
  path_only: z.boolean().default(false).describe("Return only matching paths."),
  limit: z.number().int().positive().default(50).describe("Max matches to return."),
});
type FindTdNodesArgs = z.infer<typeof findTdNodesSchema>;

export const findTdNodesOutputSchema = z.object({
  parent_path: z.string(),
  recursive: z.boolean(),
  count: z.number(),
  truncated: z.boolean(),
  paths: z.array(z.string()).optional(),
  matches: z.array(NodeRefSchema).optional(),
});

export async function findTdNodesImpl(ctx: ToolContext, args: FindTdNodesArgs) {
  const fetch = args.recursive
    ? async () => (await ctx.client.getNetworkTopology(args.parent_path, true)).nodes
    : async () => (await ctx.client.getNodes(args.parent_path)).nodes;

  return guardTd(fetch, (allNodes) => {
    let nodes = allNodes;
    if (args.pattern) {
      const re = globToRegExp(args.pattern);
      nodes = nodes.filter((n) => re.test(n.name) || re.test(n.path));
    }
    if (args.type) {
      const t = args.type.toLowerCase();
      nodes = nodes.filter((n) => n.type.toLowerCase().includes(t));
    }
    const count = nodes.length;
    const truncated = count > args.limit;
    nodes = nodes.slice(0, args.limit);
    const summary = `${count} match(es) under ${args.parent_path}${truncated ? ` (showing ${args.limit})` : ""}.`;
    const base = { parent_path: args.parent_path, recursive: args.recursive, count, truncated };
    return args.path_only
      ? structuredResult(summary, { ...base, paths: nodes.map((n) => n.path) })
      : structuredResult(summary, { ...base, matches: nodes });
  });
}

export const registerFindTdNodes: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "find_td_nodes",
    {
      title: "Find TouchDesigner nodes",
      description:
        "Search a network for nodes by name pattern and/or operator type. Recursive by default; pass path_only:true for a compact path list. Prefer this over get_td_nodes when you are looking for specific nodes.",
      inputSchema: findTdNodesSchema.shape,
      outputSchema: findTdNodesOutputSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => findTdNodesImpl(ctx, args),
  );
};
