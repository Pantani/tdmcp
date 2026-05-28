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
  path: z.string().describe("The node or network root that was checked, echoing the request."),
  total: z.number().describe("Total number of errors/warnings found (0 means clean)."),
  errors: z
    .array(NodeErrorSchema)
    .optional()
    .describe("Full mode: each error/warning with its node path, type and message."),
  by_type: z
    .record(z.string(), z.number())
    .optional()
    .describe("summary mode: count of errors grouped by error type."),
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
        "Read-only: check one node (or, with recursive:true, its whole sub-network) for cook/compile errors and warnings. Pass `summary:true` for grouped counts instead of the full list. Returns {total, errors[] or by_type}. For a large network prefer summarize_td_errors, which clusters errors by shared cause and points at the worst-offending nodes.",
      inputSchema: getTdNodeErrorsSchema.shape,
      outputSchema: getTdNodeErrorsOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => getTdNodeErrorsImpl(ctx, args),
  );
};
