import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { buildSectionView, capText } from "../../knowledge/docSections.js";
import type { Tutorial, TutorialSummary } from "../../knowledge/types.js";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  flattenTutorialContent,
  tutorialContentToMarkdown,
  tutorialTextFields,
} from "./tutorialContent.js";

export const getTutorialSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Optional search text to match against embedded tutorial metadata and content."),
  name: z.string().trim().min(1).optional().describe("Optional tutorial id or name to retrieve."),
  include_content: z
    .boolean()
    .default(false)
    .describe(
      "When true, include tutorial content (capped, with a sections_available list) in returned entries.",
    ),
  section: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "With include_content, drill into one section by title (from sections_available) instead of the intro overview — the cheap way to read a long tutorial.",
    ),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(50)
    .default(10)
    .describe("Maximum tutorials to return for list and search modes."),
});

type GetTutorialInput = z.input<typeof getTutorialSchema>;
type GetTutorialArgs = z.output<typeof getTutorialSchema>;

const tutorialResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string().optional(),
  category: z.string().optional(),
  subcategory: z.string().optional(),
  description: z.string().optional(),
  summary: z.string().optional(),
  content: z.string().optional(),
  sections_available: z.array(z.string()).optional(),
  content_truncated: z.boolean().optional(),
  keywords: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  resourceUri: z.string(),
});

export const getTutorialOutputSchema = z.object({
  mode: z.enum(["list", "search", "tutorial"]),
  query: z.string().optional(),
  name: z.string().optional(),
  count: z.number().int().nonnegative(),
  tutorial: tutorialResultSchema.optional(),
  tutorials: z.array(tutorialResultSchema).optional(),
  nextToolHints: z.array(z.string()),
});

type TutorialResult = z.output<typeof tutorialResultSchema>;

