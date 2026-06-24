import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const searchSurfaces = [
  "all",
  "operators",
  "operator_workflows",
  "operator_examples",
  "versions",
  "operator_compatibility",
  "python_api_compatibility",
  "techniques",
  "td_classes",
  "experimentals",
] as const;

const resultSurfaces = [
  "operators",
  "operator_workflows",
  "operator_examples",
  "versions",
  "operator_compatibility",
  "python_api_compatibility",
  "techniques",
  "td_classes",
  "experimentals",
] as const;

const searchSurfaceSchema = z.enum(searchSurfaces);
const resultSurfaceSchema = z.enum(resultSurfaces);

type SearchSurface = z.infer<typeof searchSurfaceSchema>;
type ResultSurface = z.infer<typeof resultSurfaceSchema>;

export const searchTouchDesignerKnowledgeSchema = z.object({
  query: z.string().min(1).describe("Search text to route across TouchDesigner knowledge."),
  surface: searchSurfaceSchema
    .default("all")
    .describe(
      "Knowledge surface to search: all, operators, operator_workflows, operator_examples, versions, operator_compatibility, python_api_compatibility, techniques, td_classes, or experimentals.",
    ),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(50)
    .default(10)
    .describe("Maximum number of results to return."),
});
type SearchTouchDesignerKnowledgeArgs = z.input<typeof searchTouchDesignerKnowledgeSchema>;

const searchTouchDesignerKnowledgeResultSchema = z.object({
  surface: resultSurfaceSchema.describe("Knowledge surface that produced this result."),
  id: z.string().describe("Stable id for the result within its surface."),
  name: z.string().describe("Human-readable result name."),
  description: z.string().optional().describe("Short description when available."),
  resourceUri: z.string().optional().describe("tdmcp:// resource URI for a detailed lookup."),
  toolHint: z.string().optional().describe("Suggested tool to call next for this result."),
});

export const searchTouchDesignerKnowledgeOutputSchema = z.object({
  query: z.string().describe("Search text from the request."),
  surface: searchSurfaceSchema.describe("Surface requested by the caller."),
  count: z.number().int().nonnegative().describe("Number of returned results."),
  results: z
    .array(searchTouchDesignerKnowledgeResultSchema)
    .describe("Normalized knowledge search results."),
});

type SearchTouchDesignerKnowledgeResult = z.infer<typeof searchTouchDesignerKnowledgeResultSchema>;

function maybeDescription(
  description: string | undefined,
): Pick<SearchTouchDesignerKnowledgeResult, "description"> {
  return description ? { description } : {};
}

function resourceUri(prefix: string, id: string): string {
  return `${prefix}${encodeURIComponent(id)}`;
}

function techniqueCategory(id: string): string {
  return id.split("/", 1)[0] ?? id;
}

