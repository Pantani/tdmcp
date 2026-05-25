import { z } from "zod";
import { guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const getTdNodeErrorsSchema = z.object({
  path: z.string().describe("Full path of the node (or network root) to check for errors."),
  recursive: z
    .boolean()
    .default(false)
    .describe("If true, check the whole network under `path`; otherwise just that node."),
});
type GetTdNodeErrorsArgs = z.infer<typeof getTdNodeErrorsSchema>;

export async function getTdNodeErrorsImpl(ctx: ToolContext, args: GetTdNodeErrorsArgs) {
  return guardTd(
    () =>
      args.recursive ? ctx.client.getNetworkErrors(args.path) : ctx.client.getNodeErrors(args.path),
    (result) =>
      jsonResult(
        result.errors.length === 0
          ? `No errors found at ${args.path}.`
          : `Found ${result.errors.length} error(s) at ${args.path}.`,
        result,
      ),
  );
}

export const registerGetTdNodeErrors: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "get_td_node_errors",
    {
      title: "Get node errors",
      description: "Check a node (or its whole sub-network) for cook/compile errors and warnings.",
      inputSchema: getTdNodeErrorsSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => getTdNodeErrorsImpl(ctx, args),
  );
};
