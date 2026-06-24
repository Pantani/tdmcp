import { z } from "zod";
import type {
  PythonClassSummary,
  PythonMember,
  PythonMethod,
  TdPythonApiCompatibilityEntry,
} from "../../knowledge/types.js";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const searchInSchema = z.enum(["all", "classes", "methods", "members"]);

export const searchPythonApiSchema = z.object({
  query: z.string().min(1).describe("Search query for TD Python classes, methods, or members."),
  search_in: searchInSchema
    .default("all")
    .describe("Where to search: all, classes, methods, or members."),
  category: z
    .string()
    .optional()
    .describe("Optional Python class category filter, e.g. General or Operator."),
  limit: z.coerce.number().int().positive().max(100).default(20).describe("Max results per group."),
  version: z
    .string()
    .optional()
    .describe("Optional stable TouchDesigner version filter, e.g. 099, 2020, 2023, or 2024."),
});
type SearchPythonApiInput = z.input<typeof searchPythonApiSchema>;
type SearchPythonApiArgs = z.output<typeof searchPythonApiSchema>;

interface PythonClassHit {
  className: string;
  displayName: string;
  category: string;
  description?: string;
}

interface PythonMethodHit {
  className: string;
  name: string;
  signature?: string;
  returns?: string;
  description?: string;
  addedIn?: string;
}

interface PythonMemberHit {
  className: string;
  name: string;
  returnType?: string;
  readOnly?: boolean;
  description?: string;
  addedIn?: string;
}

interface VersionFilter {
  requested: string;
  resolved: string;
}

interface SearchReport {
  classes: PythonClassHit[];
  methods: PythonMethodHit[];
  members: PythonMemberHit[];
  tips: string[];
  warnings: string[];
}

export const searchPythonApiOutputSchema = z.object({
  query: z.string().describe("Echo of the search query."),
  filters: z
    .object({
      search_in: searchInSchema.describe("Surface that was searched."),
      category: z.string().optional().describe("Category filter, if requested."),
      version: z.string().optional().describe("Version filter, if requested."),
      resolvedVersion: z.string().optional().describe("Resolved TouchDesigner version id."),
    })
    .describe("Filters applied to the search."),
  count: z.number().describe("Number of returned results."),
  classes: z
    .array(
      z.object({
        className: z.string(),
        displayName: z.string(),
        category: z.string(),
        description: z.string().optional(),
      }),
    )
    .describe("Matching Python API classes."),
  methods: z
    .array(
      z.object({
        className: z.string(),
        name: z.string(),
        signature: z.string().optional(),
        returns: z.string().optional(),
        description: z.string().optional(),
        addedIn: z.string().optional(),
      }),
    )
    .describe("Matching Python API methods."),
  members: z
    .array(
      z.object({
        className: z.string(),
        name: z.string(),
        returnType: z.string().optional(),
        readOnly: z.boolean().optional(),
        description: z.string().optional(),
        addedIn: z.string().optional(),
      }),
    )
    .describe("Matching Python API members."),
  tips: z.array(z.string()).describe("Follow-up hints when no results are found."),
});