function searchSurface(
  ctx: ToolContext,
  surface: ResultSurface,
  query: string,
  limit: number,
): SearchTouchDesignerKnowledgeResult[] {
  switch (surface) {
    case "operators":
      return ctx.knowledge.searchOperators(query, limit).map((operator) => ({
        surface,
        id: operator.slug,
        name: operator.displayName,
        ...maybeDescription(operator.summary),
        resourceUri: resourceUri("tdmcp://operators/", operator.slug),
        toolHint: "search_operators",
      }));

    case "operator_workflows":
      return ctx.knowledge.searchOperatorConnectionGuides(query, limit).map((guide) => ({
        surface,
        id: guide.id,
        name: guide.name,
        ...maybeDescription(guide.description),
        resourceUri: resourceUri("tdmcp://operator-connections/", guide.id),
        toolHint: "get_operator_workflow_guide",
      }));

    case "operator_examples":
      return ctx.knowledge.searchOperatorExampleGuides(query, limit).map((guide) => ({
        surface,
        id: guide.id,
        name: guide.name,
        ...maybeDescription(guide.description),
        resourceUri: resourceUri("tdmcp://operator-examples/", guide.id),
        toolHint: "get_operator_workflow_guide",
      }));

    case "versions":
      return ctx.knowledge.searchTouchDesignerVersions(query, limit).map((version) => ({
        surface,
        id: version.version,
        name: version.name,
        ...maybeDescription(version.summary),
        resourceUri: resourceUri("tdmcp://td-versions/", version.version),
      }));

    case "operator_compatibility":
      return ctx.knowledge.searchOperatorCompatibility(query, limit).map((entry) => ({
        surface,
        id: entry.id,
        name: entry.name,
        ...maybeDescription(entry.description),
        resourceUri: resourceUri("tdmcp://compat/operators/", entry.id),
      }));

    case "python_api_compatibility":
      return ctx.knowledge.searchPythonApiCompatibility(query, limit).map((entry) => ({
        surface,
        id: entry.id,
        name: entry.name,
        ...maybeDescription(entry.description),
        resourceUri: resourceUri("tdmcp://compat/python/", entry.id),
      }));

    case "techniques":
      return ctx.knowledge.searchTechniques(query, limit).map((technique) => {
        const category = techniqueCategory(technique.id);
        return {
          surface,
          id: technique.id,
          name: technique.name,
          ...maybeDescription(technique.description),
          resourceUri: resourceUri("tdmcp://techniques/", category),
        };
      });

    case "td_classes":
      return ctx.knowledge.searchTouchDesignerClasses(query, limit).map((entry) => ({
        surface,
        id: entry.id,
        name: entry.name,
        ...maybeDescription(entry.description),
        resourceUri: resourceUri("tdmcp://td-classes/", entry.id),
      }));

    case "experimentals":
      return ctx.knowledge.searchTouchDesignerExperimentals(query, limit).map((entry) => ({
        surface,
        id: entry.id,
        name: entry.name,
        ...maybeDescription(entry.description),
        resourceUri: resourceUri("tdmcp://td-experimental/", entry.id),
      }));
  }
}

function collectResults(
  ctx: ToolContext,
  surface: SearchSurface,
  query: string,
  limit: number,
): SearchTouchDesignerKnowledgeResult[] {
  if (surface !== "all") {
    return searchSurface(ctx, surface, query, limit);
  }

  return resultSurfaces
    .flatMap((candidateSurface) => searchSurface(ctx, candidateSurface, query, limit))
    .slice(0, limit);
}

export function searchTouchDesignerKnowledgeImpl(
  ctx: ToolContext,
  rawArgs: SearchTouchDesignerKnowledgeArgs,
): CallToolResult {
  const parsed = searchTouchDesignerKnowledgeSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult("Invalid search_touchdesigner_knowledge input.", {
      issues: parsed.error.issues,
    });
  }

  const args = parsed.data;
  try {
    const results = collectResults(ctx, args.surface, args.query, args.limit);
    const surfaceLabel = args.surface === "all" ? "all surfaces" : args.surface;
    return structuredResult(
      `Found ${results.length} TouchDesigner knowledge result(s) for "${args.query}" in ${surfaceLabel}.`,
      {
        query: args.query,
        surface: args.surface,
        count: results.length,
        results,
      },
    );
  } catch (err) {
    return errorResult(
      `TouchDesigner knowledge search failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export const registerSearchTouchDesignerKnowledge: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "search_touchdesigner_knowledge",
    {
      title: "Search TouchDesigner knowledge",
      description:
        "Read-only: search the embedded TouchDesigner knowledge router across operators, operator workflows, examples, versions, compatibility notes, technique packs, TD classes, and experimental build notes. Returns normalized results with resource URIs and tool hints for deeper lookups.",
      inputSchema: searchTouchDesignerKnowledgeSchema.shape,
      outputSchema: searchTouchDesignerKnowledgeOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) => searchTouchDesignerKnowledgeImpl(ctx, args),
  );
};
