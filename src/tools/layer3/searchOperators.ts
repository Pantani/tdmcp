import { z } from "zod";
import { cosineSimilarity, embedTextsCached } from "../../knowledge/embeddings.js";
import type {
  KnowledgeDataVersion,
  OperatorParameter,
  OperatorSummary,
} from "../../knowledge/types.js";
import { loadConfig } from "../../utils/config.js";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const searchTypeSchema = z.enum(["fuzzy", "exact", "tag"]);

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
  category: z
    .string()
    .optional()
    .describe(
      "Optional operator family/category filter, e.g. TOP, CHOP, SOP, DAT, COMP, MAT, or POP.",
    ),
  subcategory: z
    .string()
    .optional()
    .describe(
      "Optional subcategory filter, e.g. Generators, Filters, Audio, Network, Experimental.",
    ),
  type: searchTypeSchema
    .default("fuzzy")
    .describe(
      "Search mode: fuzzy searches names/summaries/keywords, exact searches only operator names/display names, tag searches tags and keywords.",
    ),
  parameter_search: z
    .boolean()
    .default(false)
    .describe(
      "Also search operator parameter names, labels and descriptions; matching parameters are returned per hit.",
    ),
  version: z
    .string()
    .optional()
    .describe(
      "Optional stable TouchDesigner version filter, e.g. 099, 2019, 2020, 2021, 2022, 2023, or 2024. Operators with compatibility records added after the target version are excluded.",
    ),
});
type SearchOperatorsArgs = z.output<typeof searchOperatorsSchema>;
type SearchOperatorsInput = z.input<typeof searchOperatorsSchema>;

interface MatchedParameter {
  name: string;
  label?: string;
  type?: string;
  description?: string;
  /** Menu options for a Menu/StrMenu parameter (the offline menu catalog). */
  menuItems?: string[];
  menuLabels?: string[];
}

type SearchOperatorHit = OperatorSummary & {
  matchedParameters?: MatchedParameter[];
};

interface ScoredOperatorHit {
  operator: SearchOperatorHit;
  score: number;
}

interface VersionFilter {
  resolved: string;
}

interface SearchReport {
  operators: SearchOperatorHit[];
  total: number;
  facets: {
    categories: Record<string, number>;
    subcategories: Record<string, number>;
  };
  filters: {
    category?: string;
    subcategory?: string;
    version?: string;
    resolvedVersion?: string;
    parameter_search: boolean;
    type: z.infer<typeof searchTypeSchema>;
  };
  tips: string[];
  warnings: string[];
}

