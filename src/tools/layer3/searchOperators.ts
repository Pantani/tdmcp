import { z } from "zod";
import { cosineSimilarity, embedTextsCached } from "../../knowledge/embeddings.js";
import { loadConfig } from "../../utils/config.js";
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
  semantic: z
    .boolean()
    .default(false)
    .describe(
      "Opt-in: re-rank keyword candidates by embedding similarity via the configured LLM endpoint (TDMCP_LLM_BASE_URL / _MODEL, Ollama by default). Better for fuzzy/conceptual queries. Falls back to keyword ranking if the endpoint is unavailable — the default (false) needs nothing.",
    ),
});
type SearchOperatorsArgs = z.infer<typeof searchOperatorsSchema>;

export async function searchOperatorsImpl(ctx: ToolContext, args: SearchOperatorsArgs) {
  // Keyword search always runs: it's the result in default mode and the candidate pool in
  // semantic mode (recall first, then embedding re-rank for precision).
  const poolSize = args.semantic ? Math.max(args.limit * 4, 40) : args.limit;
  const keyword = ctx.knowledge.searchOperators(args.query, poolSize);

  if (!args.semantic || keyword.length === 0) {
    const operators = keyword.slice(0, args.limit);
    return structuredResult(`Found ${operators.length} operator(s) matching "${args.query}".`, {
      query: args.query,
      mode: "keyword",
      count: operators.length,
      operators,
    });
  }

  try {
    const config = loadConfig();
    const texts = [args.query, ...keyword.map((o) => `${o.name}. ${o.summary}`)];
    // Cached: operator-summary embeddings are reused across queries; only the query and any
    // not-yet-seen candidate actually hit the endpoint.
    const vectors = await embedTextsCached(texts, config);
    const queryVec = vectors[0] as number[];
    const operators = keyword
      .map((o, i) => ({ o, score: cosineSimilarity(queryVec, vectors[i + 1] as number[]) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, args.limit)
      .map((x) => x.o);
    return structuredResult(
      `Found ${operators.length} operator(s) for "${args.query}" (semantic re-rank of ${keyword.length} candidates).`,
      { query: args.query, mode: "semantic", count: operators.length, operators },
    );
  } catch (err) {
    const operators = keyword.slice(0, args.limit);
    return structuredResult(
      `Found ${operators.length} operator(s) matching "${args.query}" (semantic unavailable: ${String(err).slice(0, 80)}; using keyword ranking).`,
      { query: args.query, mode: "keyword_fallback", count: operators.length, operators },
    );
  }
}

export const registerSearchOperators: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "search_operators",
    {
      title: "Search operators",
      description:
        "Search the embedded operator knowledge base (629 operators) by keyword — name, family or description — ranked by relevance, fully offline. Use it to discover the right operator before creating nodes instead of guessing a type (e.g. 'what sends DMX?', 'particle', 'corner pin'). Returns name, family and a one-line summary per hit. Pass semantic:true to re-rank by embedding similarity (needs an LLM endpoint; falls back to keyword).",
      inputSchema: searchOperatorsSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => searchOperatorsImpl(ctx, args),
  );
};
