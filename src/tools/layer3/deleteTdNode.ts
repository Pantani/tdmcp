import { z } from "zod";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const deleteTdNodeSchema = z.object({
  path: z.string().describe("Full path of the node to delete, e.g. '/project1/noise1'."),
  mode: z
    .enum(["delete", "bypass"])
    .default("delete")
    .describe(
      "'delete' (default) destroys the node; 'bypass' is the safer, reversible middle ground — it turns the operator's bypass flag on instead of removing it, so the artist can re-enable it with one click.",
    ),
});
type DeleteTdNodeArgs = z.infer<typeof deleteTdNodeSchema>;

export async function deleteTdNodeImpl(ctx: ToolContext, args: DeleteTdNodeArgs) {
  return guardTd(
    () => ctx.client.deleteNode(args.path, args.mode),
    (result) => {
      const yoloNote = ctx.yolo ? " (TDMCP_YOLO on: confirmations skipped)" : "";
      if (result.bypassed) {
        return jsonResult(`Bypassed ${result.bypassed} (not destroyed)${yoloNote}.`, result);
      }
      return jsonResult(`Deleted ${result.deleted ?? args.path}${yoloNote}.`, result);
    },
  );
}

export const registerDeleteTdNode: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "delete_td_node",
    {
      title: "Delete TouchDesigner node",
      description:
        "DESTRUCTIVE by default: permanently remove one node from the project by path (a COMP also takes its children with it); this cannot be undone via the API. Prefer mode:'bypass' when you only want to disable a node — it turns the bypass flag on (reversible) instead of destroying it. Returns {deleted|bypassed, mode}. Only call delete mode when the user explicitly asks to remove a node.",
      inputSchema: deleteTdNodeSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (args) => deleteTdNodeImpl(ctx, args),
  );
};