function compactKey(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function terms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function includesAllTerms(text: string, queryTerms: string[]): boolean {
  return queryTerms.every((term) => text.includes(term));
}

function textMatches(parts: Array<string | undefined>, queryTerms: string[]): boolean {
  return includesAllTerms(parts.filter(Boolean).join(" ").toLowerCase(), queryTerms);
}

function versionIndex(ctx: ToolContext, version: string | undefined): number {
  if (!version) return -1;
  return ctx.knowledge.listTdVersions().findIndex((entry) => entry.id === version);
}

function isAvailableInVersion(
  ctx: ToolContext,
  addedIn: string | undefined,
  filter: VersionFilter | undefined,
): boolean {
  if (!filter || !addedIn) return true;
  const targetIndex = versionIndex(ctx, filter.resolved);
  const addedIndex = versionIndex(ctx, addedIn);
  return targetIndex === -1 || addedIndex === -1 || addedIndex <= targetIndex;
}

function classAvailable(ctx: ToolContext, className: string, filter: VersionFilter | undefined) {
  const compatibility = ctx.knowledge.getPythonApiCompatibility(className);
  return isAvailableInVersion(ctx, compatibility?.addedIn, filter);
}

function classMatchesCategory(summary: PythonClassSummary, category: string | undefined): boolean {
  return !category || compactKey(summary.category) === compactKey(category);
}

function classHit(summary: PythonClassSummary, description: string | undefined): PythonClassHit {
  return {
    className: summary.className,
    displayName: summary.displayName,
    category: summary.category,
    description,
  };
}

function methodHit(
  className: string,
  method: PythonMethod,
  compatibility?: TdPythonApiCompatibilityEntry,
): PythonMethodHit | undefined {
  const name = method.name ?? compatibility?.name;
  if (!name) return undefined;
  return {
    className,
    name,
    signature: method.signature ?? compatibility?.signature,
    returns: method.returns,
    description: method.description ?? compatibility?.description,
    addedIn: compatibility?.addedIn,
  };
}

function memberHit(
  className: string,
  member: PythonMember,
  compatibility?: TdPythonApiCompatibilityEntry,
): PythonMemberHit | undefined {
  const name = member.name ?? compatibility?.name;
  if (!name) return undefined;
  return {
    className,
    name,
    returnType: member.returnType,
    readOnly: member.readOnly,
    description: member.description ?? compatibility?.description,
    addedIn: compatibility?.addedIn,
  };
}

function matchesClass(
  summary: PythonClassSummary,
  description: string | undefined,
  queryTerms: string[],
): boolean {
  return textMatches(
    [summary.className, summary.displayName, summary.category, description],
    queryTerms,
  );
}

function matchesMethod(hit: PythonMethodHit, queryTerms: string[]): boolean {
  return textMatches([hit.className, hit.name, hit.signature, hit.description], queryTerms);
}

function matchesMember(hit: PythonMemberHit, queryTerms: string[]): boolean {
  return textMatches([hit.className, hit.name, hit.returnType, hit.description], queryTerms);
}

function dedupeBy<T>(items: T[], keyFor: (item: T) => string): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const item of items) {
    const key = keyFor(item);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function classSortRank(className: string): string {
  const key = compactKey(className);
  if (key === "td") return "00";
  if (key === "op") return "01";
  if (["chop", "comp", "dat", "mat", "sop", "top"].includes(key)) return "02";
  return "10";
}

function sortByClassAndName<T extends { className: string; name?: string }>(items: T[]): T[] {
  return [...items].sort(
    (a, b) =>
      classSortRank(a.className).localeCompare(classSortRank(b.className)) ||
      a.className.localeCompare(b.className) ||
      (a.name ?? "").localeCompare(b.name ?? ""),
  );
}

function relevance(value: string | undefined, query: string): number {
  const key = compactKey(value);
  const q = compactKey(query);
  if (!key || !q) return 4;
  if (key === q) return 0;
  if (key.startsWith(q)) return 1;
  if (key.includes(q)) return 2;
  return 3;
}

function sortClassHits(items: PythonClassHit[], query: string): PythonClassHit[] {
  return [...items].sort(
    (a, b) =>
      Math.min(relevance(a.className, query), relevance(a.displayName, query)) -
        Math.min(relevance(b.className, query), relevance(b.displayName, query)) ||
      classSortRank(a.className).localeCompare(classSortRank(b.className)) ||
      a.className.localeCompare(b.className),
  );
}

function sortMethodHits(items: PythonMethodHit[], query: string): PythonMethodHit[] {
  return [...items].sort(
    (a, b) =>
      Math.min(relevance(a.name, query), relevance(a.signature, query)) -
        Math.min(relevance(b.name, query), relevance(b.signature, query)) ||
      classSortRank(a.className).localeCompare(classSortRank(b.className)) ||
      a.className.localeCompare(b.className) ||
      a.name.localeCompare(b.name),
  );
}

function sortMemberHits(items: PythonMemberHit[], query: string): PythonMemberHit[] {
  return [...items].sort(
    (a, b) =>
      Math.min(relevance(a.name, query), relevance(a.returnType, query)) -
        Math.min(relevance(b.name, query), relevance(b.returnType, query)) ||
      classSortRank(a.className).localeCompare(classSortRank(b.className)) ||
      a.className.localeCompare(b.className) ||
      a.name.localeCompare(b.name),
  );
}

function searchDocs(
  ctx: ToolContext,
  args: SearchPythonApiArgs,
  filter?: VersionFilter,
): SearchReport {
  const queryTerms = terms(args.query);
  const classes: PythonClassHit[] = [];
  const methods: PythonMethodHit[] = [];
  const members: PythonMemberHit[] = [];

  for (const summary of ctx.knowledge.listPythonClasses()) {
    if (!classMatchesCategory(summary, args.category)) continue;
    if (!classAvailable(ctx, summary.className, filter)) continue;

    const doc = ctx.knowledge.getPythonClass(summary.className);
    if (
      (args.search_in === "all" || args.search_in === "classes") &&
      matchesClass(summary, doc?.description, queryTerms)
    ) {
      classes.push(classHit(summary, doc?.description));
    }

    if (!doc) continue;
    if (args.search_in === "all" || args.search_in === "methods") {
      for (const method of doc.methods ?? []) {
        const name = method.name;
        const compatibility = name
          ? ctx.knowledge.getPythonApiCompatibility(`${summary.className}.${name}`)
          : undefined;
        const hit = methodHit(summary.className, method, compatibility);
        if (!hit || !matchesMethod(hit, queryTerms)) continue;
        if (!isAvailableInVersion(ctx, hit.addedIn, filter)) continue;
        methods.push(hit);
      }
    }

    if (args.search_in === "all" || args.search_in === "members") {
      for (const member of doc.members ?? []) {
        const name = member.name;
        const compatibility = name
          ? ctx.knowledge.getPythonApiCompatibility(`${summary.className}.${name}`)
          : undefined;
        const hit = memberHit(summary.className, member, compatibility);
        if (!hit || !matchesMember(hit, queryTerms)) continue;
        if (!isAvailableInVersion(ctx, hit.addedIn, filter)) continue;
        members.push(hit);
      }
    }
  }

  return { classes, methods, members, tips: [], warnings: [] };
}

function searchCompatibilityOnly(
  ctx: ToolContext,
  args: SearchPythonApiArgs,
  report: SearchReport,
  filter?: VersionFilter,
) {
  if (args.search_in !== "all" && args.search_in !== "methods" && args.search_in !== "members")
    return;
  const queryTerms = terms(args.query);
  const classSummaries = new Map(
    ctx.knowledge.listPythonClasses().map((entry) => [entry.className, entry]),
  );

  for (const [className, cls] of Object.entries(
    ctx.knowledge.getPythonApiCompatibilityData().classes,
  )) {
    const summary = classSummaries.get(className);
    if (summary && !classMatchesCategory(summary, args.category)) continue;
    if (!isAvailableInVersion(ctx, cls.addedIn, filter)) continue;

    if (args.search_in === "all" || args.search_in === "methods") {
      for (const [name, entry] of Object.entries(cls.methods ?? {})) {
        const hit: PythonMethodHit = {
          className,
          name,
          signature: entry.signature,
          description: entry.description,
          addedIn: entry.addedIn,
        };
        if (!matchesMethod(hit, queryTerms)) continue;
        if (!isAvailableInVersion(ctx, hit.addedIn, filter)) continue;
        report.methods.push(hit);
      }
    }

    if (args.search_in === "all" || args.search_in === "members") {
      for (const [name, entry] of Object.entries(cls.members ?? {})) {
        const hit: PythonMemberHit = {
          className,
          name,
          description: entry.description,
          addedIn: entry.addedIn,
        };
        if (!matchesMember(hit, queryTerms)) continue;
        if (!isAvailableInVersion(ctx, hit.addedIn, filter)) continue;
        report.members.push(hit);
      }
    }
  }
}

function finalizeReport(report: SearchReport, args: SearchPythonApiArgs): SearchReport {
  const classes = sortClassHits(
    dedupeBy(report.classes, (entry) => compactKey(entry.className)),
    args.query,
  ).slice(0, args.limit);
  const methods = dedupeBy(
    sortMethodHits(sortByClassAndName(report.methods), args.query),
    (entry) => `${compactKey(entry.className)}.${compactKey(entry.name)}`,
  ).slice(0, args.limit);
  const members = dedupeBy(
    sortMemberHits(sortByClassAndName(report.members), args.query),
    (entry) => `${compactKey(entry.className)}.${compactKey(entry.name)}`,
  ).slice(0, args.limit);
  const count = classes.length + methods.length + members.length;
  return {
    classes,
    methods,
    members,
    warnings: report.warnings,
    tips:
      count === 0
        ? [
            "Try search_in:'all' or a broader query.",
            "Use get_td_class_details for one exact class, or get_module_help for readable class help.",
          ]
        : [],
  };
}

function versionFilter(ctx: ToolContext, version: string | undefined): VersionFilter | undefined {
  if (!version) return undefined;
  const resolved = ctx.knowledge.getTdVersion(version)?.id;
  return resolved ? { requested: version, resolved } : undefined;
}

function invalidVersionResult(ctx: ToolContext, version: string) {
  return errorResult(`Invalid TouchDesigner version filter "${version}".`, {
    validVersions: ctx.knowledge.listTdVersions().map((entry) => entry.id),
  });
}

export function searchPythonApiImpl(ctx: ToolContext, rawArgs: SearchPythonApiInput) {
  const parsed = searchPythonApiSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult("Invalid search_python_api input.", { issues: parsed.error.issues });
  }

  const args = parsed.data;
  const filter = versionFilter(ctx, args.version);
  if (args.version && !filter) return invalidVersionResult(ctx, args.version);

  const searched = searchDocs(ctx, args, filter);
  searchCompatibilityOnly(ctx, args, searched, filter);
  const report = finalizeReport(searched, args);
  const count = report.classes.length + report.methods.length + report.members.length;
  const result = {
    query: args.query,
    filters: {
      search_in: args.search_in,
      category: args.category,
      version: args.version,
      resolvedVersion: filter?.resolved,
    },
    count,
    classes: report.classes,
    methods: report.methods,
    members: report.members,
    tips: report.tips,
  };

  const text =
    count === 0
      ? `No Python API results found for "${args.query}".`
      : `Found ${count} Python API result(s) for "${args.query}".`;
  return structuredResult(text, result);
}

export const registerSearchPythonApi: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "search_python_api",
    {
      title: "Search TD Python API",
      description:
        "Read-only: search TouchDesigner Python API classes, methods and members from the embedded offline knowledge base. Supports class category filters and conservative stable-version compatibility filtering where compatibility metadata exists.",
      inputSchema: searchPythonApiSchema.shape,
      outputSchema: searchPythonApiOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) => searchPythonApiImpl(ctx, args),
  );
};
