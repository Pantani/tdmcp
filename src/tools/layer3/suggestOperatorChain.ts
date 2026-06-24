import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { OperatorDoc, OperatorSummary, Pattern } from "../../knowledge/types.js";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const suggestOperatorChainSchema = z.object({
  goal: z.string().min(1).describe("Creative or technical goal for the operator chain."),
  family: z
    .string()
    .optional()
    .describe("Optional operator family/category preference, e.g. TOP, CHOP, SOP, DAT."),
  seed_operator: z
    .string()
    .optional()
    .describe("Optional starting operator name, display name, or slug."),
  max_steps: z.coerce
    .number()
    .int()
    .positive()
    .max(10)
    .default(5)
    .describe("Maximum number of operators to return in the suggested chain."),
});
type SuggestOperatorChainInput = z.input<typeof suggestOperatorChainSchema>;
type SuggestOperatorChainArgs = z.output<typeof suggestOperatorChainSchema>;

const chainStepSchema = z.object({
  operator: z.string(),
  role: z.string(),
  reason: z.string().optional(),
  connectionHint: z.string().optional(),
  category: z.string().optional(),
  subcategory: z.string().optional(),
});

const sourceMatchSchema = z.object({
  surface: z.string(),
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
});

export const suggestOperatorChainOutputSchema = z.object({
  goal: z.string(),
  family: z.string().optional(),
  seedOperator: z.string().optional(),
  chain: z.array(chainStepSchema),
  sourceMatches: z.array(sourceMatchSchema),
  nextToolHints: z.array(z.string()),
  warnings: z.array(z.string()),
});

type ChainStep = z.output<typeof chainStepSchema>;
type SourceMatch = z.output<typeof sourceMatchSchema>;

