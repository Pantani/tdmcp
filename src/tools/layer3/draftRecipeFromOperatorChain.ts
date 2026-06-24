import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { OperatorDoc, OperatorSummary } from "../../knowledge/types.js";
import { RecipeSchema } from "../../recipes/schema.js";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const operatorFamilies = ["TOP", "CHOP", "SOP", "DAT", "COMP", "MAT", "POP"] as const;

export const draftRecipeFromOperatorChainSchema = z.object({
  chain: z
    .array(z.string().trim().min(1))
    .min(1)
    .describe(
      "Ordered TouchDesigner operator names, display names, slugs, or optypes, e.g. ['Noise TOP', 'Level TOP', 'Null TOP'].",
    ),
  id: z.string().trim().min(1).optional().describe("Optional recipe id. Generated when omitted."),
  name: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Optional recipe display name. Generated when omitted."),
  description: z
    .string()
    .default("")
    .describe("Optional recipe description. A chain summary is generated when omitted."),
  tags: z.array(z.string().trim().min(1)).default([]).describe("Optional recipe tags."),
  difficulty: z.enum(["beginner", "intermediate", "advanced"]).default("intermediate"),
  td_version_min: z.string().trim().min(1).default("2023"),
  family: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Optional operator family/category constraint, e.g. TOP, CHOP, SOP, DAT."),
  strict: z
    .boolean()
    .default(true)
    .describe("When true, unresolved operators or family mismatches return an isError result."),
});

type DraftRecipeFromOperatorChainInput = z.input<typeof draftRecipeFromOperatorChainSchema>;
type DraftRecipeFromOperatorChainArgs = z.output<typeof draftRecipeFromOperatorChainSchema>;

const operatorSuggestionSchema = z.object({
  slug: z.string(),
  displayName: z.string(),
  category: z.string(),
  summary: z.string().optional(),
});

const chainIssueSchema = z.object({
  code: z.string(),
  message: z.string(),
  index: z.number().int().nonnegative().optional(),
  input: z.string().optional(),
  suggestions: z.array(operatorSuggestionSchema).optional(),
});

const resolvedChainNodeSchema = z.object({
  index: z.number().int().nonnegative(),
  input: z.string(),
  name: z.string(),
  type: z.string(),
  displayName: z.string(),
  category: z.string(),
  subcategory: z.string().optional(),
  summary: z.string().optional(),
});

const connectionReportSchema = z.object({
  from: z.string(),
  to: z.string(),
  fromOutput: z.number().int().nonnegative(),
  toInput: z.number().int().nonnegative(),
  hint: z.string(),
  documented: z.boolean(),
  reason: z.string().optional(),
});

const validationIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
});

export const draftRecipeFromOperatorChainOutputSchema = z.object({
  recipe: RecipeSchema.nullable(),
  validation: z.object({
    valid: z.boolean(),
    issues: z.array(validationIssueSchema),
  }),
  chainReport: z.object({
    valid: z.boolean(),
    strict: z.boolean(),
    family: z.string().optional(),
    requested: z.array(z.string()),
    resolved: z.array(resolvedChainNodeSchema),
    connections: z.array(connectionReportSchema),
    errors: z.array(chainIssueSchema),
    warnings: z.array(chainIssueSchema),
  }),
  valid: z.boolean(),
  nextToolHints: z.array(z.string()),
});

type DraftRecipeFromOperatorChainOutput = z.output<typeof draftRecipeFromOperatorChainOutputSchema>;
type ChainIssue = z.output<typeof chainIssueSchema>;
type ResolvedChainNode = z.output<typeof resolvedChainNodeSchema>;
type ConnectionReport = z.output<typeof connectionReportSchema>;
type ValidationIssue = z.output<typeof validationIssueSchema>;
type OperatorSuggestion = z.output<typeof operatorSuggestionSchema>;