function compactKey(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function includesAllTerms(text: string, terms: string[]): boolean {
  return terms.every((term) => text.includes(term));
}

function scoreFuzzyText(text: string, nameText: string, terms: string[]): number {
  let score = 0;
  for (const term of terms) {
    if (text.includes(term)) score += 1;
    if (nameText.includes(term)) score += 1;
  }
  return score;
}

function parameterHaystack(parameter: OperatorParameter): string {
  return [
    parameter.name,
    parameter.label,
    parameter.group,
    parameter.page,
    parameter.type,
    parameter.dataType,
    parameter.description,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

function matchingParameters(
  parameters: OperatorParameter[] | undefined,
  terms: string[],
): MatchedParameter[] {
  if (!parameters || terms.length === 0) return [];
  return parameters
    .filter((parameter) => includesAllTerms(parameterHaystack(parameter), terms))
    .slice(0, 8)
    .map((parameter) => ({
      name: parameter.name,
      label: parameter.label,
      type: parameter.type ?? parameter.dataType,
      description: parameter.description,
      ...(parameter.menuItems?.length ? { menuItems: parameter.menuItems } : {}),
      ...(parameter.menuLabels?.length ? { menuLabels: parameter.menuLabels } : {}),
    }));
}

function tagText(summary: OperatorSummary, ctx: ToolContext): string {
  const doc = ctx.knowledge.getOperator(summary.slug);
  return [...summary.keywords, ...(doc?.keywords ?? []), ...(doc?.tags ?? [])]
    .join(" ")
    .toLowerCase();
}

function summaryText(summary: OperatorSummary): string {
  return `${summary.slug} ${summary.name} ${summary.displayName} ${summary.category} ${summary.subcategory} ${summary.summary} ${summary.keywords.join(" ")}`.toLowerCase();
}

function versionIndex(ctx: ToolContext, version: string | undefined): number {
  if (!version) return -1;
  return ctx.knowledge.listTdVersions().findIndex((entry) => entry.id === version);
}

function buildVersionFilter(
  ctx: ToolContext,
  version: string | undefined,
): VersionFilter | undefined {
  if (!version) return undefined;
  const resolved = ctx.knowledge.getTdVersion(version)?.id;
  return resolved ? { resolved } : undefined;
}

function isCompatibleWithVersion(
  ctx: ToolContext,
  summary: OperatorSummary,
  filter?: VersionFilter,
): boolean {
  if (!filter) return true;
  const targetIndex = versionIndex(ctx, filter.resolved);
  if (targetIndex === -1) return true;
  const compatibility = ctx.knowledge.getOperatorCompatibility(summary.slug);
  if (!compatibility) return true;

  const addedIndex = versionIndex(ctx, compatibility.addedIn);
  if (addedIndex !== -1 && addedIndex > targetIndex) return false;

  const removedIndex = versionIndex(ctx, compatibility.removedIn ?? undefined);
  return removedIndex === -1 || removedIndex > targetIndex;
}

function passesFilters(
  ctx: ToolContext,
  summary: OperatorSummary,
  args: SearchOperatorsArgs,
  filter?: VersionFilter,
) {
  if (args.category && compactKey(summary.category) !== compactKey(args.category)) return false;
  if (args.subcategory && compactKey(summary.subcategory) !== compactKey(args.subcategory))
    return false;
  return isCompatibleWithVersion(ctx, summary, filter);
}

function scoreOperator(
  ctx: ToolContext,
  summary: OperatorSummary,
  args: SearchOperatorsArgs,
  terms: string[],
): ScoredOperatorHit | undefined {
  const q = args.query.trim().toLowerCase();
  const nameText = `${summary.name} ${summary.displayName}`.toLowerCase();
  const operator: SearchOperatorHit = { ...summary };

  if (args.parameter_search) {
    const matchedParameters = matchingParameters(
      ctx.knowledge.getOperator(summary.slug)?.parameters,
      terms,
    );
    if (matchedParameters.length > 0) operator.matchedParameters = matchedParameters;
  }

  if (args.type === "exact") {
    return nameText.includes(q) ? { operator, score: 100 + q.length } : undefined;
  }

  if (args.type === "tag") {
    const tags = tagText(summary, ctx);
    return includesAllTerms(tags, terms) ? { operator, score: 80 + terms.length } : undefined;
  }

  const text = summaryText(summary);
  const paramScore = operator.matchedParameters ? operator.matchedParameters.length * 3 : 0;
  const score = scoreFuzzyText(text, nameText, terms) + paramScore;
  return score > 0 ? { operator, score } : undefined;
}

function buildFacets(operators: SearchOperatorHit[]): SearchReport["facets"] {
  const categories: Record<string, number> = {};
  const subcategories: Record<string, number> = {};
  for (const operator of operators) {
    categories[operator.category] = (categories[operator.category] ?? 0) + 1;
    subcategories[operator.subcategory] = (subcategories[operator.subcategory] ?? 0) + 1;
  }
  return { categories, subcategories };
}

function buildTips(args: SearchOperatorsArgs): string[] {
  const tips = [
    "Try a broader query or remove category/subcategory filters.",
    "Use type:'fuzzy' for conceptual searches, type:'exact' for operator-name searches, or type:'tag' for keyword/tag matches.",
  ];
  if (!args.parameter_search)
    tips.push("Set parameter_search:true to search parameter names and descriptions.");
  if (args.version)
    tips.push(
      "Remove the version filter if you want operators from newer TouchDesigner releases too.",
    );
  return tips;
}

function searchOperators(ctx: ToolContext, args: SearchOperatorsArgs): SearchReport {
  const versionFilter = buildVersionFilter(ctx, args.version);
  const terms = args.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const scored: ScoredOperatorHit[] = [];

  for (const summary of ctx.knowledge.listOperators()) {
    if (!passesFilters(ctx, summary, args, versionFilter)) continue;
    const hit = scoreOperator(ctx, summary, args, terms);
    if (hit) scored.push(hit);
  }

  scored.sort((a, b) => b.score - a.score || a.operator.name.localeCompare(b.operator.name));
  const allOperators = scored.map((hit) => hit.operator);
  return {
    operators: allOperators,
    total: allOperators.length,
    facets: buildFacets(allOperators),
    filters: {
      category: args.category,
      subcategory: args.subcategory,
      version: args.version,
      resolvedVersion: versionFilter?.resolved,
      parameter_search: args.parameter_search,
      type: args.type,
    },
    tips: allOperators.length === 0 ? buildTips(args) : [],
    warnings: [],
  };
}

function modeFor(args: SearchOperatorsArgs): string {
  if (args.type === "exact") return "exact";
  if (args.type === "tag") return "tag";
  return args.semantic ? "semantic" : "keyword";
}

function shouldUseSemantic(args: SearchOperatorsArgs): boolean {
  return args.semantic && args.type === "fuzzy";
}

/** Parses a major version (e.g. 2023) from a TouchDesigner version string. */
function majorOf(version: string | undefined): number | undefined {
  if (!version) return undefined;
  const match = version.match(/\b(20\d{2}|099|99)\b/);
  return match ? Number(match[1]) : undefined;
}

/**
 * A staleness note when the live TD's major differs from the major the offline
 * catalog was generated against — the menu options may have changed. Undefined when
 * either major is unknown or they match.
 */
export function computeStaleHint(
  dataMajor: number | undefined,
  liveTdVersion: string | undefined,
): string | undefined {
  const liveMajor = majorOf(liveTdVersion);
  if (dataMajor === undefined || liveMajor === undefined || dataMajor === liveMajor) {
    return undefined;
  }
  return `The offline knowledge base reflects TouchDesigner ${dataMajor}, but the connected TouchDesigner is ${liveMajor}. Parameter menus may have changed — verify against the live operator with get_td_node_parameters.`;
}

interface MenuMeta {
  data_version?: KnowledgeDataVersion;
  stale_hint?: string;
}

/**
 * Builds the menu-catalog provenance for the response: always the offline
 * `data_version`, plus a `stale_hint` (best-effort, only when the caller asked for
 * parameters) when a reachable live TD is on a different major version.
 */
async function buildMenuMeta(ctx: ToolContext, args: SearchOperatorsArgs): Promise<MenuMeta> {
  const dataVersion = ctx.knowledge.dataVersion();
  if (!dataVersion) return {};
  if (!args.parameter_search) return { data_version: dataVersion };
  try {
    const info = await ctx.client.getInfo();
    const staleHint = computeStaleHint(dataVersion.tdMajor, info.td_version);
    return staleHint
      ? { data_version: dataVersion, stale_hint: staleHint }
      : { data_version: dataVersion };
  } catch {
    return { data_version: dataVersion }; // TD offline — provenance only, no staleness check
  }
}

function resultPayload(
  args: SearchOperatorsArgs,
  report: SearchReport,
  operators: SearchOperatorHit[],
  mode: string,
  menuMeta: MenuMeta = {},
) {
  return {
    query: args.query,
    mode,
    count: operators.length,
    total: report.total,
    filters: report.filters,
    facets: report.facets,
    operators,
    tips: report.tips,
    warnings: report.warnings,
    ...(menuMeta.data_version ? { data_version: menuMeta.data_version } : {}),
    ...(menuMeta.stale_hint ? { stale_hint: menuMeta.stale_hint } : {}),
  };
}

function validateSearchFilters(ctx: ToolContext, args: SearchOperatorsArgs) {
  if (args.category) {
    const validCategories = ctx.knowledge.listOperatorCategories();
    const categoryIsValid = validCategories.some(
      (category) => compactKey(category) === compactKey(args.category),
    );
    if (!categoryIsValid) {
      return errorResult(`Invalid search_operators input: unknown category "${args.category}".`, {
        validCategories,
      });
    }
  }

  if (args.version && !ctx.knowledge.getTdVersion(args.version)) {
    return errorResult(`Invalid TouchDesigner version filter "${args.version}".`, {
      validVersions: ctx.knowledge.listTdVersions().map((version) => version.id),
    });
  }

  return undefined;
}

export async function searchOperatorsImpl(ctx: ToolContext, rawArgs: SearchOperatorsInput) {
  const parsed = searchOperatorsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult("Invalid search_operators input.", { issues: parsed.error.issues });
  }

  const args = parsed.data;
  const validationError = validateSearchFilters(ctx, args);
  if (validationError) return validationError;

  // Keyword search always runs: it's the result in default mode and the candidate pool in
  // semantic mode (recall first, then embedding re-rank for precision).
  const report = searchOperators(ctx, args);
  const menuMeta = await buildMenuMeta(ctx, args);
  const useSemantic = shouldUseSemantic(args);
  const poolSize = useSemantic ? Math.max(args.limit * 4, 40) : args.limit;
  const keyword = report.operators.slice(0, poolSize);
  const baseMode = modeFor(args);

  if (!useSemantic || keyword.length === 0) {
    const operators = keyword.slice(0, args.limit);
    const suffix = report.total === operators.length ? "" : ` (${report.total} total before limit)`;
    const zeroTips =
      operators.length === 0 && report.tips.length > 0 ? ` Try: ${report.tips[0]}` : "";
    return structuredResult(
      `Found ${operators.length} operator(s) matching "${args.query}"${suffix}.${zeroTips}`,
      resultPayload(args, report, operators, baseMode, menuMeta),
    );
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
      resultPayload(args, report, operators, "semantic", menuMeta),
    );
  } catch (err) {
    const operators = keyword.slice(0, args.limit);
    return structuredResult(
      `Found ${operators.length} operator(s) matching "${args.query}" (semantic unavailable: ${String(err).slice(0, 80)}; using keyword ranking).`,
      resultPayload(args, report, operators, "keyword_fallback", menuMeta),
    );
  }
}

export const registerSearchOperators: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "search_operators",
    {
      title: "Search operators",
      description:
        "Search the embedded operator knowledge base (629 operators) by keyword, exact name, tag/keyword, category, subcategory, parameter metadata, or TouchDesigner version compatibility — ranked by relevance, fully offline by default. Use it to discover the right operator before creating nodes instead of guessing a type (e.g. 'what sends DMX?', 'particle', 'corner pin'). Returns name, family, summary, facets and optional matching parameters. Pass semantic:true to re-rank fuzzy candidates by embedding similarity (needs an LLM endpoint; falls back to keyword). With parameter_search, matched Menu parameters include their menu options; results are stamped with a data_version (which TouchDesigner build the offline catalog reflects) and a stale_hint when the connected TD is on a different major. Token economy: use a specific query and a small `limit`; one focused search beats several broad ones.",
      inputSchema: searchOperatorsSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => searchOperatorsImpl(ctx, args),
  );
};