function compactKey(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function resourceUri(id: string): string {
  return `tdmcp://tutorials/${encodeURIComponent(id)}`;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function summaryMatches(summary: TutorialSummary, name: string): boolean {
  const key = compactKey(name);
  return compactKey(summary.id) === key || compactKey(summary.name) === key;
}

function resolveTutorial(
  ctx: ToolContext,
  summaries: TutorialSummary[],
  name: string,
): Tutorial | TutorialSummary | undefined {
  return (
    ctx.knowledge.getTutorial(name) ?? summaries.find((summary) => summaryMatches(summary, name))
  );
}

function tutorialId(tutorial: Tutorial | TutorialSummary): string {
  return tutorial.id;
}

function tutorialName(tutorial: Tutorial | TutorialSummary): string {
  return tutorial.name;
}

/** List/search content: the flattened tutorial, capped to the budget (no section stripping). */
function cappedContentFields(
  full: Tutorial,
  includeContent: boolean,
): Pick<TutorialResult, "content" | "content_truncated"> {
  if (!includeContent || !full.content) return {};
  const flat = flattenTutorialContent(full.content);
  if (!flat) return {};
  const { text, truncated } = capText(flat);
  return { content: text, content_truncated: truncated };
}

function tutorialToResult(
  tutorial: Tutorial | TutorialSummary,
  includeContent: boolean,
): TutorialResult {
  const full = tutorial as Tutorial;
  return {
    id: tutorialId(tutorial),
    name: tutorialName(tutorial),
    displayName: full.displayName,
    category: tutorial.category,
    subcategory: full.subcategory,
    description: full.description,
    summary: tutorial.summary,
    ...cappedContentFields(full, includeContent),
    keywords: full.keywords,
    tags: full.tags,
    resourceUri: resourceUri(tutorialId(tutorial)),
  };
}

/**
 * Single-tutorial retrieval: replace the capped content with a sectioned view —
 * an intro + sections_available overview by default, or one drilled-in section.
 */
function withSectionView(
  result: TutorialResult,
  tutorial: Tutorial | TutorialSummary,
  includeContent: boolean,
  section: string | undefined,
): TutorialResult {
  const full = tutorial as Tutorial;
  if (!includeContent || !full.content) return result;
  const markdown = tutorialContentToMarkdown(full.content) ?? flattenTutorialContent(full.content);
  if (!markdown) return result;
  const view = buildSectionView(markdown, { section });
  return {
    ...result,
    content: view.content,
    sections_available: view.sections_available,
    content_truncated: view.truncated,
  };
}

function tutorialHaystack(summary: TutorialSummary, tutorial: Tutorial | undefined): string {
  return [
    summary.id,
    summary.name,
    summary.category,
    summary.summary,
    tutorial ? tutorialTextFields(tutorial) : undefined,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

function queryTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function searchScore(
  summary: TutorialSummary,
  tutorial: Tutorial | undefined,
  terms: string[],
): number {
  const haystack = tutorialHaystack(summary, tutorial);
  if (!terms.every((term) => haystack.includes(term))) return 0;

  const nameText =
    `${summary.id} ${summary.name} ${tutorial?.id ?? ""} ${tutorial?.name ?? ""}`.toLowerCase();
  return terms.reduce((score, term) => {
    if (nameText.includes(term)) return score + 2;
    return score + 1;
  }, 0);
}

function searchTutorials(
  ctx: ToolContext,
  summaries: TutorialSummary[],
  args: GetTutorialArgs,
): TutorialResult[] {
  const terms = queryTerms(args.query ?? "");
  const scored = summaries
    .map((summary, index) => {
      const tutorial = ctx.knowledge.getTutorial(summary.id);
      return {
        index,
        score: searchScore(summary, tutorial, terms),
        tutorial: tutorial ?? summary,
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  return scored
    .slice(0, args.limit)
    .map((entry) => tutorialToResult(entry.tutorial, args.include_content));
}

function listTutorials(
  ctx: ToolContext,
  summaries: TutorialSummary[],
  args: GetTutorialArgs,
): TutorialResult[] {
  return summaries
    .slice(0, args.limit)
    .map((summary) =>
      tutorialToResult(
        args.include_content ? (ctx.knowledge.getTutorial(summary.id) ?? summary) : summary,
        args.include_content,
      ),
    );
}

function unknownTutorial(name: string, summaries: TutorialSummary[]): CallToolResult {
  const availableIds = summaries.map((summary) => summary.id);
  const suggestions = uniqueStrings(
    summaries.flatMap((summary) => [summary.id, summary.name]).slice(0, 20),
  );
  return errorResult(`Unknown tutorial "${name}". Available ids: ${availableIds.join(", ")}`, {
    name,
    suggestions,
    availableIds,
  });
}

export function getTutorialImpl(ctx: ToolContext, rawArgs: GetTutorialInput): CallToolResult {
  const parsed = getTutorialSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult("Invalid get_tutorial input.", { issues: parsed.error.issues });
  }

  const args = parsed.data;
  try {
    const summaries = ctx.knowledge.listTutorials();

    if (args.name) {
      const tutorial = resolveTutorial(ctx, summaries, args.name);
      if (!tutorial) return unknownTutorial(args.name, summaries);

      const result = withSectionView(
        tutorialToResult(tutorial, args.include_content),
        tutorial,
        args.include_content,
        args.section,
      );
      return structuredResult(`Tutorial ${result.name}.`, {
        mode: "tutorial",
        name: args.name,
        count: 1,
        tutorial: result,
        nextToolHints: ["search_touchdesigner_knowledge"],
      });
    }

    if (args.query) {
      const tutorials = searchTutorials(ctx, summaries, args);
      const label = tutorials.length === 1 ? "tutorial" : "tutorials";
      return structuredResult(
        `Found ${tutorials.length} TouchDesigner ${label} for "${args.query}".`,
        {
          mode: "search",
          query: args.query,
          count: tutorials.length,
          tutorials,
          nextToolHints: ["get_tutorial"],
        },
      );
    }

    const tutorials = listTutorials(ctx, summaries, args);
    return structuredResult(`Listed ${tutorials.length} TouchDesigner tutorial(s).`, {
      mode: "list",
      count: tutorials.length,
      tutorials,
      nextToolHints: ["get_tutorial", "search_touchdesigner_knowledge"],
    });
  } catch (err) {
    return errorResult(
      `Failed to read TouchDesigner tutorials: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export const registerGetTutorial: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "get_tutorial",
    {
      title: "Get TouchDesigner tutorial",
      description:
        "Read-only: list embedded TouchDesigner tutorials, search tutorial metadata/content, or retrieve one by id/name. With include_content, the content is capped (~30K chars) and comes with a sections_available list; pass a `section` title to drill into just that part instead of pulling the whole document.",
      inputSchema: getTutorialSchema.shape,
      outputSchema: getTutorialOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) => getTutorialImpl(ctx, args),
  );
};
