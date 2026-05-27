import { z } from "zod";
import { structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const searchOperatorsSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "What you're looking for — words from a name, family, or description (e.g. 'blur edge', 'audio spectrum', 'instance geometry').",
    ),
  limit: z.coerce.number().int().positive().max(100).default(20).describe("Max results to return."),
});
type SearchOperatorsArgs = z.infer<typeof searchOperatorsSchema>;

export function searchOperatorsImpl(ctx: ToolContext, args: SearchOperatorsArgs) {
  const results = ctx.knowledge.searchOperators(args.query, args.limit);
  return structuredResult(`Found ${results.length} operator(s) matching "${args.query}".`, {
    query: args.query,
    count: results.length,
    operators: results,
  });
}

export const registerSearchOperators: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "search_operators",
    {
      title: "Search operators",
      description:
        "Search the embedded operator knowledge base (629 operators) by keyword — name, family or description — ranked by relevance, fully offline. Use it to discover the right operator before creating nodes instead of guessing a type (e.g. 'what sends DMX?', 'particle', 'corner pin'). Returns name, family and a one-line summary per hit.",
      inputSchema: searchOperatorsSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => searchOperatorsImpl(ctx, args),
  );
};
