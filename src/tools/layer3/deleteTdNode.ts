import { z } from "zod";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const deleteTdNodeSchema = z.object({
  path: z.string().describe("Full path of the node to delete, e.g. '/project1/noise1'."),
});
type DeleteTdNodeArgs = z.infer<typeof deleteTdNodeSchema>;

export async function deleteTdNodeImpl(ctx: ToolContext, args: DeleteTdNodeArgs) {
  return guardTd(
    () => ctx.client.deleteNode(args.path),
    (result) => jsonResult(`Deleted ${result.deleted}.`, result),
  );
}

export const registerDeleteTdNode: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "delete_td_node",
    {
      title: "Delete TouchDesigner node",
      description:
        "Delete a single node by path. Destructive — only call this when the user explicitly asks to remove a node.",
      inputSchema: deleteTdNodeSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (args) => deleteTdNodeImpl(ctx, args),
  );
};