function compactKey(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function operatorSuggestion(summary: OperatorSummary): OperatorSuggestion {
  const suggestion: OperatorSuggestion = {
    slug: summary.slug,
    displayName: summary.displayName,
    category: summary.category,
  };
  if (summary.summary) suggestion.summary = summary.summary;
  return suggestion;
}

function docFamily(doc: OperatorDoc, input: string): string {
  const category = optionalTrimmed(doc.category);
  if (category) return category.toUpperCase();

  const displayText = `${doc.displayName ?? doc.name} ${input}`;
  const wordFamily = displayText.match(/\b(TOP|CHOP|SOP|DAT|COMP|MAT|POP)\b/i)?.[1];
  if (wordFamily) return wordFamily.toUpperCase();

  const inputKey = compactKey(input);
  const suffix = operatorFamilies.find((family) => inputKey.endsWith(family.toLowerCase()));
  return suffix ?? "OP";
}

function baseFromDisplayName(displayName: string, family: string): string {
  const withoutFamily = displayName.replace(new RegExp(`\\s+${family}$`, "i"), "");
  const base = withoutFamily.replace(/[^a-zA-Z0-9]+/g, "").toLowerCase();
  return base || "node";
}

function operatorType(doc: OperatorDoc, input: string): string {
  const family = docFamily(doc, input);
  const displayName = doc.displayName ?? doc.name;
  return `${baseFromDisplayName(displayName, family)}${family}`;
}

function nodeBaseFromType(type: string): string {
  const upperType = type.toUpperCase();
  const family = operatorFamilies.find((candidate) => upperType.endsWith(candidate));
  const rawBase = family ? type.slice(0, -family.length) : type;
  const base = rawBase.replace(/[^a-zA-Z0-9]+/g, "").toLowerCase();
  return base || "node";
}

function nextNodeName(type: string, counts: Map<string, number>): string {
  const base = nodeBaseFromType(type);
  const count = (counts.get(base) ?? 0) + 1;
  counts.set(base, count);
  return `${base}${count}`;
}

function matchesOperatorName(candidate: string, node: ResolvedChainNode): boolean {
  const key = compactKey(candidate);
  return [node.input, node.displayName, node.type].some((value) => compactKey(value) === key);
}

function connectionHint(
  ctx: ToolContext,
  previous: ResolvedChainNode,
  next: ResolvedChainNode,
): Pick<ConnectionReport, "hint" | "documented" | "reason"> {
  const outputGuide = ctx.knowledge.getOperatorConnections(previous.input);
  const outputMatch = outputGuide?.outputs.find((entry) => matchesOperatorName(entry.op, next));
  if (outputMatch) {
    const report: Pick<ConnectionReport, "hint" | "documented" | "reason"> = {
      hint: outputMatch.port ?? "output 0 -> input 0",
      documented: true,
    };
    if (outputMatch.reason) report.reason = outputMatch.reason;
    return report;
  }

  const inputGuide = ctx.knowledge.getOperatorConnections(next.input);
  const inputMatch = inputGuide?.inputs.find((entry) => matchesOperatorName(entry.op, previous));
  if (inputMatch) {
    const report: Pick<ConnectionReport, "hint" | "documented" | "reason"> = {
      hint: inputMatch.port ?? "output 0 -> input 0",
      documented: true,
    };
    if (inputMatch.reason) report.reason = inputMatch.reason;
    return report;
  }

  return { hint: "output 0 -> input 0", documented: false };
}

function resolveChain(
  ctx: ToolContext,
  args: DraftRecipeFromOperatorChainArgs,
): {
  resolved: ResolvedChainNode[];
  connections: ConnectionReport[];
  errors: ChainIssue[];
  warnings: ChainIssue[];
} {
  const resolved: ResolvedChainNode[] = [];
  const errors: ChainIssue[] = [];
  const warnings: ChainIssue[] = [];
  const counts = new Map<string, number>();
  const requestedFamily = optionalTrimmed(args.family);

  args.chain.forEach((input, index) => {
    const doc = ctx.knowledge.getOperator(input);
    if (!doc) {
      const suggestions = ctx.knowledge.searchOperators(input, 5).map(operatorSuggestion);
      const issue: ChainIssue = {
        code: "missing_operator",
        message: `Operator "${input}" could not be resolved from the offline knowledge base.`,
        index,
        input,
      };
      if (suggestions.length > 0) issue.suggestions = suggestions;
      errors.push(issue);
      return;
    }

    const category = docFamily(doc, input);
    const type = operatorType(doc, input);
    const node: ResolvedChainNode = {
      index,
      input,
      name: nextNodeName(type, counts),
      type,
      displayName: doc.displayName ?? doc.name,
      category,
    };
    if (doc.subcategory) node.subcategory = doc.subcategory;
    if (doc.summary ?? doc.description) node.summary = doc.summary ?? doc.description;
    resolved.push(node);

    if (requestedFamily && compactKey(category) !== compactKey(requestedFamily)) {
      errors.push({
        code: "family_mismatch",
        message: `Operator "${node.displayName}" is ${category}, not requested family ${requestedFamily}.`,
        index,
        input,
      });
    }
  });

  const connections: ConnectionReport[] = [];
  for (let index = 1; index < resolved.length; index += 1) {
    const previous = resolved[index - 1];
    const next = resolved[index];
    if (!previous || !next) continue;
    if (next.index !== previous.index + 1) continue;

    const hint = connectionHint(ctx, previous, next);
    const report: ConnectionReport = {
      from: previous.name,
      to: next.name,
      fromOutput: 0,
      toInput: 0,
      hint: hint.hint,
      documented: hint.documented,
    };
    if (hint.reason) report.reason = hint.reason;
    connections.push(report);

    if (!hint.documented) {
      warnings.push({
        code: "undocumented_connection",
        message: `No documented connection hint from "${previous.displayName}" to "${next.displayName}"; using output 0 -> input 0.`,
        index,
        input: next.input,
      });
    }
  }

  return { resolved, connections, errors, warnings };
}

function defaultRecipeId(resolved: ResolvedChainNode[]): string {
  const parts = resolved.map((node) => nodeBaseFromType(node.type)).filter(Boolean);
  return `draft_${parts.join("_") || "operator_chain"}`;
}

function defaultRecipeName(resolved: ResolvedChainNode[]): string {
  const labels = resolved.map((node) => node.displayName);
  return `Draft ${labels.join(" -> ") || "Operator Chain"}`;
}

function defaultDescription(resolved: ResolvedChainNode[]): string {
  const labels = resolved.map((node) => node.displayName);
  return `Draft recipe from operator chain: ${labels.join(" -> ")}.`;
}

function recipeCandidate(args: DraftRecipeFromOperatorChainArgs, resolved: ResolvedChainNode[]) {
  const tags = [...new Set([...args.tags, "draft", "operator-chain"])];
  return {
    id: args.id ?? defaultRecipeId(resolved),
    name: args.name ?? defaultRecipeName(resolved),
    description: optionalTrimmed(args.description) ?? defaultDescription(resolved),
    tags,
    difficulty: args.difficulty,
    td_version_min: args.td_version_min,
    nodes: resolved.map((node) => ({
      name: node.name,
      type: node.type,
      parameters: {},
      comment: `Drafted from ${node.displayName}.`,
    })),
    connections: resolved.slice(1).flatMap((node, index) => {
      const previous = resolved[index];
      if (!previous || node.index !== previous.index + 1) return [];
      return [
        {
          from: previous.name,
          to: node.name,
          from_output: 0,
          to_input: 0,
        },
      ];
    }),
    parameters: [],
    glsl_uniforms: [],
    controls: [],
    preview_description: defaultDescription(resolved),
  };
}

function validationIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)",
    message: issue.message,
  }));
}