function compactKey(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function terms(value: string): string[] {
  return value.toLowerCase().split(/\s+/).filter(Boolean);
}

function textScore(text: string, searchTerms: string[]): number {
  const lower = text.toLowerCase();
  return searchTerms.reduce((score, term) => score + (lower.includes(term) ? 1 : 0), 0);
}

function familyMatches(doc: OperatorDoc | undefined, family: string | undefined): boolean {
  if (!family || !doc?.category) return true;
  return compactKey(doc.category) === compactKey(family);
}

function operatorRole(doc: OperatorDoc | undefined, index: number): string {
  if (!doc) return index === 0 ? "Candidate starting operator" : "Candidate downstream operator";
  const parts = [doc.category, doc.subcategory].filter(Boolean);
  if (parts.length === 0) return index === 0 ? "Starting operator" : "Downstream operator";
  return `${parts.join(" ")} ${index === 0 ? "source" : "stage"}`;
}

function connectionFromPrevious(
  ctx: ToolContext,
  previous: string | undefined,
  operator: string,
): { connectionHint?: string; reason?: string } {
  if (!previous) return {};
  const guide = ctx.knowledge.getOperatorConnections(previous);
  const match = guide?.outputs.find((entry) => compactKey(entry.op) === compactKey(operator));
  return {
    connectionHint: match?.port ?? "output 0 -> input 0",
    reason: match?.reason,
  };
}

function chainStep(
  ctx: ToolContext,
  operator: string,
  index: number,
  previous?: string,
): ChainStep {
  const doc = ctx.knowledge.getOperator(operator);
  const connection = connectionFromPrevious(ctx, previous, operator);
  return {
    operator: doc?.displayName ?? doc?.name ?? operator,
    role: operatorRole(doc, index),
    reason: connection.reason,
    connectionHint: connection.connectionHint,
    category: doc?.category,
    subcategory: doc?.subcategory,
  };
}

function patternScore(pattern: Pattern, goal: string, family: string | undefined): number {
  const searchTerms = terms(goal);
  const workflow = Array.isArray(pattern.workflow) ? pattern.workflow.join(" ") : "";
  let score = textScore(
    `${pattern.id} ${pattern.name} ${pattern.description ?? ""} ${pattern.use_case ?? ""} ${workflow}`,
    searchTerms,
  );
  if (family && pattern.category && compactKey(pattern.category) === compactKey(family)) score += 2;
  return score;
}

function bestPattern(ctx: ToolContext, args: SuggestOperatorChainArgs): Pattern | undefined {
  const scored = ctx.knowledge
    .listPatterns()
    .map((summary) => ctx.knowledge.getPattern(summary.id))
    .filter((pattern): pattern is Pattern => Boolean(pattern?.workflow?.length))
    .map((pattern) => ({ pattern, score: patternScore(pattern, args.goal, args.family) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.pattern;
}

function seedChain(ctx: ToolContext, seed: string, maxSteps: number): string[] {
  const chain = [seed];
  let current = seed;
  while (chain.length < maxSteps) {
    const next = ctx.knowledge
      .suggestNextOperators(current, 5)
      .find(
        (suggestion) =>
          !chain.some((operator) => compactKey(operator) === compactKey(suggestion.operator)),
      );
    if (!next) break;
    chain.push(next.operator);
    current = next.operator;
  }
  return chain;
}

function searchFallbackCandidates(ctx: ToolContext, args: SuggestOperatorChainArgs) {
  return ctx.knowledge
    .searchOperators(args.goal, args.max_steps * 2)
    .filter((operator) => {
      if (!args.family) return true;
      return compactKey(operator.category) === compactKey(args.family);
    })
    .slice(0, args.max_steps);
}

function sourceForPattern(pattern: Pattern): SourceMatch {
  return {
    surface: "operator_workflow",
    id: pattern.id,
    name: pattern.name,
    description: pattern.description,
  };
}

function sourceForSeed(doc: OperatorDoc, input: string): SourceMatch {
  return {
    surface: "operator_seed",
    id: doc.id ?? input,
    name: doc.displayName ?? doc.name,
    description: doc.summary ?? doc.description,
  };
}

function sourceForSearch(operator: OperatorSummary): SourceMatch {
  return {
    surface: "operator_search",
    id: operator.slug,
    name: operator.displayName,
    description: operator.summary,
  };
}

function chainFromNames(ctx: ToolContext, names: string[], maxSteps: number): ChainStep[] {
  return names.slice(0, maxSteps).map((operator, index, chain) => {
    const previous = index > 0 ? chain[index - 1] : undefined;
    return chainStep(ctx, operator, index, previous);
  });
}

function toolHints(chain: ChainStep[]): string[] {
  const hints = [
    "search_operators",
    "get_operator_workflow_guide",
    "create_td_node",
    "connect_nodes",
  ];
  if (chain.length > 1) hints.push("apply_recipe");
  return hints;
}

export function suggestOperatorChainImpl(
  ctx: ToolContext,
  rawArgs: SuggestOperatorChainInput,
): CallToolResult {
  const parsed = suggestOperatorChainSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult("Invalid suggest_operator_chain input.", { issues: parsed.error.issues });
  }

  const args = parsed.data;
  try {
    const warnings: string[] = [];
    let chainNames: string[] = [];
    let sourceMatches: SourceMatch[] = [];

    if (args.seed_operator) {
      const seedDoc = ctx.knowledge.getOperator(args.seed_operator);
      if (!seedDoc) {
        return errorResult("Seed operator not found for suggest_operator_chain.", {
          seedOperator: args.seed_operator,
          suggestions: ctx.knowledge.searchOperators(args.seed_operator, 5),
        });
      }
      if (!familyMatches(seedDoc, args.family)) {
        warnings.push(
          `Seed operator ${seedDoc.displayName ?? seedDoc.name} is ${seedDoc.category}, not requested family ${args.family}.`,
        );
      }
      chainNames = seedChain(ctx, seedDoc.displayName ?? seedDoc.name, args.max_steps);
      sourceMatches = [sourceForSeed(seedDoc, args.seed_operator)];
    } else {
      const pattern = bestPattern(ctx, args);
      if (pattern?.workflow?.length) {
        chainNames = pattern.workflow;
        sourceMatches = [sourceForPattern(pattern)];
      } else {
        const candidates = searchFallbackCandidates(ctx, args);
        chainNames = candidates.map((operator) => operator.displayName);
        sourceMatches = candidates.map(sourceForSearch);
      }
    }

    const chain = chainFromNames(ctx, chainNames, args.max_steps);
    if (chain.length === 0) {
      warnings.push("No operator chain could be inferred from the offline knowledge base.");
    }

    return structuredResult(`Suggested ${chain.length}-step operator chain for "${args.goal}".`, {
      goal: args.goal,
      family: args.family,
      seedOperator: args.seed_operator,
      chain,
      sourceMatches,
      nextToolHints: toolHints(chain),
      warnings,
    });
  } catch (err) {
    return errorResult("Failed to suggest operator chain.", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export const registerSuggestOperatorChain: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "suggest_operator_chain",
    {
      title: "Suggest operator chain",
      description:
        "Read-only: suggest a small ordered TouchDesigner operator chain for a creative or technical goal from offline operator docs and workflow patterns. Returns connection hints and next tool hints; it does not create nodes.",
      inputSchema: suggestOperatorChainSchema.shape,
      outputSchema: suggestOperatorChainOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) => suggestOperatorChainImpl(ctx, args),
  );
};
