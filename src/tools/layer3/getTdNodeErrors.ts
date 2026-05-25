import { z } from "zod";
import { NodeErrorSchema } from "../../td-client/validators.js";
import { guardTd, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const getTdNodeErrorsSchema = z.object({
  path: z.string().describe("Full path of the node (or network root) to check for errors."),
  recursive: z
    .boolean()
    .default(false)
    .describe("If true, check the whole network under `path`; otherwise just that node."),
  summary: z
    .boolean()
    .default(false)
    .describe("Return only counts grouped by error type instead of the full error list."),
});
type GetTdNodeErrorsArgs = z.infer<typeof getTdNodeErrorsSchema>;

export const getTdNodeErrorsOutputSchema = z.object({
  path: z.string(),
  total: z.number(),
  errors: z.array(NodeErrorSchema).optional(),
  by_type: z.record(z.string(), z.number()).optional(),
});

export async function getTdNodeErrorsImpl(ctx: ToolContext, args: GetTdNodeErrorsArgs) {
  return guardTd(
    () =>
      args.recursive ? ctx.client.getNetworkErrors(args.path) : ctx.client.getNodeErrors(args.path),
    (result) => {
      const errors = result.errors;
      const total = errors.length;
      const none = total === 0;
      if (args.summary) {
        const byType: Record<string, number> = {};
        for (const e of errors) {
          const key = e.type || "error";
          byType[key] = (byType[key] ?? 0) + 1;
        }
        return structuredResult(
          none ? `No errors found at ${args.path}.` : `${total} error(s) at ${args.path}.`,
          { path: args.path, total, by_type: byType },
        );
      }
      return structuredResult(
        none ? `No errors found at ${args.path}.` : `Found ${total} error(s) at ${args.path}.`,
        { path: args.path, total, errors },
      );
    },
  );
}

export const registerGetTdNodeErrors: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "get_td_node_errors",
    {
      title: "Get node errors",
      description:
        "Check a node (or its whole sub-network) for cook/compile errors and warnings. Pass `summary:true` for grouped counts instead of the full list.",
      inputSchema: getTdNodeErrorsSchema.shape,
      outputSchema: getTdNodeErrorsOutputSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => getTdNodeErrorsImpl(ctx, args),
  );
};