function nextToolHints(valid: boolean): string[] {
  const hints = ["search_operators", "get_operator_workflow_guide"];
  if (valid) {
    hints.push("apply_recipe", "save_recipe_to_vault");
  } else {
    hints.push("suggest_operator_chain");
  }
  return hints;
}

function structuredError(
  summary: string,
  data: DraftRecipeFromOperatorChainOutput,
): CallToolResult {
  return {
    isError: true,
    content: [
      { type: "text", text: `${summary}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`` },
    ],
    structuredContent: data as { [key: string]: unknown },
  };
}

export function draftRecipeFromOperatorChainImpl(
  ctx: ToolContext,
  rawArgs: DraftRecipeFromOperatorChainInput,
): CallToolResult {
  const parsed = draftRecipeFromOperatorChainSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult("Invalid draft_recipe_from_operator_chain input.", {
      issues: parsed.error.issues,
    });
  }

  const args = parsed.data;
  try {
    const chain = resolveChain(ctx, args);
    const chainValid = chain.errors.length === 0;
    const shouldDraft = chain.resolved.length > 0 && (!args.strict || chainValid);
    const recipeParse = shouldDraft
      ? RecipeSchema.safeParse(recipeCandidate(args, chain.resolved))
      : undefined;
    const recipe = recipeParse?.success ? recipeParse.data : null;
    const schemaIssues =
      recipeParse && !recipeParse.success ? validationIssues(recipeParse.error) : [];
    const validation = {
      valid: Boolean(recipeParse?.success),
      issues: schemaIssues,
    };
    const valid = chainValid && validation.valid;
    const output: DraftRecipeFromOperatorChainOutput = {
      recipe,
      validation,
      chainReport: {
        valid: chainValid,
        strict: args.strict,
        requested: args.chain,
        resolved: chain.resolved,
        connections: chain.connections,
        errors: chain.errors,
        warnings: chain.warnings,
      },
      valid,
      nextToolHints: nextToolHints(valid),
    };
    if (args.family) output.chainReport.family = args.family;

    if (args.strict && !valid) {
      return structuredError("Cannot draft recipe from invalid operator chain.", output);
    }

    const summary = valid
      ? `Drafted RecipeSchema-valid recipe "${output.recipe?.id}" from ${chain.resolved.length} operators.`
      : "Drafted a non-strict operator-chain report with validation issues.";
    return structuredResult(summary, output);
  } catch (err) {
    return errorResult("Failed to draft recipe from operator chain.", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export const registerDraftRecipeFromOperatorChain: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "draft_recipe_from_operator_chain",
    {
      title: "Draft recipe from operator chain",
      description:
        "Read-only: convert an ordered TouchDesigner operator chain into a RecipeSchema draft without writing files or touching the TD bridge.",
      inputSchema: draftRecipeFromOperatorChainSchema.shape,
      outputSchema: draftRecipeFromOperatorChainOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) => draftRecipeFromOperatorChainImpl(ctx, args),
  );
};
