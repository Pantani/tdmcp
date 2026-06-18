import { z } from "zod";
import type { ProjectSearchFilters } from "../projectRag/types.js";
import type { LlmTool } from "./tools.js";

export const projectRagSearchSchema = z.object({
  query: z.string().min(1).describe("Free-text search query."),
  k: z.number().int().min(1).max(20).optional().describe("Number of results (default 5, max 20)."),
  license: z
    .array(z.string())
    .optional()
    .describe("Filter by license SPDX/family (e.g. ['CC0','MIT'])."),
  type: z
    .array(z.string())
    .optional()
    .describe("Filter by card type (project/component/snippet/...)."),
  operator: z
    .array(z.string())
    .optional()
    .describe("Filter to cards that reference these TD operator types."),
  tags: z.array(z.string()).optional().describe("Filter to cards having ALL listed tags."),
});

export type ProjectRagSearchArgs = z.infer<typeof projectRagSearchSchema>;

/**
 * Factory for the `project_rag_search` LLM tool exposed to the local copilot
 * (Telegram / `tdmcp ask` / `chat`). Read-only, zero side effects. The integrator
 * must include this in `resolveTools(...)` ONLY when `ctx.projectRag !== undefined`
 * — that env-gate (`TDMCP_PROJECT_RAG_ENABLED=1`) is enforced at catalog assembly,
 * not by refusing calls here, so a disabled server never advertises the tool.
 */
export function createProjectRagSearchTool(): LlmTool {
  return {
    name: "project_rag_search",
    description:
      "Search the local Project RAG repertoire (TouchDesigner projects, components, snippets) for real examples of an effect or technique. Read-only; every result includes provenance + license + rights notes.",
    schema: projectRagSearchSchema,
    mutates: false,
    run: async (ctx, args: ProjectRagSearchArgs) => {
      const service = ctx.projectRag;
      if (service === undefined) {
        return {
          content: [{ type: "text", text: "Project RAG is not enabled on this server." }],
          isError: true,
        };
      }
      const k = args.k ?? 5;
      const filters: ProjectSearchFilters = {};
      if (args.license !== undefined && args.license.length > 0) {
        filters.license = args.license as ProjectSearchFilters["license"];
      }
      if (args.type !== undefined && args.type.length > 0) {
        filters.type = args.type as ProjectSearchFilters["type"];
      }
      if (args.operator !== undefined && args.operator.length > 0) {
        filters.operators = args.operator;
      }
      if (args.tags !== undefined && args.tags.length > 0) {
        filters.tags = args.tags;
      }
      const useFilters = Object.keys(filters).length > 0 ? filters : undefined;
      const results = await service.search(args.query, k, useFilters);
      const text =
        results.length === 0
          ? `No Project RAG cards matched "${args.query}".`
          : results
              .map(
                (r) =>
                  `${r.score.toFixed(3)}  ${r.title} [${r.type}] — ${r.license} — tdmcp://project/cards/${r.id}`,
              )
              .join("\n");
      return {
        content: [{ type: "text", text }],
        structuredContent: { query: args.query, count: results.length, results },
      };
    },
  };
}
