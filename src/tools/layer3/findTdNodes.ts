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
  parent_path: z.string().describe("The network root the search ran under."),
  recursive: z.boolean().describe("Whether descendants were searched, echoing the request."),
  count: z.number().describe("Total nodes matched before `limit` truncation."),
  truncated: z.boolean().describe("True if more nodes matched than `limit` returned."),
  paths: z
    .array(z.string())
    .optional()
    .describe("path_only mode: the matched node paths and nothing else."),
  matches: z
    .array(NodeRefSchema)
    .optional()
    .describe("Default mode: each matched node as {path, name, type}."),
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
        "Read-only: search a network for nodes by name pattern and/or operator type, recursively by default. Returns {count, truncated, matches/paths}. Prefer this over get_td_nodes when you are looking for specific nodes anywhere in a sub-tree (get_td_nodes only lists one COMP's direct children); use get_td_topology when you also need the wiring between them.",
      inputSchema: findTdNodesSchema.shape,
      outputSchema: findTdNodesOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => findTdNodesImpl(ctx, args),
  );
};
