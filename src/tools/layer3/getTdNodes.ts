import { z } from "zod";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const getTdNodesSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP whose direct children should be listed."),
});
type GetTdNodesArgs = z.infer<typeof getTdNodesSchema>;

export async function getTdNodesImpl(ctx: ToolContext, args: GetTdNodesArgs) {
  return guardTd(
    () => ctx.client.getNodes(args.parent_path),
    (list) => jsonResult(`Found ${list.nodes.length} node(s) under ${args.parent_path}.`, list),
  );
}

export const registerGetTdNodes: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "get_td_nodes",
    {
      title: "List TouchDesigner nodes",
      description: "List the direct child nodes of a COMP.",
      inputSchema: getTdNodesSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => getTdNodesImpl(ctx, args),
  );
};
